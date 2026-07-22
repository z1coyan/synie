defmodule SynieCore.Mfg.BomRoute do
  @moduledoc """
  BOM 工艺路线行,对应 `mfg_bom_route` 表。挂在 BOM 上的工序子表(每 BOM 私有):
  一行 = 工序引用 + 顺序 + 工艺要求文本 + 外协标记,描述「怎么做」;
  不带生产数量、不驱动执行、不派生库存/财务后果(见 BOM 模块 ADR)。
  可由工艺模板复制带入(`Bom.apply_route_template`),复制后与模板脱钩。

  行是独立资源,前端做 diff 持久化,不走 manage_relationship。行维护视为 BOM
  维护的一部分,不设独立权限点(同配料行先例)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "mfg_bom_route"
    repo SynieCore.Repo

    references do
      # 路线行是纯从属条目,随 BOM 删除级联清理
      reference :bom, on_delete: :delete
    end
  end

  graphql do
    type :mfg_bom_route
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
      accept [:bom_id, :operation_id, :seq, :requirement, :is_outsourced]
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
    belongs_to :bom, SynieCore.Mfg.Bom do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "BOM"
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
