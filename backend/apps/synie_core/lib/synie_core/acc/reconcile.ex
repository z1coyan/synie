defmodule SynieCore.Acc.Reconcile do
  @moduledoc """
  银行流水对账的共享判定/计算助手:方向、额度、锁、派生列刷新。

  额度按「凭证 × 银行科目 × 方向」维度计算:同一凭证借银行A/贷银行B(内部转账)时,
  A 的收入流水与 B 的支出流水各自消耗自己科目方向的行金额,互不挤占。
  所有 lock_* 仅在动作 before_action(事务内)调用才有锁定效果;
  锁序统一「先流水后凭证」,与凭证取消(只锁凭证、不锁流水)之间无环。
  """

  require Ash.Query

  alias SynieCore.Acc.{BankAccount, BankReconciliation, BankTransaction, GlJournalLine}

  @doc "流水金额(收入或支出,恰一项非空)。"
  def txn_amount(txn), do: txn.income || txn.expense

  @doc "流水对应的凭证行方向:收入 → 银行科目借方,支出 → 贷方。"
  def side(txn), do: if(txn.income, do: :debit, else: :credit)

  @doc "事务内 FOR UPDATE 锁流水行(串行化对账增删/流水改删)。"
  def lock_transaction(txn_id) do
    BankTransaction
    |> Ash.Query.filter(id == ^txn_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc "流水所属银行账户绑定的会计科目 id;未绑定即不可对账(严格模式)。"
  def ledger_account_id(txn) do
    case Ash.get(BankAccount, txn.bank_account_id, authorize?: false) do
      {:ok, %{account_id: nil}} -> {:error, "银行账户未绑定会计科目,请先在银行账户上绑定"}
      {:ok, %{account_id: account_id}} -> {:ok, account_id}
      {:error, _} -> {:error, "银行账户不存在"}
    end
  end

  @doc "流水已对账金额合计;opts[:except] 排除指定对账记录 id。"
  def reconciled_total(txn_id, opts \\ []) do
    BankReconciliation
    |> Ash.Query.filter(bank_transaction_id == ^txn_id)
    |> except(opts[:except])
    |> Ash.read!(authorize?: false)
    |> sum_amounts()
  end

  @doc "凭证在指定银行科目、指定方向上的分录行金额合计(对此方向流水的对账总上限)。"
  def journal_line_total(journal_id, ledger_account_id, side) do
    query =
      GlJournalLine
      |> Ash.Query.filter(journal_id == ^journal_id and account_id == ^ledger_account_id)

    query =
      case side do
        :debit -> Ash.Query.filter(query, debit > 0)
        :credit -> Ash.Query.filter(query, credit > 0)
      end

    query
    |> Ash.read!(authorize?: false)
    |> Enum.map(&if(side == :debit, do: &1.debit, else: &1.credit))
    |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
  end

  @doc """
  凭证已对账给「绑定同一科目、同方向」流水的金额合计;opts[:except] 排除指定记录。
  单凭证对账记录量小,直接加载后在内存筛跨表条件,不拼跨表查询。
  """
  def journal_used(journal_id, ledger_account_id, side, opts \\ []) do
    BankReconciliation
    |> Ash.Query.filter(journal_id == ^journal_id)
    |> except(opts[:except])
    |> Ash.Query.load(bank_transaction: [:bank_account])
    |> Ash.read!(authorize?: false)
    |> Enum.filter(fn rec ->
      rec.bank_transaction.bank_account.account_id == ledger_account_id and
        side(rec.bank_transaction) == side
    end)
    |> sum_amounts()
  end

  @doc """
  刷新流水派生列(已对账/未对账/状态)。仅在对账记录增删动作的 after_action
  (事务内、流水行已在 before_action 锁定)调用;actor 透传给审计日志。
  """
  def refresh_transaction!(txn_id, actor) do
    {:ok, txn} = lock_transaction(txn_id)
    total = reconciled_total(txn_id)
    amount = txn_amount(txn)

    status =
      cond do
        Decimal.compare(total, 0) == :eq -> :unreconciled
        Decimal.compare(total, amount) == :lt -> :partial
        true -> :reconciled
      end

    txn
    |> Ash.Changeset.for_update(
      :refresh_reconcile,
      %{
        reconciled_amount: total,
        unreconciled_amount: Decimal.sub(amount, total),
        reconcile_status: status
      },
      actor: actor,
      authorize?: false
    )
    |> Ash.update!()
  end

  defp except(query, nil), do: query
  defp except(query, id), do: Ash.Query.filter(query, id != ^id)

  defp sum_amounts(records) do
    records |> Enum.map(& &1.amount) |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
  end
end
