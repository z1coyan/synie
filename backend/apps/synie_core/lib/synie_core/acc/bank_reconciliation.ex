defmodule SynieCore.Acc.BankReconciliation.ValidateReconcile do
  @moduledoc """
  对账关联创建:构建期回填 company_id(CompanyAccessible 声明顺序依赖)并确认流水存在;
  before_action(事务内)FOR UPDATE 依次锁流水、凭证后权威复检——凭证已审核、同公司、
  银行账户已绑科目、凭证含该科目方向行、双侧额度不超;after_action 刷新流水派生列。
  """

  use Ash.Resource.Change

  alias SynieCore.Acc.{GlJournal, Reconcile}

  @impl true
  def change(changeset, _opts, context) do
    txn_id = Ash.Changeset.get_attribute(changeset, :bank_transaction_id)

    changeset =
      case read_txn(txn_id) do
        {:ok, txn} when txn != nil ->
          Ash.Changeset.force_change_attribute(changeset, :company_id, txn.company_id)

        _ ->
          Ash.Changeset.add_error(changeset,
            field: :bank_transaction_id,
            message: "银行流水不存在"
          )
      end

    changeset
    |> Ash.Changeset.before_action(&authoritative_check/1)
    |> Ash.Changeset.after_action(fn _cs, record ->
      Reconcile.refresh_transaction!(record.bank_transaction_id, context.actor)
      {:ok, record}
    end)
  end

  defp read_txn(nil), do: {:ok, nil}
  defp read_txn(id), do: Ash.get(SynieCore.Acc.BankTransaction, id, authorize?: false)

  defp authoritative_check(cs) do
    txn_id = Ash.Changeset.get_attribute(cs, :bank_transaction_id)
    journal_id = Ash.Changeset.get_attribute(cs, :journal_id)
    amount = Ash.Changeset.get_attribute(cs, :amount)

    with {:ok, txn} when txn != nil <- Reconcile.lock_transaction(txn_id),
         {:ok, journal} when journal != nil <- GlJournal.lock_journal(journal_id),
         :ok <- run_checks(txn, journal, amount) do
      cs
    else
      {:error, field, message} -> Ash.Changeset.add_error(cs, field: field, message: message)
      _ -> Ash.Changeset.add_error(cs, message: "银行流水或凭证不存在")
    end
  end

  defp run_checks(txn, journal, amount) do
    with :ok <- check_amount(amount),
         :ok <- check_journal(txn, journal),
         {:ok, ledger_account_id} <- check_ledger(txn) do
      check_capacity(txn, journal, ledger_account_id, amount)
    end
  end

  defp check_amount(amount) do
    if amount && Decimal.compare(amount, 0) == :gt,
      do: :ok,
      else: {:error, :amount, "对账金额必须大于零"}
  end

  defp check_journal(txn, journal) do
    cond do
      journal.company_id != txn.company_id -> {:error, :journal_id, "凭证与流水必须属于同一公司"}
      journal.status != :audited -> {:error, :journal_id, "仅已审核凭证可用于对账"}
      true -> :ok
    end
  end

  defp check_ledger(txn) do
    case Reconcile.ledger_account_id(txn) do
      {:ok, id} -> {:ok, id}
      {:error, msg} -> {:error, :bank_transaction_id, msg}
    end
  end

  defp check_capacity(txn, journal, ledger_account_id, amount) do
    side = Reconcile.side(txn)
    line_total = Reconcile.journal_line_total(journal.id, ledger_account_id, side)
    txn_remaining = Decimal.sub(Reconcile.txn_amount(txn), Reconcile.reconciled_total(txn.id))

    journal_remaining =
      Decimal.sub(line_total, Reconcile.journal_used(journal.id, ledger_account_id, side))

    side_label = if(side == :debit, do: "借方", else: "贷方")

    cond do
      Decimal.compare(line_total, 0) == :eq ->
        {:error, :journal_id, "凭证不含该银行科目的#{side_label}分录行,方向不匹配"}

      Decimal.compare(amount, txn_remaining) == :gt ->
        {:error, :amount, "超过流水未对账金额(剩余 #{txn_remaining})"}

      Decimal.compare(amount, journal_remaining) == :gt ->
        {:error, :amount, "超过凭证可对账余额(该科目#{side_label}剩余 #{journal_remaining})"}

      true ->
        :ok
    end
  end
end

defmodule SynieCore.Acc.BankReconciliation.RefreshOnDestroy do
  @moduledoc "解除对账:事务内先锁流水(与并发对账/流水改删串行化),删除后刷新派生列。"

  use Ash.Resource.Change

  alias SynieCore.Acc.Reconcile

  @impl true
  def change(changeset, _opts, context) do
    changeset
    |> Ash.Changeset.before_action(fn cs ->
      case Reconcile.lock_transaction(cs.data.bank_transaction_id) do
        {:ok, txn} when txn != nil -> cs
        _ -> Ash.Changeset.add_error(cs, message: "银行流水不存在")
      end
    end)
    |> Ash.Changeset.after_action(fn _cs, record ->
      Reconcile.refresh_transaction!(record.bank_transaction_id, context.actor)
      {:ok, record}
    end)
  end
end

defmodule SynieCore.Acc.BankReconciliation do
  @moduledoc """
  银行流水对账记录,对应 `acc_bank_reconciliation` 表:流水 ↔ 已审核凭证的 m-n 金额勾稽。

  同一对流水-凭证仅一条记录(改金额=解除后重建,无 update 动作);
  company_id 冗余自流水复用公司数据权限;严格校验见 ValidateReconcile。
  纯关联资源无独立权限点:读跟随 acc.bank_transaction:read,增删跟随 :reconcile。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "acc_bank_reconciliation"
    repo SynieCore.Repo

    references do
      # 删除保护走动作校验(有对账的流水禁删、凭证禁取消),DB restrict 兜底防孤儿
      reference :bank_transaction, on_delete: :restrict
      reference :journal, on_delete: :restrict
    end

    check_constraints do
      check_constraint :amount, "positive_amount",
        check: "amount > 0",
        message: "对账金额必须大于零"
    end
  end

  graphql do
    type :acc_bank_reconciliation
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action(:read) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy action([:create, :destroy]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "reconcile"}
    end

    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  # 复用流水权限码;actions 为空不进权限目录(同 GlJournalLine 跟随 acc.gl_journal 的先例)
  def permission_prefix, do: "acc.bank_transaction"
  def permission_actions, do: []

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
      accept [:bank_transaction_id, :journal_id, :amount]

      # 顺序敏感:先回填 company_id,再做公司授权校验(同 GlJournalLine.SyncJournal 先例)
      change {SynieCore.Acc.BankReconciliation.ValidateReconcile, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Acc.BankReconciliation.RefreshOnDestroy, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :amount, :decimal do
      allow_nil? false
      public? true
      description "对账金额"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :bank_transaction, SynieCore.Acc.BankTransaction do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "银行流水"
    end

    belongs_to :journal, SynieCore.Acc.GlJournal do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "凭证"
    end
  end

  identities do
    identity :unique_txn_journal, [:bank_transaction_id, :journal_id]
  end
end
