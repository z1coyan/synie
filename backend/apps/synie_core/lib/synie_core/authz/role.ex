defmodule SynieCore.Authz.Role do
  @moduledoc "角色,对应 `sys_role` 表。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer]

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
  def permission_actions, do: ~w(create read update delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:code, :name, :enabled]
    end

    update :update do
      accept [:name, :enabled]
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
    end

    attribute :enabled, :boolean do
      allow_nil? false
      public? true
      default true
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  identities do
    identity :unique_code, [:code]
  end
end
