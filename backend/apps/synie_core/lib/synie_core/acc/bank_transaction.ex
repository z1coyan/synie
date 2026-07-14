defmodule SynieCore.Acc.BankTransaction.SingleSidedAmount do
  @moduledoc """
  校验收入/支出恰填一项且大于零。流水是现实银行流水的纯映射,不引入负数:
  冲正/转出退款按实际资金方向录(如转出退回=收入行)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    income = Ash.Changeset.get_attribute(changeset, :income)
    expense = Ash.Changeset.get_attribute(changeset, :expense)

    cond do
      is_nil(income) and is_nil(expense) ->
        {:error, field: :income, message: "收入或支出必须填写一项"}

      not is_nil(income) and not is_nil(expense) ->
        {:error, field: :expense, message: "收入与支出只能填写一项"}

      Decimal.compare(income || expense, 0) != :gt ->
        {:error, field: (income && :income) || :expense, message: "金额必须大于零"}

      true ->
        :ok
    end
  end
end

defmodule SynieCore.Acc.BankTransaction do
  @moduledoc """
  银行流水,对应 `acc_bank_transaction` 表。

  银行对账单的电子档案:数据以银行为准,余额是银行口径快照(不推算、不校验连续性),
  流水不参与记账。收入/支出恰填一项且大于零。主要录入路径是导入(另有导入模板资源),
  手工 CRUD 兜底;凭证关联后续另做。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "acc_bank_transaction"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :income, "single_sided_amount",
        check: "(income IS NULL) <> (expense IS NULL) AND COALESCE(income, expense) > 0",
        message: "收入/支出必须恰填一项且大于零"
    end

    custom_indexes do
      index [:company_id, :bank_account_id, :occurred_at]
    end
  end

  graphql do
    type :acc_bank_transaction
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

  def permission_prefix, do: "acc.bank_transaction"
  # import = 流水导入整链路(导入记录/导入行资源借同一码,见 BankImport)
  def permission_actions, do: ~w(create read update delete import)

  # fk 速览标题用摘要(可空时前端退截断 id,凭证关联轮再定)
  def display_field, do: :summary

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
        :occurred_at,
        :income,
        :expense,
        :balance,
        :counterparty_name,
        :counterparty_account,
        :summary,
        :note,
        :company_id,
        :bank_account_id
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Acc.OwnBankAccount, check_active: true}
      validate {SynieCore.Acc.BankTransaction.SingleSidedAmount, []}
    end

    update :update do
      # 不接受 company_id:流水不允许换公司(账户校验与数据权限都以公司为界)
      accept [
        :occurred_at,
        :income,
        :expense,
        :balance,
        :counterparty_name,
        :counterparty_account,
        :summary,
        :note,
        :bank_account_id
      ]

      require_atomic? false

      # 不传 check_active:停用账户的存量流水允许改错录归属/补备注
      validate {SynieCore.Acc.OwnBankAccount, []}
      validate {SynieCore.Acc.BankTransaction.SingleSidedAmount, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :occurred_at, :utc_datetime do
      allow_nil? false
      public? true
      description "交易时间"
    end

    attribute :income, :decimal do
      public? true
      description "收入金额"
    end

    attribute :expense, :decimal do
      public? true
      description "支出金额"
    end

    attribute :balance, :decimal do
      public? true
      description "余额"
    end

    attribute :counterparty_name, :string do
      public? true
      constraints max_length: 128
      description "对方户名"
    end

    attribute :counterparty_account, :string do
      public? true
      constraints max_length: 64
      description "对方账号"
    end

    attribute :summary, :string do
      public? true
      constraints max_length: 255
      description "摘要"
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

    belongs_to :bank_account, SynieCore.Acc.BankAccount do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "银行账户"
    end
  end
end
