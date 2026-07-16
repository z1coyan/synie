defmodule SynieCore.Inv.MaterialUnitNotDefault do
  @moduledoc "校验转换单位:不能与物料默认单位相同(自己换自己无意义)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    material_id = Ash.Changeset.get_attribute(changeset, :material_id)
    unit_id = Ash.Changeset.get_attribute(changeset, :unit_id)

    if is_nil(material_id) or is_nil(unit_id) do
      :ok
    else
      case Ash.get(SynieCore.Inv.Material, material_id, authorize?: false) do
        {:ok, %{default_unit_id: ^unit_id}} ->
          {:error, field: :unit_id, message: "转换单位不能与默认单位相同"}

        _ ->
          :ok
      end
    end
  end
end

defmodule SynieCore.Inv.MaterialUnit do
  @moduledoc """
  物料单位转换,对应 `inv_material_unit` 表。一行 = 「1 默认单位 = factor 该单位」
  (如 1kg = 518 只),反向换算除一下即得,不存两行。

  单位类型不限:同类型换算全局 ratio 已有(`bas_unit`),但箱/包等包装单位
  只能物料级表达,故不禁同类型、也不与全局 ratio 交叉校验。(物料, 单位) 唯一,
  单位不能是默认单位;物料改默认单位前必须先删转换行(见 Material)。

  单位转换视为物料维护的一部分,不设独立权限点:读跟随 inv.material:read,
  增删改跟随 inv.material:update(建料顺手录转换也允许 inv.material:create)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "inv_material_unit"
    repo SynieCore.Repo

    references do
      # 转换行是纯从属条目,随物料删除级联清理(同凭证分录行先例)
      reference :material, on_delete: :delete
    end
  end

  graphql do
    type :inv_material_unit
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

  def permission_prefix, do: "inv.material"
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
      accept [:material_id, :unit_id, :factor]

      validate {SynieCore.Inv.MaterialUnitNotDefault, []}
    end

    update :update do
      accept [:unit_id, :factor]
      require_atomic? false

      validate {SynieCore.Inv.MaterialUnitNotDefault, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  validations do
    validate compare(:factor, greater_than: 0), message: "换算系数必须大于 0"
  end

  attributes do
    uuid_primary_key :id

    attribute :factor, :decimal do
      allow_nil? false
      public? true
      description "换算系数(1 默认单位 = x 该单位)"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
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

  identities do
    identity :unique_material_unit, [:material_id, :unit_id], message: "该单位已有转换行"
  end
end
