defmodule SynieCore.Authz.UserCompany do
  @moduledoc """
  用户-公司数据权限授权,对应 `sys_user_company` 表。

  语义为显式授权(fail-closed):用户仅能看到被授权公司的数据;
  跨公司人员用 `sys_user.all_companies` 覆盖。授权挂用户不挂角色。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_user_company"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_user_company
  end

  def permission_prefix, do: "sys.user_company"
  def permission_actions, do: ~w(create read delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:user_id, :company_id]
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

    belongs_to :company, SynieCore.Org.Company do
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
