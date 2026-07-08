defmodule SynieCore.Authz.RolePermission do
  @moduledoc "角色-权限码授权,对应 `sys_role_permission` 表。权限码可为通配(`sales.order:*`、`sales.*`)。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_role_permission"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_role_permission
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "sys.role_permission"
  def permission_actions, do: ~w(create read delete)

  actions do
    defaults [:read]

    create :create do
      accept [:role_id, :permission]
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :permission, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
    end

    create_timestamp :inserted_at
  end

  relationships do
    belongs_to :role, SynieCore.Authz.Role do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_role_permission, [:role_id, :permission]
  end
end
