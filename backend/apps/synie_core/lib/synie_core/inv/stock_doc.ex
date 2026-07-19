defmodule SynieCore.Inv.StockDocDirection do
  @moduledoc "手工出入库单方向:入库/出库。"

  use Ash.Type.Enum, values: [in: "入库", out: "出库"]

  def graphql_type(_), do: :inv_stock_doc_direction
end

defmodule SynieCore.Inv.StockDocStatus do
  @moduledoc "手工出入库单状态:草稿/已审核/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]

  def graphql_type(_), do: :inv_stock_doc_status
end

defmodule SynieCore.Inv.StockDocDraft do
  @moduledoc "校验手工出入库单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿手工出入库单可修改或删除"}
    end
  end
end

defmodule SynieCore.Inv.StockDocDirectionLocked do
  @moduledoc "出入库方向锁死:新建时必选,后续不可变更(改向=重开一张单)。仅挂 update 动作。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if Ash.Changeset.get_attribute(changeset, :direction) != changeset.data.direction do
      {:error, field: :direction, message: "出入库方向不可变更"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Inv.StockDoc do
  @moduledoc """
  手工出入库单(头),对应 `inv_stock_doc` 表。仓管无上游单据直接录入的库存来源单据,
  入库/出库合一,由 `direction` 区分(创建后锁死,改向=重开一张单);期初建账也走它,
  不开专用通道。

  生命周期:草稿(可改可删)→ 已审核(audit,按行派生库存分录,入库数量为正、出库为负)→
  已作废(void,分录标记作废;作废会致负同样拒绝,负库存校验在 `Inv.Stock.cancel!`
  内)。仅草稿可改可删,无反审核、无关闭态(审核即履行完毕)。出库审核按 (仓×物料)
  校验负库存,任一不过整单拒(见 `Inv.Stock.post!`)。

  单据编号全局唯一:留空按 `inv.stock_doc` 编号规则自动取号(AutoNumber),手填原样保留。
  头仓限本公司叶子仓且启用(保存时校验,见 WarehouseUsable);摘要带入库存分录 remarks。
  行见 `StockDocItem`,删除草稿时行由 DB 级联删除(行不留单独审计,单据删除本身已审计)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "inv_stock_doc"
    repo SynieCore.Repo
  end

  graphql do
    type :inv_stock_doc
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

  def permission_prefix, do: "inv.stock_doc"
  def permission_actions, do: ~w(create read update delete audit void)

  def grid_actions do
    [
      %{key: "audit", label: "审核", scope: "row", mutation: "auditInvStockDoc", is_danger: false},
      %{key: "void", label: "作废", scope: "row", mutation: "voidInvStockDoc", is_danger: true}
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
      accept [:company_id, :doc_no, :direction, :warehouse_id, :doc_date, :summary, :remarks]

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
    end

    update :update do
      # 不接受 company_id:单据公司创建后不可换(同仓库先例)
      accept [:doc_no, :direction, :warehouse_id, :doc_date, :summary, :remarks]
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Inv.StockDocDraft, []}
      # 方向创建后锁死(改向=重开一张单),同订单 OrderTypeLocked 先例
      validate {SynieCore.Inv.StockDocDirectionLocked, []}
      validate {SynieCore.Inv.WarehouseUsable, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后头字段被改"竞态
          case __MODULE__.lock_doc(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿手工出入库单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Inv.StockDocDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后单据被删、行成孤儿"竞态
          case __MODULE__.lock_doc(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿手工出入库单可修改或删除")
          end
        end)
      end
    end

    update :audit do
      accept []
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft,
          do: :ok,
          else: {:error, message: "仅草稿手工出入库单可审核"}
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
          # 借此串行化审核与行编辑/并发审核;锁内复检后派生库存分录(同事务,
          # 负库存校验与 (仓,物料) 咨询锁在 Inv.Stock.post! 内)
          case __MODULE__.lock_doc(cs.data.id) do
            {:ok, %{status: :draft}} ->
              if __MODULE__.has_items?(cs.data.id) do
                __MODULE__.post_entries(cs)
              else
                Ash.Changeset.add_error(cs, message: "审核前必须至少填写一行单据行")
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿手工出入库单可审核")
          end
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited,
          do: :ok,
          else: {:error, message: "仅已审核手工出入库单可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读;锁内复检后作废分录(同事务,
          # 作废入库单会减库存,负库存校验在 Inv.Stock.cancel! 内)
          case __MODULE__.lock_doc(cs.data.id) do
            {:ok, %{status: :audited}} -> __MODULE__.cancel_entries(cs)
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核手工出入库单可作废")
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

    # 出入库方向:建后锁死(StockDocDirectionLocked),审核派生分录数量符号由它定(入正出负)
    attribute :direction, SynieCore.Inv.StockDocDirection do
      allow_nil? false
      public? true
      description "出入库方向"
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

    attribute :status, SynieCore.Inv.StockDocStatus do
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

    has_many :items, SynieCore.Inv.StockDocItem do
      destination_attribute :stock_doc_id
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
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化行编辑/审核/作废
  def lock_doc(doc_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^doc_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 审核门槛:单据至少一行
  def has_items?(doc_id) do
    SynieCore.Inv.StockDocItem
    |> Ash.Query.filter(stock_doc_id == ^doc_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  # 审核派生分录:按行一行一条,入库数量为正、出库为负;摘要带入分录 remarks。
  # 过账校验失败(负库存等)转成 changeset 错误,用户可见
  def post_entries(changeset) do
    doc = changeset.data

    SynieCore.Inv.Stock.post!(
      %{
        voucher_type: "inv.stock_doc",
        voucher_id: doc.id,
        voucher_no: doc.doc_no,
        company_id: doc.company_id,
        posting_date: doc.doc_date
      },
      load_entries(doc)
    )

    changeset
  rescue
    e in ArgumentError -> Ash.Changeset.add_error(changeset, message: Exception.message(e))
  end

  @doc false
  # 作废分录:标记 is_cancelled;作废入库单会减库存,致负被拒转成 changeset 错误
  def cancel_entries(changeset) do
    SynieCore.Inv.Stock.cancel!("inv.stock_doc", changeset.data.id)
    changeset
  rescue
    e in ArgumentError -> Ash.Changeset.add_error(changeset, message: Exception.message(e))
  end

  defp load_entries(doc) do
    SynieCore.Inv.StockDocItem
    |> Ash.Query.filter(stock_doc_id == ^doc.id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
    |> Enum.map(
      &%{
        warehouse_id: doc.warehouse_id,
        material_id: &1.material_id,
        quantity: signed_qty(doc.direction, &1.base_qty),
        remarks: doc.summary
      }
    )
  end

  # 分录数量符号:入库为正、出库为负(出库负库存校验在 Inv.Stock.post! 内)
  defp signed_qty(:in, base_qty), do: base_qty
  defp signed_qty(:out, base_qty), do: Decimal.negate(base_qty)
end
