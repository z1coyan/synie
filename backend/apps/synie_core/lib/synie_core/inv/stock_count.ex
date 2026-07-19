defmodule SynieCore.Inv.StockCountStatus do
  @moduledoc "库存盘点单状态:草稿/已审核/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", cancelled: "已作废"]

  def graphql_type(_), do: :inv_stock_count_status
end

defmodule SynieCore.Inv.StockCountDraft do
  @moduledoc "校验库存盘点单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿库存盘点单可修改或删除"}
    end
  end
end

defmodule SynieCore.Inv.StockCount do
  @moduledoc """
  库存盘点单(头),对应 `inv_stock_count` 表。核对账实并校正库存的来源单据,
  单头一仓、行即本次要盘的物料清单;允许部分盘点——未列入的物料不受影响,
  盘点单只对其列出的行负责(ADR 2026-07-19-stock-count)。

  生命周期:草稿(可改可删)→ 已审核(approve,按「实盘折算 − 账面快照」差异
  派生库存分录,盘盈正、盘亏负,零差异行不落分录)→ 已作废(cancel,分录标记
  作废;撤销盘盈会减库存,负库存校验在 `Inv.Stock.cancel!` 内)。仅草稿可改可删,
  无反审核、无关闭态(审核即履行完毕)。

  账面数量是显式快照、不做冻结:创建/整仓带出/刷新账面数时取数(行存取数时刻
  余额,头存 `snapshot_taken_at`),刷新保留已填实盘数。审核兜底校验替代冻结:
  取快照后该仓库存分录有新增(按 inserted_at)或作废(按 cancelled_at,业务日期
  在过去的补录单照样命中)则整单拒,提示先刷新账面数——校验通过时审核时点余额
  恒等于快照、调整后恒等于实盘(≥0),差异分录永不致负。

  整仓带出(create 传 load_all: true)按该仓当前账面余额非零的物料生成行
  (口径:未作废分录合计,同余额视图默认隐藏零行),账面零的物料手工加行
  (实物有账面无的盘盈场景)。

  单据编号全局唯一:留空按 `inv.stock_count` 编号规则自动取号(AutoNumber),手填原样
  保留。头仓限本公司叶子仓且启用(保存时校验,见 WarehouseUsable);摘要带入库存分录
  remarks。行见 `StockCountItem`,删除草稿时行由 DB 级联删除(行不留单独审计,
  单据删除本身已审计)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "inv_stock_count"
    repo SynieCore.Repo
  end

  graphql do
    type :inv_stock_count
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 刷新账面数是编辑能力的衍生:复用 update 码,不设独立权限点(同 hr.payroll refresh 先例)
    policy action(:refresh) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "inv.stock_count"
  def permission_actions, do: ~w(create read update delete approve cancel)

  def grid_actions do
    [
      %{
        key: "approve",
        label: "审核",
        scope: "row",
        mutation: "approveInvStockCount",
        is_danger: false
      },
      %{
        key: "cancel",
        label: "作废",
        scope: "row",
        mutation: "cancelInvStockCount",
        is_danger: true
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
      accept [:company_id, :doc_no, :warehouse_id, :posting_date, :summary, :remarks]

      # 建行两方式:items 随单建行(行字段照 StockCountItem create);load_all 整仓带出
      argument :items, {:array, :map}
      argument :load_all, :boolean, allow_nil?: false, default: false

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Inv.WarehouseUsable, []}

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

      # 账面快照时点:创建即写(整仓带出/行保存的账面取数都以此为界,审核兜底校验用)
      change fn changeset, _context ->
        Ash.Changeset.force_change_attribute(changeset, :snapshot_taken_at, DateTime.utc_now())
      end

      change fn changeset, _context ->
        Ash.Changeset.after_action(changeset, fn _cs, count ->
          # 母单落库后同事务建行(行各项校验/快照/账面取数走 StockCountItem create);
          # 任一行失败整体回滚
          with :ok <- __MODULE__.create_items(changeset, count),
               :ok <- __MODULE__.maybe_load_all_items(changeset, count) do
            {:ok, count}
          end
        end)
      end
    end

    update :update do
      # 不接受 company_id:单据公司创建后不可换(同仓库先例)
      accept [:doc_no, :warehouse_id, :posting_date, :summary, :remarks]
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Inv.StockCountDraft, []}
      validate {SynieCore.Inv.WarehouseUsable, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后头字段被改"竞态
          case __MODULE__.lock_count(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿库存盘点单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Inv.StockCountDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后单据被删、行成孤儿"竞态
          case __MODULE__.lock_count(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿库存盘点单可修改或删除")
          end
        end)
      end
    end

    # 刷新账面数:按最新余额重取全部行 book_quantity,已填实盘数保留(仅草稿)
    update :refresh do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :draft,
          do: :ok,
          else: {:error, message: "仅草稿库存盘点单可刷新账面数"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:snapshot_taken_at, DateTime.utc_now())
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读;锁内重取快照,与行编辑/审核串行化
          case __MODULE__.lock_count(cs.data.id) do
            {:ok, %{status: :draft}} -> __MODULE__.refresh_book_quantities(cs)
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿库存盘点单可刷新账面数")
          end
        end)
      end
    end

    update :approve do
      accept []
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft,
          do: :ok,
          else: {:error, message: "仅草稿库存盘点单可审核"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "审核前必须至少填写一行单据行"}
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :audited)
        |> Ash.Changeset.force_change_attribute(:audited_at, DateTime.utc_now())
        |> then(fn cs ->
          case context.actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :audited_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:before_action 在动作事务内执行,FOR UPDATE 持锁到事务提交,
          # 借此串行化审核与行编辑/并发审核(同仓并发盘点不设硬约束:先到者落差异,
          # 后到者被兜底校验拦下、刷新即收敛);锁内复检后派生库存分录(同事务)。
          # 注意用锁定记录取数:调用方可能持有 refresh 前的陈旧结构体
          case __MODULE__.lock_count(cs.data.id) do
            {:ok, %{status: :draft} = locked} ->
              cond do
                not __MODULE__.has_items?(cs.data.id) ->
                  Ash.Changeset.add_error(cs, message: "审核前必须至少填写一行单据行")

                __MODULE__.counted_missing?(cs.data.id) ->
                  Ash.Changeset.add_error(cs,
                    message: "存在未填实盘数量的单据行,请补数或删行后再审核"
                  )

                __MODULE__.snapshot_stale?(locked) ->
                  Ash.Changeset.add_error(cs,
                    message: "取快照后该仓库存分录有新增或作废,请先刷新账面数再审核"
                  )

                true ->
                  __MODULE__.post_entries(cs, locked)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿库存盘点单可审核")
          end
        end)
      end
    end

    update :cancel do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited,
          do: :ok,
          else: {:error, message: "仅已审核库存盘点单可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :cancelled)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读;锁内复检后作废分录(同事务,
          # 撤销盘盈会减库存,负库存校验在 Inv.Stock.cancel! 内)
          case __MODULE__.lock_count(cs.data.id) do
            {:ok, %{status: :audited}} -> __MODULE__.cancel_entries(cs)
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核库存盘点单可作废")
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

    attribute :posting_date, :date do
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

    attribute :status, SynieCore.Inv.StockCountStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
    end

    attribute :audited_at, :utc_datetime_usec do
      writable? false
      public? true
      description "审核时间"
    end

    # 账面快照时点:创建/整仓带出/刷新账面数时写当前时间;审核兜底校验以其为界
    attribute :snapshot_taken_at, :utc_datetime_usec do
      allow_nil? false
      writable? false
      public? true
      description "账面快照时间"
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

    belongs_to :warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "仓库(限本公司叶子仓)"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end

    belongs_to :audited_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "审核人"
    end

    has_many :items, SynieCore.Inv.StockCountItem do
      destination_attribute :count_id
      public? true
      description "盘点行"
    end
  end

  identities do
    identity :unique_doc_no, [:doc_no], message: "单据编号已存在"
  end

  @doc false
  # 单据粒度锁:FOR UPDATE 锁住单头行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化行编辑/审核/作废/刷新
  def lock_count(count_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^count_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 审核门槛:单据至少一行
  def has_items?(count_id) do
    SynieCore.Inv.StockCountItem
    |> Ash.Query.filter(count_id == ^count_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  # 审核门槛:逐行实盘数已填且 >= 0,空行整单拒(不做静默跳过,补数或删行)
  def counted_missing?(count_id) do
    SynieCore.Inv.StockCountItem
    |> Ash.Query.filter(
      count_id == ^count_id and (is_nil(counted_quantity) or counted_quantity < 0)
    )
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  # 兜底校验(替代冻结):取快照后该仓库存分录有新增(按 inserted_at)或作废
  # (按 cancelled_at——业务日期在过去的补录单照样命中)则快照已过时,须刷新重取
  def snapshot_stale?(doc) do
    SynieCore.Inv.StockEntry
    |> Ash.Query.filter(
      warehouse_id == ^doc.warehouse_id and
        (inserted_at > ^doc.snapshot_taken_at or cancelled_at > ^doc.snapshot_taken_at)
    )
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  # 审核派生分录:差异 = 实盘折算 − 账面快照,非零行一条(盘盈正、盘亏负),零行不落;
  # 摘要带入分录 remarks。过账校验失败转成 changeset 错误,用户可见
  def post_entries(changeset, doc) do
    entries =
      SynieCore.Inv.StockCountItem
      |> Ash.Query.filter(count_id == ^doc.id)
      |> Ash.read!(authorize?: false)
      |> Enum.map(fn item ->
        %{
          warehouse_id: doc.warehouse_id,
          material_id: item.material_id,
          quantity: Decimal.sub(item.converted_counted, item.book_quantity),
          remarks: doc.summary
        }
      end)
      |> Enum.reject(&(Decimal.compare(&1.quantity, 0) == :eq))

    # 全零差异不落分录(Stock.post! 要求分录不少于一行,空组直接跳过)
    if entries != [] do
      SynieCore.Inv.Stock.post!(
        %{
          voucher_type: "inv.stock_count",
          voucher_id: doc.id,
          voucher_no: doc.doc_no,
          company_id: doc.company_id,
          posting_date: doc.posting_date
        },
        entries
      )
    end

    changeset
  rescue
    e in ArgumentError -> Ash.Changeset.add_error(changeset, message: Exception.message(e))
  end

  @doc false
  # 作废分录:标记 is_cancelled;撤销盘盈会减库存,致负被拒转成 changeset 错误
  def cancel_entries(changeset) do
    SynieCore.Inv.Stock.cancel!("inv.stock_count", changeset.data.id)
    changeset
  rescue
    e in ArgumentError -> Ash.Changeset.add_error(changeset, message: Exception.message(e))
  end

  @doc false
  # 随单建行:create 的 items 参数逐项走 StockCountItem create(单位/折算/快照/账面取数都在行动作内)
  def create_items(changeset, count) do
    changeset
    |> Ash.Changeset.get_argument(:items)
    |> List.wrap()
    |> Enum.reduce_while(:ok, fn input, :ok ->
      case SynieCore.Inv.StockCountItem
           |> Ash.Changeset.for_create(:create, Map.put(input, :count_id, count.id))
           |> Ash.create(authorize?: false) do
        {:ok, _item} -> {:cont, :ok}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  @doc false
  # 整仓带出:create 传 load_all 时按非零余额生成行
  def maybe_load_all_items(changeset, count) do
    if Ash.Changeset.get_argument(changeset, :load_all) do
      load_all_items(count)
    else
      :ok
    end
  end

  @doc false
  # 整仓带出:该仓当前账面余额非零的物料一行一条(口径:未作废分录合计,
  # 同余额视图默认隐藏零行);行单位取物料默认单位,账面数由行的 BookQty 落行
  def load_all_items(count) do
    balances =
      SynieCore.Inv.StockEntry
      |> Ash.Query.filter(warehouse_id == ^count.warehouse_id and is_cancelled == false)
      |> Ash.read!(authorize?: false)
      |> Enum.group_by(& &1.material_id, & &1.quantity)
      |> Map.new(fn {material_id, quantities} ->
        {material_id,
         quantities |> Enum.reduce(Decimal.new(0), &Decimal.add/2) |> Decimal.round(6)}
      end)
      |> Map.filter(fn {_material_id, qty} -> Decimal.compare(qty, 0) != :eq end)

    SynieCore.Inv.Material
    |> Ash.Query.filter(id in ^Map.keys(balances))
    |> Ash.Query.sort(code: :asc)
    |> Ash.read!(authorize?: false)
    |> Enum.reduce_while(:ok, fn material, :ok ->
      case SynieCore.Inv.StockCountItem
           |> Ash.Changeset.for_create(:create, %{
             count_id: count.id,
             material_id: material.id,
             unit_id: material.default_unit_id
           })
           |> Ash.create(authorize?: false) do
        {:ok, _item} -> {:cont, :ok}
        {:error, error} -> {:halt, {:error, error}}
      end
    end)
  end

  @doc false
  # 刷新账面数:按最新余额重取全部行 book_quantity(行的内部动作只写快照列,
  # 不动已填实盘数);snapshot_taken_at 由动作上的 change 一并更新
  def refresh_book_quantities(changeset) do
    doc = changeset.data

    SynieCore.Inv.StockCountItem
    |> Ash.Query.filter(count_id == ^doc.id)
    |> Ash.read!(authorize?: false)
    |> Enum.each(fn item ->
      item
      |> Ash.Changeset.for_update(:sync_book_quantity, %{
        book_quantity: book_quantity(doc.warehouse_id, item.material_id)
      })
      |> Ash.update!(authorize?: false)
    end)

    changeset
  end

  @doc false
  # 当前账面余额(未作废分录合计,物料默认单位口径),6 位小数;行的 BookQty 共用
  def book_quantity(warehouse_id, material_id) do
    SynieCore.Inv.StockEntry
    |> Ash.Query.filter(
      warehouse_id == ^warehouse_id and material_id == ^material_id and is_cancelled == false
    )
    |> Ash.read!(authorize?: false)
    |> Enum.reduce(Decimal.new(0), &Decimal.add(&1.quantity, &2))
    |> Decimal.round(6)
  end
end
