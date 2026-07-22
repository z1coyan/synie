defmodule SynieCore.Base.Currency.NotCompanyBase do
  @moduledoc "停用校验:被任一家公司引用为本币的货币不可停用。"
  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def init(opts), do: {:ok, opts}

  @impl true
  def validate(changeset, _opts, _context) do
    active = Ash.Changeset.get_attribute(changeset, :active)
    currency_id = changeset.data.id

    if active == false and currency_id do
      has_company? =
        SynieCore.Base.Company
        |> Ash.Query.filter(base_currency_id == ^currency_id)
        |> Ash.exists?(authorize?: false)

      if has_company? do
        {:error, field: :active, message: "已被公司引用为本币,不可停用"}
      else
        :ok
      end
    else
      :ok
    end
  end
end

defmodule SynieCore.Base.Currency do
  @moduledoc """
  货币,对应 `bas_currency` 表。iso_code 为 ISO 4217 三位大写字母编码,创建后不可改。

  启停(`active`):拦新不拦旧——新建单据/公司本币只能选启用币种;停用不影响已引用历史。
  被任一家公司引用为本币的货币不可停用。初始化向导预置常用货币时默认全部停用,
  选定本币后仅本币启用,其余须在货币管理页手动启用。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "bas_currency"
    repo SynieCore.Repo
  end

  graphql do
    type :bas_currency
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
  def permission_label, do: "币种"
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
      accept [:name, :iso_code, :symbol, :active]
    end

    update :update do
      accept [:name, :symbol, :active]
      require_atomic? false

      validate {SynieCore.Base.Currency.NotCompanyBase, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "货币名称"
    end

    attribute :iso_code, :string do
      allow_nil? false
      public? true
      constraints match: ~r/^[A-Z]{3}$/
      description "ISO 编码"
    end

    attribute :symbol, :string do
      public? true
      constraints max_length: 8
      description "符号"
    end

    attribute :active, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_iso_code, [:iso_code]
  end
end
