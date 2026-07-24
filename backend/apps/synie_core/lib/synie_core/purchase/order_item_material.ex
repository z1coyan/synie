defmodule SynieCore.Purchase.OrderItemMaterial.SyncOrderItem do
  @moduledoc """
  子表行与父条目/订单同步(发料清单/副产物清单两资源共用,口径同 OrderItem.SyncOrder):
  父条目必须存在且父订单处于草稿态(增删改清单行的前提);
  create 时把条目 company_id 冗余到行(数据权限按公司过滤依赖此列)。

  构建期预检仅为友好报错(此时在动作事务之外,加锁不生效,故用普通读);
  权威复检在 before_action 钩子内进行:before_action 在动作事务内执行,FOR UPDATE
  锁住父订单持锁到事务提交,借此串行化清单行编辑与审核/关闭/作废。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    order_item_id = changeset_order_item_id(changeset)

    changeset =
      case read_order(order_item_id) do
        {:ok, %{status: :draft, company_id: company_id}} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :order_item_id, message: "条目不存在")

        {:ok, _order} ->
          Ash.Changeset.add_error(changeset, field: :order_item_id, message: "仅草稿订单可编辑条目")

        _ ->
          Ash.Changeset.add_error(changeset, field: :order_item_id, message: "条目不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_order(changeset_order_item_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :order_item_id, message: "条目不存在")

        _ ->
          Ash.Changeset.add_error(cs, field: :order_item_id, message: "仅草稿订单可编辑条目")
      end
    end)
  end

  defp changeset_order_item_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :order_item_id) || changeset.data.order_item_id

  defp read_order(nil), do: {:ok, nil}

  defp read_order(order_item_id) do
    case Ash.get(SynieCore.Purchase.OrderItem, order_item_id, authorize?: false) do
      {:ok, %{order_id: order_id}} ->
        SynieCore.Purchase.Order
        |> Ash.Query.filter(id == ^order_id)
        |> Ash.read_one(authorize?: false)

      _ ->
        {:ok, nil}
    end
  end

  defp lock_order(nil), do: {:ok, nil}

  defp lock_order(order_item_id) do
    case Ash.get(SynieCore.Purchase.OrderItem, order_item_id, authorize?: false) do
      {:ok, %{order_id: order_id}} ->
        SynieCore.Purchase.Order
        |> Ash.Query.filter(id == ^order_id)
        |> Ash.Query.lock("FOR UPDATE")
        |> Ash.read_one(authorize?: false)

      _ ->
        {:ok, nil}
    end
  end
end

defmodule SynieCore.Purchase.OrderItemMaterial do
  @moduledoc """
  委外发料清单行,对应 `pur_order_item_material` 表:委外订单条目下「需发给协作方的材料」
  子表(材料+单位+数量+行备注),随条目级联删除(DB reference on_delete: :delete)。

  可由条目成品 BOM 按 理论耗用=净用量×(1+损耗率,空按 0)×条目数量 代入
  (折算口径见 `Mfg.BomComponent` 的 `apply_qty` calculation);代入是快照复制——
  代入后与 BOM 脱钩可自由增删改,改条目数量不自动重算,BOM 后续变更不回溯。

  `issued_qty` 是**已发料量**受控投影列(材料默认单位口径,初始 0,`writable? false`
  只能由内部动作写入):委外发料单审核加/作废减(投影更新逻辑随委外发料单一并落地),
  超发不硬拦、超额仅展示。

  `company_id` 冗余自父条目以复用公司数据权限;单位限物料默认单位或其转换单位
  (复用 `Sales.MaterialUnitAllowed`);仅父订单草稿态可增删改(SyncOrderItem)。
  行维护视为条目编辑的一部分:复用 `purchase.order` 权限码,不进权限目录(同 OrderItem 先例)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "pur_order_item_material"
    repo SynieCore.Repo

    references do
      # 清单行是纯从属条目,随订单条目级联清理(同 BOM 配料行先例)
      reference :order_item, on_delete: :delete
    end

    check_constraints do
      check_constraint :quantity, "quantity_positive",
        check: "quantity > 0",
        message: "数量必须大于零"

      check_constraint :issued_qty, "issued_qty_nonnegative",
        check: "issued_qty >= 0",
        message: "已发料量不能为负"
    end
  end

  graphql do
    type :pur_order_item_material
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

  # 复用订单权限码;actions 为空不进权限目录(同 OrderItem 跟随 purchase.order 的先例)
  def permission_prefix, do: "purchase.order"
  def permission_actions, do: []

  # 取行弹窗(委外发料单)跨单列表用的头字段/剩余量计算列(见 grid_meta 计算列 opt-in)
  def grid_calculations,
    do: [:order_no, :order_status, :order_is_outsourced, :party_type, :party_id, :remaining_issue_qty]

  # party_id 是 calculation(经 order_item.order 取),声明给 GridMeta 反射成多态 fk 列
  def poly_refs do
    %{
      party_id: %{
        discriminator: :party_type,
        variants: Map.take(SynieCore.Acc.PartyType.party_resources(), [:supplier, :company])
      }
    }
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
      accept [:order_item_id, :material_id, :unit_id, :quantity, :remarks]

      # 顺序敏感:先回填 company_id(并预检父订单草稿),再做公司授权校验
      change {SynieCore.Purchase.OrderItemMaterial.SyncOrderItem, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Sales.MaterialUnitAllowed, []}
    end

    update :update do
      accept [:material_id, :unit_id, :quantity, :remarks]
      require_atomic? false

      change {SynieCore.Purchase.OrderItemMaterial.SyncOrderItem, []}
      validate {SynieCore.Sales.MaterialUnitAllowed, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Purchase.OrderItemMaterial.SyncOrderItem, []}
    end

    # 内部动作:委外发料单审核加/作废减已发料量(材料默认单位)。
    # 调用方须已 FOR UPDATE 锁住本行;不注册 GraphQL。
    update :adjust_issued_qty do
      accept []
      require_atomic? false
      argument :delta, :decimal, allow_nil?: false

      change fn changeset, _context ->
        delta = Ash.Changeset.get_argument(changeset, :delta)
        current = changeset.data.issued_qty || Decimal.new(0)
        next = Decimal.add(current, delta)

        if Decimal.compare(next, 0) == :lt do
          Ash.Changeset.add_error(changeset, field: :issued_qty, message: "已发料量不能为负")
        else
          Ash.Changeset.force_change_attribute(changeset, :issued_qty, next)
        end
      end
    end
  end

  validations do
    validate compare(:quantity, greater_than: 0), message: "数量必须大于零"
  end

  attributes do
    uuid_primary_key :id

    attribute :quantity, :decimal do
      allow_nil? false
      public? true
      description "数量"
    end

    # 已发料量投影(材料默认单位口径):委外发料审核加/作废减,初始 0,不可手改
    attribute :issued_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "已发料量(材料默认单位,系统维护)"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "行备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :order_item, SynieCore.Purchase.OrderItem do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "订单条目"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :material, SynieCore.Inv.Material do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "材料"
    end

    belongs_to :unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "单位"
    end
  end

  calculations do
    calculate :order_no, :string, expr(order_item.order.order_no) do
      public? true
      description "订单号"
    end

    calculate :order_status, SynieCore.Purchase.OrderStatus, expr(order_item.order.status) do
      public? true
      description "订单状态"
    end

    calculate :order_is_outsourced, :boolean, expr(order_item.order.is_outsourced) do
      public? true
      description "委外订单"
    end

    calculate :party_type, SynieCore.Acc.PartyType, expr(order_item.order.party_type) do
      public? true
      description "对手类型(供应商/内部公司)"
    end

    calculate :party_id, :uuid, expr(order_item.order.party_id) do
      public? true
      description "对手"
    end

    # 剩余可发 = 清单数量 − 已发料量(超发不硬拦,可为负仅展示;取行过滤 > 0)
    calculate :remaining_issue_qty, :decimal, expr(quantity - issued_qty) do
      public? true
      description "剩余可发料量(材料默认单位)"
    end
  end
end
