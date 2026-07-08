defmodule SynieCore.Accounts.User do
  @moduledoc """
  系统用户,对应 `sys_user` 表。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_user"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_user
  end

  actions do
    defaults [:read]

    create :register do
      accept [:username, :name]

      argument :password, :string, allow_nil?: false, sensitive?: true

      change SynieCore.Accounts.Changes.HashPassword
    end

    read :by_username do
      get? true

      argument :username, :ci_string, allow_nil?: false

      filter expr(username == ^arg(:username))
    end

    update :set_super_admin do
      accept []

      change set_attribute(:super_admin, true)
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :username, :ci_string do
      allow_nil? false
      public? true
      constraints max_length: 64
    end

    attribute :name, :string do
      public? true
      constraints max_length: 64
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

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  identities do
    identity :unique_username, [:username]
  end
end
