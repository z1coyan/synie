defmodule SynieCore.Authz.UserRole do
  @moduledoc "用户-角色关联,对应 `sys_user_role` 表。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_user_role"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_user_role
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 角色分配视为用户管理的一部分,不设独立权限点:读跟随 sys.user:read,
    # 增删跟随 sys.user:update(建用户顺手分配也允许 sys.user:create)
    policy action(:read) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy action(:create) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    policy action(:destroy) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end
  end

  def permission_prefix, do: "sys.user"
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
      accept [:user_id, :role_id]
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    create_timestamp :inserted_at
  end

  relationships do
    belongs_to :user, SynieCore.Accounts.User do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end

    belongs_to :role, SynieCore.Authz.Role do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_user_role, [:user_id, :role_id]
  end
end
