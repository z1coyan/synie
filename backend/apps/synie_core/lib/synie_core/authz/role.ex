defmodule SynieCore.Authz.Role.BuiltinGuard do
  @moduledoc "内置角色守卫:内置角色不可更新、不可删除(其授权只读由 RolePermission 侧守卫)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data && changeset.data.builtin do
      {:error, message: "内置角色不可修改或删除"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Authz.Role do
  @moduledoc "角色,对应 `sys_role` 表。内置角色(builtin)由迁移种子(如 admin),不可改不可删。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_role"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_role
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "sys.role"
  def permission_actions, do: ~w(create read update delete batch_delete export print batch_print)

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
      accept [:code, :name, :enabled]
    end

    update :update do
      accept [:name, :enabled]
      require_atomic? false

      validate SynieCore.Authz.Role.BuiltinGuard
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate SynieCore.Authz.Role.BuiltinGuard
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "角色编码"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "角色名称"
    end

    attribute :enabled, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用"
    end

    # 内置标记:仅迁移种子可写(资源 create 不接受),守卫挡一切 update/destroy
    attribute :builtin, :boolean do
      allow_nil? false
      public? true
      default false
      description "内置角色"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_code, [:code]
  end
end
