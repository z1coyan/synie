defmodule SynieCore.Sales.OrderItem.SyncOrder do
  @moduledoc """
  行与父订单同步:订单必须存在且草稿态(增删改行的前提);
  create 时把订单 company_id 冗余到行(数据权限按公司过滤依赖此列)。

  构建期预检仅为友好报错(此时在动作事务之外,加锁不生效,故用普通读);
  create 时顺带回填 company_id——CompanyAccessible 的声明顺序依赖它,必须在构建期完成。
  权威复检在 before_action 钩子内进行:before_action 在动作事务内执行,FOR UPDATE
  持锁到事务提交,借此串行化行编辑与审核/关闭/作废,关闭构建期预检看到 stale 状态的竞态窗口。
  (同 GlJournalLine.SyncJournal 先例)
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    order_id = changeset_order_id(changeset)

    changeset =
      case read_order(order_id) do
        {:ok, %{status: :draft} = order} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, order.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :order_id, message: "订单不存在")

        {:ok, _order} ->
          Ash.Changeset.add_error(changeset, field: :order_id, message: "仅草稿订单可编辑条目")

        _ ->
          Ash.Changeset.add_error(changeset, field: :order_id, message: "订单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_order(changeset_order_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :order_id, message: "订单不存在")

        _ ->
          Ash.Changeset.add_error(cs, field: :order_id, message: "仅草稿订单可编辑条目")
      end
    end)
  end

  defp changeset_order_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :order_id) || changeset.data.order_id

  defp read_order(nil), do: {:ok, nil}

  defp read_order(order_id) do
    SynieCore.Sales.Order
    |> Ash.Query.filter(id == ^order_id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_order(nil), do: {:ok, nil}

  defp lock_order(order_id) do
    SynieCore.Sales.Order
    |> Ash.Query.filter(id == ^order_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Sales.OrderItem.MaterialUnitAllowed do
  @moduledoc """
  校验行单位:必须是物料默认单位或该物料单位转换行里的单位——
  任何取值都能折算回默认单位,将来发货扣库存不会卡在无法换算的行上。
  物料不存在在此一并报出(友好报错,DB 外键兜底)。
  """

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    material_id = Ash.Changeset.get_attribute(changeset, :material_id)
    unit_id = Ash.Changeset.get_attribute(changeset, :unit_id)

    # nil 由 allow_nil? false 兜底报必填
    if is_nil(material_id) or is_nil(unit_id) do
      :ok
    else
      case Ash.get(SynieCore.Inv.Material, material_id, authorize?: false) do
        {:ok, %{default_unit_id: ^unit_id}} ->
          :ok

        {:ok, _material} ->
          if conversion_exists?(material_id, unit_id) do
            :ok
          else
            {:error, field: :unit_id, message: "单位必须是物料默认单位或其单位转换单位"}
          end

        {:error, _} ->
          {:error, field: :material_id, message: "物料不存在"}
      end
    end
  end

  defp conversion_exists?(material_id, unit_id) do
    SynieCore.Inv.MaterialUnit
    |> Ash.Query.filter(material_id == ^material_id and unit_id == ^unit_id)
    |> Ash.exists?(authorize?: false)
  end
end

defmodule SynieCore.Sales.OrderItem.ComputeAmount do
  @moduledoc "含税金额系统算:数量 × 含税单价,保留两位小数;不允许手改(属性 writable? false 兜底)。"

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    qty = Ash.Changeset.get_attribute(changeset, :qty)
    price = Ash.Changeset.get_attribute(changeset, :price)

    if is_nil(qty) or is_nil(price) do
      changeset
    else
      amount = qty |> Decimal.mult(price) |> Decimal.round(2)
      Ash.Changeset.force_change_attribute(changeset, :amount, amount)
    end
  end
end

defmodule SynieCore.Sales.OrderItem do
  @moduledoc """
  销售订单条目,对应 `sal_order_item` 表。

  `company_id` 冗余自父订单以复用公司数据权限;含税金额保存时按 数量×含税单价
  计算(两位小数)不可手改;行单位限物料默认单位或其转换单位;仅父订单草稿态可增删改。
  v1 不拆未税金额/税额(将来开票对接时按 含税÷(1+税率) 拆)。
  无独立权限点:permission_actions 为空(不进权限目录),动作复用 `sales.order` 权限码。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    # 主 read 上的兜底排序(idx 升序)是有意为之,行按录入顺序展示依赖此序
    primary_read_warning?: false

  postgres do
    table "sal_order_item"
    repo SynieCore.Repo

    references do
      # 删草稿订单 DB 级联删行(行不留单独审计,订单删除本身已审计)
      reference :order, on_delete: :delete
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"
      check_constraint :price, "price_nonnegative", check: "price >= 0", message: "含税单价不能为负"

      check_constraint :tax_rate, "tax_rate_range",
        check: "tax_rate >= 0 AND tax_rate < 1",
        message: "税率必须在 0(含)与 1 之间"
    end
  end

  graphql do
    type :sal_order_item
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

  # 复用订单权限码;actions 为空不进权限目录(同 GlJournalLine 跟随 acc.gl_journal 的先例)
  def permission_prefix, do: "sales.order"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      prepare build(sort: [idx: :asc])
    end

    create :create do
      accept [:order_id, :idx, :material_id, :unit_id, :qty, :price, :tax_rate, :remarks]

      # 顺序敏感:先回填 company_id,再做公司授权校验
      change {SynieCore.Sales.OrderItem.SyncOrder, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Sales.OrderItem.MaterialUnitAllowed, []}
      change {SynieCore.Sales.OrderItem.ComputeAmount, []}
    end

    update :update do
      accept [:idx, :material_id, :unit_id, :qty, :price, :tax_rate, :remarks]
      require_atomic? false

      change {SynieCore.Sales.OrderItem.SyncOrder, []}
      validate {SynieCore.Sales.OrderItem.MaterialUnitAllowed, []}
      change {SynieCore.Sales.OrderItem.ComputeAmount, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Sales.OrderItem.SyncOrder, []}
    end
  end

  validations do
    validate compare(:qty, greater_than: 0), message: "数量必须大于零"
    validate compare(:price, greater_than_or_equal_to: 0), message: "含税单价不能为负"

    validate compare(:tax_rate, greater_than_or_equal_to: 0, less_than: 1),
      message: "税率必须在 0(含)与 1 之间"
  end

  attributes do
    uuid_primary_key :id

    attribute :idx, :integer do
      allow_nil? false
      public? true
      description "行号"
    end

    attribute :qty, :decimal do
      allow_nil? false
      public? true
      description "数量"
    end

    attribute :price, :decimal do
      allow_nil? false
      public? true
      description "含税单价"
    end

    attribute :amount, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "含税金额(系统算:数量×含税单价)"
    end

    attribute :tax_rate, :decimal do
      allow_nil? false
      default Decimal.new("0.13")
      public? true
      description "税率(小数,如 0.13)"
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
    belongs_to :order, SynieCore.Sales.Order do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "订单"
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
      description "物料"
    end

    belongs_to :unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "单位"
    end
  end
end
