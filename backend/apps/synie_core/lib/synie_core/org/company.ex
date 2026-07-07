defmodule SynieCore.Org.Company do
  @moduledoc "公司(ERPNext 式多公司,单库),对应 `sys_company` 表,树形结构支持集团/合并视角。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_company"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_company
  end

  def permission_prefix, do: "org.company"
  def permission_actions, do: ~w(create read update delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:code, :name, :parent_id]
    end

    update :update do
      accept [:name, :parent_id]
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
      constraints max_length: 128
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
