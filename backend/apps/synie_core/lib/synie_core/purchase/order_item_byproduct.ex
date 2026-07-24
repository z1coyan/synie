defmodule SynieCore.Purchase.OrderItemByproduct do
  @moduledoc """
  委外副产物清单行,对应 `pur_order_item_byproduct` 表:委外订单条目下「预期随成品
  一起回来的副产物」子表(材料+单位+数量+行备注),随条目级联删除
  (DB reference on_delete: :delete);是委外入库副产物入库行的带出来源。

  可由条目成品 BOM 按 单位产出量×条目数量 代入(折算口径见 `Mfg.BomByproduct`
  的 `apply_qty` calculation);代入是快照复制——代入后与 BOM 脱钩可自由增删改,
  改条目数量不自动重算,BOM 后续变更不回溯。

  `company_id` 冗余自父条目以复用公司数据权限;单位限物料默认单位或其转换单位
  (复用 `Sales.MaterialUnitAllowed`);仅父订单草稿态可增删改
  (复用 `OrderItemMaterial.SyncOrderItem`)。行维护视为条目编辑的一部分:
  复用 `purchase.order` 权限码,不进权限目录(同 OrderItem 先例)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "pur_order_item_byproduct"
    repo SynieCore.Repo

    references do
      # 清单行是纯从属条目,随订单条目级联清理(同 BOM 副产品行先例)
      reference :order_item, on_delete: :delete
    end

    check_constraints do
      check_constraint :quantity, "quantity_positive",
        check: "quantity > 0",
        message: "数量必须大于零"
    end
  end

  graphql do
    type :pur_order_item_byproduct
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
end
