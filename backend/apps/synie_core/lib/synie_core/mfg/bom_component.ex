defmodule SynieCore.Mfg.BomComponent do
  @moduledoc """
  BOM 配料行,对应 `mfg_bom_component` 表。一行 = 子物料+单位+单位净用量
  (每 1 默认单位母物料的净消耗,6 位小数惯例)+可空损耗率
  (理论耗用=净用量×(1+损耗率),空即无损耗);平铺清单,不记录投料工序。

  子物料不能是 BOM 物料自身;单位限该物料默认单位或其单位转换单位
  (同销/采条目行单位约束,复用 `Sales.MaterialUnitAllowed`)。

  行是独立资源,前端做 diff 持久化,不走 manage_relationship。行维护视为 BOM
  维护的一部分,不设独立权限点:读跟随 mfg.bom:read,增删改跟随 mfg.bom:update
  (建 BOM 顺手录行也允许 mfg.bom:create),同物料单位转换先例。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "mfg_bom_component"
    repo SynieCore.Repo

    references do
      # 配料行是纯从属条目,随 BOM 删除级联清理(同物料单位转换先例)
      reference :bom, on_delete: :delete
    end
  end

  graphql do
    type :mfg_bom_component
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action(:read) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy action(:create) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    policy action(:update) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end

    policy action(:destroy) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end
  end

  def permission_prefix, do: "mfg.bom"
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
      accept [:bom_id, :material_id, :unit_id, :quantity, :loss_rate, :note]

      validate {SynieCore.Mfg.BomLineNotSelfMaterial, []}
      validate {SynieCore.Sales.MaterialUnitAllowed, []}
    end

    update :update do
      accept [:material_id, :unit_id, :quantity, :loss_rate, :note]
      require_atomic? false

      validate {SynieCore.Mfg.BomLineNotSelfMaterial, []}
      validate {SynieCore.Sales.MaterialUnitAllowed, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  validations do
    validate compare(:quantity, greater_than: 0), message: "单位净用量必须大于 0"
    validate compare(:loss_rate, greater_than_or_equal_to: 0), message: "损耗率不能为负"
  end

  attributes do
    uuid_primary_key :id

    attribute :quantity, :decimal do
      allow_nil? false
      public? true
      description "单位净用量(每 1 默认单位母物料)"
    end

    attribute :loss_rate, :decimal do
      public? true
      description "损耗率(空即无损耗)"
    end

    attribute :note, :string do
      public? true
      constraints max_length: 255
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :bom, SynieCore.Mfg.Bom do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "BOM"
    end

    belongs_to :material, SynieCore.Inv.Material do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "子物料"
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
