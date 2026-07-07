defmodule SynieCore.Authz.UserRole do
  @moduledoc "用户-角色关联,对应 `sys_user_role` 表。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_user_role"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_user_role
  end

  def permission_prefix, do: "sys.user_role"
  def permission_actions, do: ~w(create read delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:user_id, :role_id]
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
