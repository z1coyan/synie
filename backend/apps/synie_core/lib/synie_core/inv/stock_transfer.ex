defmodule SynieCore.Inv.StockTransferStatus do
  @moduledoc "调拨单状态:草稿/已发货/已收货。"

  use Ash.Type.Enum, values: [draft: "草稿", shipped: "已发货", received: "已收货"]

  def graphql_type(_), do: :inv_stock_transfer_status
end

defmodule SynieCore.Inv.StockTransferDraft do
  @moduledoc "校验调拨单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿调拨单可修改或删除"}
    end
  end
end

defmodule SynieCore.Inv.StockTransferWarehousesDistinct do
  @moduledoc "校验调拨单三仓两两不同:调出/调入/在途不能是同一仓。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    ids =
      Enum.map(
        [:from_warehouse_id, :to_warehouse_id, :transit_warehouse_id],
        &Ash.Changeset.get_attribute(changeset, &1)
      )

    # nil 由 allow_nil? false 兜底报必填
    if Enum.any?(ids, &is_nil/1) or length(Enum.uniq(ids)) == 3 do
      :ok
    else
      {:error, field: :transit_warehouse_id, message: "调出、调入与在途仓库必须两两不同"}
    end
  end
end

defmodule SynieCore.Inv.StockTransfer do
  @moduledoc """
  调拨单(头),对应 `inv_stock_transfer` 表。同公司三仓(调出/调入/在途)间的库存
  移动,一单两动作走在途(ADR 2026-07-19-stock-ledger):发货写「调出仓负+在途仓正」,
  收货按行实收写「在途仓负+调入仓正」,分录如实反映在途停留;实收小于发货的差额
  留在在途仓,由手工出入库单(出库)清理。

  生命周期:草稿(可改可删)→ 已发货(ship)→ 已收货(receive,终态)。已发货不可改
  不可删、无作废(路上有货不能当单据不存在,纠错走反向调拨);仅草稿可删。

  三仓限本公司叶子仓且两两不同(见 WarehouseUsable/StockTransferWarehousesDistinct);
  仓停用「拦新不拦旧」:保存与发货校验启用,收货不校验(在途必须能收尾)。
  摘要带入库存分录 remarks;行见 `StockTransferItem`,删除草稿时行由 DB 级联删除。
  单据编号全局唯一:留空按 `inv.stock_transfer` 编号规则自动取号(AutoNumber),手填原样保留。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "inv_stock_transfer"
    repo SynieCore.Repo
  end

  graphql do
    type :inv_stock_transfer
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "inv.stock_transfer"
  def permission_actions, do: ~w(create read update delete ship receive)

  def grid_actions do
    [
      %{
        key: "ship",
        label: "发货",
        scope: "row",
        mutation: "shipInvStockTransfer",
        is_danger: false
      },
      %{
        key: "receive",
        label: "收货",
        scope: "row",
        mutation: "receiveInvStockTransfer",
        is_danger: false
      }
    ]
  end

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    create :create do
      accept [
        :company_id,
        :doc_no,
        :from_warehouse_id,
        :to_warehouse_id,
        :transit_warehouse_id,
        :doc_date,
        :summary,
        :remarks
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :from_warehouse_id}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :to_warehouse_id}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :transit_warehouse_id}
      validate {SynieCore.Inv.StockTransferWarehousesDistinct, []}

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :doc_no}

      # 录入人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end
    end

    update :update do
      # 不接受 company_id:单据公司创建后不可换(同手工出入库单先例)
      accept [
        :doc_no,
        :from_warehouse_id,
        :to_warehouse_id,
        :transit_warehouse_id,
        :doc_date,
        :summary,
        :remarks
      ]

      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Inv.StockTransferDraft, []}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :from_warehouse_id}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :to_warehouse_id}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :transit_warehouse_id}
      validate {SynieCore.Inv.StockTransferWarehousesDistinct, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发发货后头字段被改"竞态
          case __MODULE__.lock_doc(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿调拨单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Inv.StockTransferDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发发货后单据被删、行成孤儿"竞态
          case __MODULE__.lock_doc(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿调拨单可修改或删除")
          end
        end)
      end
    end

    update :ship do
      accept []
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿调拨单可发货"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "发货前必须至少填写一行单据行"}
        end
      end

      validate {SynieCore.Inv.WarehouseUsable, attribute: :from_warehouse_id}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :to_warehouse_id}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :transit_warehouse_id}

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :shipped)
        |> Ash.Changeset.force_change_attribute(:shipped_at, DateTime.utc_now())
        |> then(fn cs ->
          case context.actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :shipped_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:before_action 在动作事务内执行,FOR UPDATE 持锁到事务提交,
          # 借此串行化发货与行编辑/并发发货;锁内复检状态/行数/三仓启用后派生分录
          # (同事务,负库存校验与 (仓,物料) 咨询锁在 Inv.Stock.post! 内)
          case __MODULE__.lock_doc(cs.data.id) do
            {:ok, %{status: :draft} = doc} ->
              if __MODULE__.has_items?(doc.id) do
                case __MODULE__.check_warehouses_usable(doc) do
                  :ok -> __MODULE__.post_ship_entries(cs, doc)
                  {:error, msg} -> Ash.Changeset.add_error(cs, message: msg)
                end
              else
                Ash.Changeset.add_error(cs, message: "发货前必须至少填写一行单据行")
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿调拨单可发货")
          end
        end)
      end
    end

    update :receive do
      accept []
      require_atomic? false

      # 收货按行确认实收:缺省(不传)= 全部行按发货数量(折算口径)足额收;
      # 传了则必须覆盖全部行,每行 0 ≤ qty ≤ base_qty(见 resolve_receipts/2)
      argument :receipts, {:array, :map}

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :shipped,
          do: :ok,
          else: {:error, message: "仅已发货调拨单可收货"}
      end

      validate fn changeset, _context ->
        case __MODULE__.resolve_receipts(
               changeset.data.id,
               Ash.Changeset.get_argument(changeset, :receipts)
             ) do
          {:ok, _resolved} -> :ok
          {:error, msg} -> {:error, message: msg}
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :received)
        |> Ash.Changeset.force_change_attribute(:received_at, DateTime.utc_now())
        |> then(fn cs ->
          case context.actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :received_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读;锁内复检状态后按实收派生分录并回写行
          # received_qty。仓停用不拦(「拦新不拦旧」,在途必须能收尾);
          # 在途仓余额不足等过账校验在 Inv.Stock.post! 内
          case __MODULE__.lock_doc(cs.data.id) do
            {:ok, %{status: :shipped} = doc} ->
              with {:ok, resolved} <-
                     __MODULE__.resolve_receipts(
                       doc.id,
                       Ash.Changeset.get_argument(cs, :receipts)
                     ),
                   :ok <- __MODULE__.post_receive_entries(doc, resolved),
                   :ok <- write_received_quantities(resolved) do
                cs
              else
                {:error, msg} -> Ash.Changeset.add_error(cs, message: msg)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅已发货调拨单可收货")
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :doc_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "单据编号"
    end

    attribute :doc_date, :date do
      allow_nil? false
      public? true
      default &Date.utc_today/0
      description "业务日期"
    end

    attribute :summary, :string do
      public? true
      constraints max_length: 512
      description "摘要(带入库存分录)"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "备注(对内)"
    end

    attribute :status, SynieCore.Inv.StockTransferStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
    end

    attribute :shipped_at, :utc_datetime_usec do
      writable? false
      public? true
      description "发货时间"
    end

    attribute :received_at, :utc_datetime_usec do
      writable? false
      public? true
      description "收货时间"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :from_warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "调出仓库(限本公司叶子仓)"
    end

    belongs_to :to_warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "调入仓库(限本公司叶子仓)"
    end

    belongs_to :transit_warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "在途仓库(限本公司叶子仓)"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end

    belongs_to :shipped_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "发货人"
    end

    belongs_to :received_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "收货人"
    end

    has_many :items, SynieCore.Inv.StockTransferItem do
      destination_attribute :stock_transfer_id
      sort idx: :asc
      public? true
      description "单据行"
    end
  end

  identities do
    identity :unique_doc_no, [:doc_no], message: "单据编号已存在"
  end

  @doc false
  # 单据粒度锁:FOR UPDATE 锁住单头行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化行编辑/发货/收货
  def lock_doc(doc_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^doc_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 发货门槛:单据至少一行
  def has_items?(doc_id) do
    SynieCore.Inv.StockTransferItem
    |> Ash.Query.filter(stock_transfer_id == ^doc_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  # 三仓启用复检(发货锁内):存在、同公司、叶子、启用;仓停用「拦新不拦旧」,收货不走此
  def check_warehouses_usable(doc) do
    [doc.from_warehouse_id, doc.to_warehouse_id, doc.transit_warehouse_id]
    |> Enum.reduce_while(:ok, fn warehouse_id, :ok ->
      case SynieCore.Inv.WarehouseUsable.check(warehouse_id, doc.company_id) do
        :ok -> {:cont, :ok}
        {:error, msg} -> {:halt, {:error, msg}}
      end
    end)
  end

  @doc false
  # 发货派生分录:逐行「调出仓负+在途仓正」;摘要带入分录 remarks。
  # 过账校验失败(负库存等)转成 changeset 错误,用户可见
  def post_ship_entries(changeset, doc) do
    entries =
      doc.id
      |> load_items()
      |> Enum.flat_map(fn item ->
        [
          %{
            warehouse_id: doc.from_warehouse_id,
            material_id: item.material_id,
            quantity: Decimal.negate(item.base_qty),
            remarks: doc.summary
          },
          %{
            warehouse_id: doc.transit_warehouse_id,
            material_id: item.material_id,
            quantity: item.base_qty,
            remarks: doc.summary
          }
        ]
      end)

    case post_entries(doc, entries) do
      :ok -> changeset
      {:error, msg} -> Ash.Changeset.add_error(changeset, message: msg)
    end
  end

  @doc false
  # 收货派生分录:实收为正的行写「在途仓负+调入仓正」;全部行实收为零则不写分录
  # (整单留在在途仓)。返回 :ok | {:error, 消息}(负库存等过账校验失败)
  def post_receive_entries(doc, resolved) do
    entries =
      resolved
      |> Enum.reject(fn {_item, qty} -> Decimal.compare(qty, 0) == :eq end)
      |> Enum.flat_map(fn {item, qty} ->
        [
          %{
            warehouse_id: doc.transit_warehouse_id,
            material_id: item.material_id,
            quantity: Decimal.negate(qty),
            remarks: doc.summary
          },
          %{
            warehouse_id: doc.to_warehouse_id,
            material_id: item.material_id,
            quantity: qty,
            remarks: doc.summary
          }
        ]
      end)

    if entries == [], do: :ok, else: post_entries(doc, entries)
  end

  @doc false
  # 收货参数解析:receipts 缺省(nil)= 全部行按 base_qty 足额收;传了则必须覆盖
  # 全部行(缺行/非本单行报错),每行 0 ≤ qty ≤ base_qty(超界报错含行号)。
  # 返回 {:ok, [{item, qty}]}(按行号升序),派生分录与回写 received_qty 共用。
  # 已发货后行即冻结,构建期预检与锁内复检结果一致。
  def resolve_receipts(doc_id, nil) do
    {:ok, doc_id |> load_items() |> Enum.map(&{&1, &1.base_qty})}
  end

  def resolve_receipts(doc_id, receipts) do
    items = load_items(doc_id)

    given =
      Map.new(receipts, fn r ->
        {to_string(r["item_id"] || r[:item_id]), r["qty"] || r[:qty]}
      end)

    unknown = Map.keys(given) -- Enum.map(items, & &1.id)

    if unknown != [] do
      {:error, "实收行不属于本调拨单"}
    else
      Enum.reduce_while(items, {:ok, []}, fn item, {:ok, acc} ->
        case Map.fetch(given, item.id) do
          :error ->
            {:halt, {:error, "收货数量必须覆盖全部行:第 #{item.idx} 行缺实收数量"}}

          {:ok, raw} ->
            qty = to_decimal(raw)

            if is_nil(qty) or Decimal.compare(qty, 0) == :lt or
                 Decimal.compare(qty, item.base_qty) == :gt do
              {:halt, {:error, "第 #{item.idx} 行实收数量必须在 0 与发货数量 #{fmt(item.base_qty)} 之间"}}
            else
              {:cont, {:ok, acc ++ [{item, qty}]}}
            end
        end
      end)
    end
  end

  # 收货回写行实收数量(含实收为零的行,收货即确认该行颗粒未收)
  defp write_received_quantities(resolved) do
    Enum.each(resolved, fn {item, qty} ->
      item
      |> Ash.Changeset.for_update(:write_received, %{received_qty: qty})
      |> Ash.update!(authorize?: false)
    end)

    :ok
  end

  defp post_entries(doc, entries) do
    SynieCore.Inv.Stock.post!(
      %{
        voucher_type: "inv.stock_transfer",
        voucher_id: doc.id,
        voucher_no: doc.doc_no,
        company_id: doc.company_id,
        posting_date: doc.doc_date
      },
      entries
    )

    :ok
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  defp load_items(doc_id) do
    SynieCore.Inv.StockTransferItem
    |> Ash.Query.filter(stock_transfer_id == ^doc_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  # receipts 的 qty 来自 GraphQL json(数字或字符串),非法值按超界同一文案报错
  defp to_decimal(value) do
    Decimal.new(value)
  rescue
    _ -> nil
  end

  defp fmt(value), do: Decimal.to_string(value, :normal)
end
