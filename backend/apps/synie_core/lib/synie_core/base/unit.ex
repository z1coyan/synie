defmodule SynieCore.Base.UnitType do
  @moduledoc "单位类型:长度/面积/重量/数量。"

  use Ash.Type.Enum, values: [:length, :area, :weight, :quantity]

  def graphql_type(_), do: :unit_type
end

defmodule SynieCore.Base.Unit do
  @moduledoc "计量单位,对应 `bas_unit` 表。每类型一个基准单位(ratio=1),其余单位按 ratio 换算到基准单位(如 kg 为基准时 g=0.001)。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "bas_unit"
    repo SynieCore.Repo

    identity_wheres_to_sql unique_base_per_type: "is_base = true"
  end

  graphql do
    type :sys_unit
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "base.unit"
  def permission_actions, do: ~w(create read update delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:unit_type, :is_base, :name, :symbol, :ratio]
    end

    update :update do
      accept [:unit_type, :is_base, :name, :symbol, :ratio]
    end
  end

  validations do
    validate compare(:ratio, greater_than: 0), message: "换算比例必须大于 0"

    validate compare(:ratio, greater_than_or_equal_to: 1, less_than_or_equal_to: 1),
      where: [attribute_equals(:is_base, true)],
      message: "基准单位换算比例必须为 1"
  end

  attributes do
    uuid_primary_key :id

    attribute :unit_type, SynieCore.Base.UnitType do
      allow_nil? false
      public? true
    end

    attribute :is_base, :boolean do
      allow_nil? false
      public? true
      default false
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
    end

    attribute :symbol, :string do
      allow_nil? false
      public? true
      constraints max_length: 16
    end

    attribute :ratio, :decimal do
      allow_nil? false
      public? true
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  identities do
    identity :unique_symbol, [:symbol]

    # 数据库层保证每个类型只有一个基准单位(部分唯一索引)
    identity :unique_base_per_type, [:unit_type] do
      where expr(is_base == true)
    end
  end
end
