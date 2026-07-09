defmodule SynieCore.Purchase.Supplier do
  @moduledoc "供应商,对应 `pur_supplier` 表。编号前期手工填写,全局唯一。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "pur_supplier"
    repo SynieCore.Repo
  end

  graphql do
    type :pur_supplier
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "purchase.supplier"
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
      accept [:code, :name, :short_name]
    end

    update :update do
      accept [:code, :name, :short_name]
      require_atomic? false
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "供应商编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "供应商名称"
    end

    attribute :short_name, :string do
      public? true
      constraints max_length: 64
      description "简称"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_code, [:code]
  end
end
