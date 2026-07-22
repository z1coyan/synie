defmodule SynieCore.Mfg.ProcessTemplateItem do
  @moduledoc """
  工艺模板行,对应 `mfg_process_template_item` 表。一行 = 模板内一道工序
  (工序引用 + 顺序 + 工艺要求文本 + 外协标记),随模板级联删除。

  行是独立资源,前端做 diff 持久化,不走 manage_relationship。
  模板行维护视为工艺模板维护的一部分,不设独立权限点:读跟随 mfg.route_template:read,
  增删改跟随 mfg.route_template:update(建模板顺手录行也允许 mfg.route_template:create),
  同物料单位转换先例。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "mfg_process_template_item"
    repo SynieCore.Repo

    references do
      # 模板行是纯从属条目,随模板删除级联清理(同物料单位转换先例)
      reference :template, on_delete: :delete
    end
  end

  graphql do
    type :mfg_process_template_item
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

  def permission_prefix, do: "mfg.route_template"
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
      accept [:template_id, :operation_id, :seq, :requirement, :is_outsourced]
    end

    update :update do
      accept [:operation_id, :seq, :requirement, :is_outsourced]
      require_atomic? false
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :seq, :integer do
      allow_nil? false
      public? true
      description "工序顺序"
    end

    attribute :requirement, :string do
      public? true
      constraints max_length: 512
      description "工艺要求"
    end

    attribute :is_outsourced, :boolean do
      allow_nil? false
      public? true
      default false
      description "外协标记"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :template, SynieCore.Mfg.ProcessTemplate do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "工艺模板"
    end

    belongs_to :operation, SynieCore.Mfg.Operation do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "工序"
    end
  end
end
