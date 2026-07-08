defmodule SynieCore.Org.Company do
  @moduledoc "公司(ERPNext 式多公司,单库),对应 `bas_company` 表,树形结构支持集团/合并视角。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "bas_company"
    repo SynieCore.Repo
  end

  graphql do
    type :bas_company
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "org.company"
  def permission_actions, do: ~w(create read update delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:code, :name, :short_name, :parent_id]
    end

    update :update do
      accept [:name, :short_name, :parent_id]
    end
  end

  attributes do
    uuid_primary_key :id

    # 公司编号:手动输入,固定两位英文字母,创建后不可改
    attribute :code, :string do
      allow_nil? false
      public? true
      constraints match: ~r/^[A-Za-z]{2}$/
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
    end

    attribute :short_name, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  relationships do
    belongs_to :parent, __MODULE__ do
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_code, [:code]
  end
end
