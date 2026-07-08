defmodule SynieCore.Base.Currency do
  @moduledoc "货币,对应 `sys_currency` 表。iso_code 为 ISO 4217 三位大写字母编码,创建后不可改。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "sys_currency"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_currency
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "base.currency"
  def permission_actions, do: ~w(create read update delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:name, :iso_code, :symbol]
    end

    update :update do
      accept [:name, :symbol]
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
    end

    attribute :iso_code, :string do
      allow_nil? false
      public? true
      constraints match: ~r/^[A-Z]{3}$/
    end

    attribute :symbol, :string do
      public? true
      constraints max_length: 8
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  identities do
    identity :unique_iso_code, [:iso_code]
  end
end
