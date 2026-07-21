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

defmodule SynieCore.Acc.BankTransaction.ReconcileGuard do
  @moduledoc """
  已有对账关联的流水约束:禁止删除;修改时禁止收支换边、金额不得低于已对账金额;
  金额变化时同步刷新未对账金额与状态。before_action 事务内 FOR UPDATE 锁自身行,
  与对账增删(同样先锁流水)串行化。
  """

  use Ash.Resource.Change

  alias SynieCore.Acc.Reconcile

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      {:ok, txn} = Reconcile.lock_transaction(cs.data.id)
      total = Reconcile.reconciled_total(txn.id)
      has_links? = Decimal.compare(total, 0) == :gt

      if cs.action.name == :destroy do
        if has_links? do
          Ash.Changeset.add_error(cs, message: "流水已有对账记录,请先解除对账后再删除")
        else
          cs
        end
      else
        check_update(cs, txn, total, has_links?)
      end
    end)
  end

  defp check_update(cs, txn, total, has_links?) do
    income = Ash.Changeset.get_attribute(cs, :income)
    expense = Ash.Changeset.get_attribute(cs, :expense)
    amount = income || expense
    was_income? = txn.income != nil
    now_income? = income != nil

    # 换银行账户 = 换绑定科目 = 凭证侧已用额度归属漂移,已对账流水一律禁止
    bank_account_changed? =
      Ash.Changeset.get_attribute(cs, :bank_account_id) != txn.bank_account_id

    cond do
      has_links? and bank_account_changed? ->
        Ash.Changeset.add_error(cs, message: "流水已有对账记录,不允许更换银行账户")

      has_links? and was_income? != now_income? ->
        Ash.Changeset.add_error(cs, message: "流水已有对账记录,不允许收支换边")

      amount != nil and Decimal.compare(amount, total) == :lt ->
        Ash.Changeset.add_error(cs,
          field: (income && :income) || :expense,
          message: "金额不得低于已对账金额(已对账 #{total})"
        )

      amount != nil ->
        refresh_derived(cs, amount, total)

      true ->
        cs
    end
  end

  # 金额可能被修改:按锁内权威合计重算派生列(与对账增删的刷新同一套口径)
  defp refresh_derived(cs, amount, total) do
    status =
      cond do
        Decimal.compare(total, 0) == :eq -> :unreconciled
        Decimal.compare(total, amount) == :lt -> :partial
        true -> :reconciled
      end

    cs
    |> Ash.Changeset.force_change_attribute(:unreconciled_amount, Decimal.sub(amount, total))
    |> Ash.Changeset.force_change_attribute(:reconcile_status, status)
  end
end

defmodule SynieCore.Acc.BankTransaction do
  @moduledoc """
  银行流水,对应 `acc_bank_transaction` 表。

  银行对账单的电子档案:数据以银行为准,余额是银行口径快照(不推算、不校验连续性),
  流水不参与记账。收入/支出恰填一项且大于零。主要录入路径是导入(另有导入模板资源),
  手工 CRUD 兜底;凭证对账见 `BankReconciliation`。
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
  def permission_label, do: "银行流水"
  # import = 流水导入整链路(导入记录/导入行资源借同一码,见 BankImport)
  # reconcile = 对账整链路(对账记录资源借同一码,见 BankReconciliation)
  def permission_actions, do: ~w(create read update delete import reconcile)

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

      # 派生列初始化:未对账金额 = 流水金额(金额缺失时交给 SingleSidedAmount 报错)
      change fn changeset, _context ->
        amount =
          Ash.Changeset.get_attribute(changeset, :income) ||
            Ash.Changeset.get_attribute(changeset, :expense)

        if amount do
          Ash.Changeset.force_change_attribute(changeset, :unreconciled_amount, amount)
        else
          changeset
        end
      end
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

      change {SynieCore.Acc.BankTransaction.ReconcileGuard, []}
    end

    update :refresh_reconcile do
      # 内部动作:对账记录增删后刷新派生列(Reconcile.refresh_transaction!,authorize?: false 调用)
      accept []
      require_atomic? false

      argument :reconciled_amount, :decimal, allow_nil?: false
      argument :unreconciled_amount, :decimal, allow_nil?: false
      argument :reconcile_status, SynieCore.Acc.ReconcileStatus, allow_nil?: false

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(
          :reconciled_amount,
          Ash.Changeset.get_argument(changeset, :reconciled_amount)
        )
        |> Ash.Changeset.force_change_attribute(
          :unreconciled_amount,
          Ash.Changeset.get_argument(changeset, :unreconciled_amount)
        )
        |> Ash.Changeset.force_change_attribute(
          :reconcile_status,
          Ash.Changeset.get_argument(changeset, :reconcile_status)
        )
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Acc.BankTransaction.ReconcileGuard, []}
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

    attribute :reconciled_amount, :decimal do
      allow_nil? false
      default Decimal.new(0)
      writable? false
      public? true
      description "已对账金额"
    end

    attribute :unreconciled_amount, :decimal do
      allow_nil? false
      default Decimal.new(0)
      writable? false
      public? true
      description "未对账金额"
    end

    attribute :reconcile_status, SynieCore.Acc.ReconcileStatus do
      allow_nil? false
      default :unreconciled
      writable? false
      public? true
      description "对账状态"
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

    has_many :reconciliations, SynieCore.Acc.BankReconciliation do
      destination_attribute :bank_transaction_id
      public? true
      description "对账记录"
    end
  end
end
