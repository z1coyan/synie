defmodule SynieCore.Accounts.User do
  @moduledoc """
  系统用户,对应 `sys_user` 表。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_user"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_user
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action_type([:read, :create, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action(:update) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 重置密码就是一种编辑:复用 update 权限码,不设独立权限点
    policy action(:reset_password) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end

    # set_super_admin 不挂策略:仅超管 bypass 或受信内部路径(seeds)可用
  end

  def permission_prefix, do: "sys.user"
  def permission_actions, do: ~w(create read update delete)

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
      accept [:username, :name]

      argument :password, :string, allow_nil?: false, sensitive?: true

      change SynieCore.Accounts.Changes.HashPassword
    end

    update :update do
      accept [:name]
      require_atomic? false
    end

    update :reset_password do
      accept []
      require_atomic? false

      argument :password, :string, allow_nil?: false, sensitive?: true

      change SynieCore.Accounts.Changes.HashPassword
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end

    read :by_username do
      get? true

      argument :username, :ci_string, allow_nil?: false

      filter expr(username == ^arg(:username))
    end

    update :set_super_admin do
      accept []
      require_atomic? false

      change set_attribute(:super_admin, true)
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :username, :ci_string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "用户名"
    end

    attribute :name, :string do
      public? true
      constraints max_length: 64
      description "姓名"
    end

    attribute :hashed_password, :string do
      allow_nil? false
      sensitive? true
    end

    attribute :super_admin, :boolean do
      allow_nil? false
      default false
    end

    attribute :all_companies, :boolean do
      allow_nil? false
      default false
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_username, [:username]
  end
end
