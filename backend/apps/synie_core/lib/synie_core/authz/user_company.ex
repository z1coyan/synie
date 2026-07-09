defmodule SynieCore.Authz.UserCompany do
  @moduledoc """
  用户-公司数据权限授权,对应 `sys_user_company` 表。

  语义为显式授权(fail-closed):用户仅能看到被授权公司的数据;
  跨公司人员用 `sys_user.all_companies` 覆盖。授权挂用户不挂角色。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_user_company"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_user_company
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 公司授权视为用户管理的一部分,不设独立权限点(同 UserRole):
    # 读跟随 sys.user:read,增删跟随 sys.user:update(建用户顺手授权也允许 sys.user:create)
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
      accept [:user_id, :company_id]
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

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_user_company, [:user_id, :company_id]
  end
end
