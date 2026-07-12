defmodule SynieCore.Acc.BankAccount.LedgerAccount do
  @moduledoc """
  校验绑定科目:必须属于同一公司、非汇总、启用;
  科目指定了币种时须与账户货币一致(科目未指定币种视为本位币通用,不校验)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :account_id) do
      nil -> :ok
      account_id -> check(changeset, account_id)
    end
  end

  defp check(changeset, account_id) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)
    currency_id = Ash.Changeset.get_attribute(changeset, :currency_id)

    case Ash.get(SynieCore.Base.Account, account_id, authorize?: false) do
      {:ok, %{company_id: ^company_id} = account} ->
        cond do
          account.is_group ->
            {:error, field: :account_id, message: "汇总科目不能绑定银行账户"}

          not account.active ->
            {:error, field: :account_id, message: "停用科目不能绑定银行账户"}

          account.currency_id != nil and account.currency_id != currency_id ->
            {:error, field: :account_id, message: "绑定科目币种与账户货币不一致"}

          true ->
            :ok
        end

      {:ok, _account} ->
        {:error, field: :account_id, message: "绑定科目必须属于同一公司"}

      {:error, _} ->
        {:error, field: :account_id, message: "绑定科目不存在"}
    end
  end
end

defmodule SynieCore.Acc.BankAccount do
  @moduledoc """
  银行账户,对应 `acc_bank_account` 表。

  公司下的资金账户主数据,为银行流水/对账铺垫:别名与账号同公司内唯一,
  绑定会计科目(选填)供后续流水记账。停用不删,历史数据保引用。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "acc_bank_account"
    repo SynieCore.Repo
  end

  graphql do
    type :acc_bank_account
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 公司维度 fail-closed;update/destroy 取数走 read,同样被此过滤兜住
    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "acc.bank_account"
  def permission_actions, do: ~w(create read update delete)

  # fk 速览/下拉显示用别名(默认反射也会取到 alias,显式声明防字段顺序变动)
  def display_field, do: :alias

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
        :alias,
        :bank_name,
        :branch_name,
        :holder_name,
        :account_no,
        :active,
        :note,
        :company_id,
        :currency_id,
        :account_id
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Acc.BankAccount.LedgerAccount, []}
    end

    update :update do
      # 不接受 company_id:账户不允许换公司(唯一性与未来流水都以公司为界)
      accept [
        :alias,
        :bank_name,
        :branch_name,
        :holder_name,
        :account_no,
        :active,
        :note,
        :currency_id,
        :account_id
      ]

      require_atomic? false

      validate {SynieCore.Acc.BankAccount.LedgerAccount, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :alias, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "账户别名"
    end

    attribute :bank_name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "所属银行"
    end

    attribute :branch_name, :string do
      public? true
      constraints max_length: 128
      description "开户支行"
    end

    attribute :holder_name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "户名"
    end

    attribute :account_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "银行账号"
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
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :currency, SynieCore.Base.Currency do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "货币"
    end

    belongs_to :account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "绑定科目"
    end
  end

  identities do
    identity :unique_alias_per_company, [:company_id, :alias]
    identity :unique_account_no_per_company, [:company_id, :account_no]
  end
end
