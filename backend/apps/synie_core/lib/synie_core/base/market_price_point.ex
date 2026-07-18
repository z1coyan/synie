defmodule SynieCore.Base.MarketPriceSource do
  @moduledoc "行情价点录入通道:手工补录/定时拉取。"

  use Ash.Type.Enum,
    values: [
      manual: "手工",
      fetch: "拉取"
    ]

  def graphql_type(_), do: :market_price_source
end

defmodule SynieCore.Base.MarketPricePoint.InheritInstrument do
  @moduledoc """
  创建价点时从品种继承币种/单位;价类空则用品种默认价类。
  币种与单位强制与品种一致,杜绝序列口径漂移。
  在 change 阶段写入(非 before_action),以便通过 allow_nil? false 校验。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :instrument_id) do
      nil ->
        changeset

      instrument_id ->
        case Ash.get(SynieCore.Base.MarketInstrument, instrument_id, authorize?: false) do
          {:ok, inst} ->
            price_kind =
              Ash.Changeset.get_attribute(changeset, :price_kind) || inst.default_price_kind

            changeset
            |> Ash.Changeset.force_change_attribute(:currency_id, inst.currency_id)
            |> Ash.Changeset.force_change_attribute(:unit_id, inst.unit_id)
            |> Ash.Changeset.force_change_attribute(:price_kind, price_kind)

          {:error, _} ->
            Ash.Changeset.add_error(changeset,
              field: :instrument_id,
              message: "行情品种不存在"
            )
        end
    end
  end
end

defmodule SynieCore.Base.MarketPricePoint do
  @moduledoc """
  行情价点,对应 `bas_market_price_point` 表。

  不可变价格事实:(品种, 观测时刻, 价类)在有效(未作废)集合上唯一;
  只追加,错价作废后重录;币种/单位继承自品种。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "bas_market_price_point"
    repo SynieCore.Repo

    identity_wheres_to_sql unique_active_point: "is_voided = false"
  end

  graphql do
    type :bas_market_price_point
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # void 复用独立权限点(非 update)
    policy action([:read, :create, :void]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "base.market_price"
  def permission_actions, do: ~w(create read void)

  def grid_actions do
    [
      %{
        key: "void",
        label: "作废",
        scope: "row",
        mutation: "voidBasMarketPricePoint",
        is_danger: true
      }
    ]
  end

  def display_field, do: :observed_at

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
      # 币种/单位由 InheritInstrument 从品种强制写入,不接受客户端覆盖
      accept [:observed_at, :price, :price_kind, :source, :note, :instrument_id]

      change {SynieCore.Base.MarketPricePoint.InheritInstrument, []}

      validate compare(:price, greater_than: 0), message: "价格必须大于 0"
    end

    update :void do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.is_voided do
          {:error, message: "价点已作废"}
        else
          :ok
        end
      end

      change set_attribute(:is_voided, true)
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :observed_at, :utc_datetime do
      allow_nil? false
      public? true
      description "观测时刻"
    end

    attribute :price, :decimal do
      allow_nil? false
      public? true
      description "价格"
    end

    attribute :price_kind, SynieCore.Base.MarketPriceKind do
      allow_nil? false
      public? true
      description "价类"
    end

    attribute :source, SynieCore.Base.MarketPriceSource do
      allow_nil? false
      public? true
      default :manual
      description "来源"
    end

    attribute :is_voided, :boolean do
      allow_nil? false
      public? true
      default false
      description "已作废"
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
    belongs_to :instrument, SynieCore.Base.MarketInstrument do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "行情品种"
    end

    belongs_to :currency, SynieCore.Base.Currency do
      allow_nil? false
      public? true
      attribute_public? true
      # 仅由 change 写入,客户端不可改
      attribute_writable? false
      description "币种"
    end

    belongs_to :unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? false
      description "计量单位"
    end
  end

  identities do
    identity :unique_active_point, [:instrument_id, :observed_at, :price_kind] do
      where expr(is_voided == false)
    end
  end
end
