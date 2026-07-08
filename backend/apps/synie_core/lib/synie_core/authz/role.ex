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
    defaults [:destroy]

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

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_code, [:code]
  end
end
