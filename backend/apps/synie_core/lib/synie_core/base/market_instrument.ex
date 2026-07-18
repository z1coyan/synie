defmodule SynieCore.Base.MarketSourceType do
  @moduledoc "行情品种来源类型:交易所序列/现货指数/其他。"

  use Ash.Type.Enum,
    values: [
      exchange: "交易所序列",
      spot_index: "现货指数",
      other: "其他"
    ]

  def graphql_type(_), do: :market_source_type
end

defmodule SynieCore.Base.MarketPriceKind do
  @moduledoc "行情价类:结算价/均价/最新价。"

  use Ash.Type.Enum,
    values: [
      settlement: "结算价",
      average: "均价",
      last: "最新价"
    ]

  def graphql_type(_), do: :market_price_kind
end

defmodule SynieCore.Base.MarketInstrument.NoPricePoints do
  @moduledoc "有价点的品种禁止物理删除(应停用)。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    id = changeset.data.id

    exists? =
      SynieCore.Base.MarketPricePoint
      |> Ash.Query.filter(instrument_id == ^id)
      |> Ash.exists?(authorize?: false)

    if exists? do
      {:error, message: "品种下已有行情价点,请停用而非删除"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Base.MarketInstrument do
  @moduledoc """
  行情品种,对应 `bas_market_instrument` 表。

  一条=一条稳定参考价序列(如沪铜、长江铜),全局共享;钉死币种/计量单位/默认价类/来源类型。
  退出以停用为主,有价点时不可物理删除。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "bas_market_instrument"
    repo SynieCore.Repo
  end

  graphql do
    type :bas_market_instrument
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "base.market_instrument"
  def permission_actions, do: ~w(create read update delete)

  def display_field, do: :name

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
      accept [
        :code,
        :name,
        :source_type,
        :default_price_kind,
        :active,
        :note,
        :currency_id,
        :unit_id
      ]
    end

    update :update do
      # 编码/币种/单位/来源类型钉死序列口径,创建后不可改
      accept [:name, :default_price_kind, :active, :note]
      require_atomic? false
    end

    destroy :destroy do
      primary? true
      require_atomic? false
      validate {SynieCore.Base.MarketInstrument.NoPricePoints, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "编码"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "名称"
    end

    attribute :source_type, SynieCore.Base.MarketSourceType do
      allow_nil? false
      public? true
      description "来源类型"
    end

    attribute :default_price_kind, SynieCore.Base.MarketPriceKind do
      allow_nil? false
      public? true
      description "默认价类"
    end

    attribute :active, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用"
    end

    attribute :note, :string do
      public? true
      constraints max_length: 255
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :currency, SynieCore.Base.Currency do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "币种"
    end

    belongs_to :unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "计量单位"
    end
  end

  identities do
    identity :unique_code, [:code]
  end
end
