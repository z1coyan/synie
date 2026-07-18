defmodule SynieCore.Sales.Customer do
  @moduledoc "客户,对应 `sal_customers` 表。编号前期手工填写,全局唯一。有物料引用时禁止删除。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "sal_customers"
    repo SynieCore.Repo
  end

  graphql do
    type :sal_customer
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "sales.customer"
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

      validate fn changeset, _context ->
        if has_materials?(changeset.data.id) do
          {:error, message: "存在关联物料,不能删除"}
        else
          :ok
        end
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "客户编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "客户名称"
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

  defp has_materials?(customer_id) do
    SynieCore.Inv.Material
    |> Ash.Query.filter(customer_id == ^customer_id)
    |> Ash.exists?(authorize?: false)
  end
end
