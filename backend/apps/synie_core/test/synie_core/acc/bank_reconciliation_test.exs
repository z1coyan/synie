defmodule SynieCore.Acc.BankReconciliationTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.{BankAccount, BankReconciliation, BankTransaction, GlJournal, GlJournalLine}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.{Account, Currency}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    bank_acct = account!(company, %{code: "1002", name: "银行存款", direction: :debit})
    sales = account!(company, %{code: "6001", name: "主营业务收入", direction: :credit})
    bank_account = bank_account!(company, bank_acct)
    %{company: company, bank_acct: bank_acct, sales: sales, bank_account: bank_account}
  end

  defp account!(company, attrs) do
    Account
    |> Ash.Changeset.for_create(:create, Map.merge(%{company_id: company.id}, attrs))
    |> Ash.create!(authorize?: false)
  end

  defp currency! do
    i = System.unique_integer([:positive])
    code = <<?A + rem(div(i, 676), 26), ?A + rem(div(i, 26), 26), ?A + rem(i, 26)>>

    Currency
    |> Ash.Changeset.for_create(:create, %{name: "测试币", iso_code: code})
    |> Ash.create!(authorize?: false)
  end

  # ledger_account 传 nil 即「未绑定科目」的账户
  defp bank_account!(company, ledger_account, attrs \\ %{}) do
    BankAccount
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          alias: "基本户#{System.unique_integer([:positive])}",
          bank_name: "招商银行",
          holder_name: "测试公司",
          account_no: "#{System.unique_integer([:positive])}",
          company_id: company.id,
          currency_id: currency!().id,
          account_id: ledger_account && ledger_account.id
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp txn!(company, bank_account, attrs) do
    BankTransaction
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          occurred_at: ~U[2026-07-01 10:30:00Z],
          company_id: company.id,
          bank_account_id: bank_account.id
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  # 已审核凭证:lines 形如 [{科目, 借, 贷}, ...](字符串金额)
  defp audited_journal!(company, lines) do
    journal = draft_journal!(company, lines)

    journal
    |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-14]})
    |> Ash.update!(authorize?: false)
  end

  defp draft_journal!(company, lines) do
    journal =
      GlJournal
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        voucher_no: "记-#{System.unique_integer([:positive])}",
        date: ~D[2026-07-14],
        posting_date: ~D[2026-07-14]
      })
      |> Ash.create!(authorize?: false)

    for {{account, debit, credit}, idx} <- Enum.with_index(lines, 1) do
      GlJournalLine
      |> Ash.Changeset.for_create(:create, %{
        journal_id: journal.id,
        idx: idx,
        account_id: account.id,
        debit: Decimal.new(debit),
        credit: Decimal.new(credit)
      })
      |> Ash.create!(authorize?: false)
    end

    journal
  end

  defp link!(txn, journal, amount, opts \\ [authorize?: false]) do
    BankReconciliation
    |> Ash.Changeset.for_create(
      :create,
      %{bank_transaction_id: txn.id, journal_id: journal.id, amount: Decimal.new(amount)},
      opts
    )
    |> Ash.create!()
  end

  defp reload_txn(txn), do: Ash.get!(BankTransaction, txn.id, authorize?: false)

  defp actor(company, permissions) do
    %Actor{
      user_id: Ash.UUID.generate(),
      permissions: MapSet.new(permissions),
      company_ids: [company.id]
    }
  end

  test "关联刷新派生列:部分对账→已对账", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("1000")})
    j1 = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
    j2 = audited_journal!(co, [{b, "600", "0"}, {s, "0", "600"}])

    link!(txn, j1, "400")
    loaded = reload_txn(txn)
    assert Decimal.equal?(loaded.reconciled_amount, Decimal.new("400"))
    assert Decimal.equal?(loaded.unreconciled_amount, Decimal.new("600"))
    assert loaded.reconcile_status == :partial

    link!(txn, j2, "600")
    assert reload_txn(txn).reconcile_status == :reconciled
  end

  test "解除对账后派生列回滚", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("1000")})
    j = audited_journal!(co, [{b, "1000", "0"}, {s, "0", "1000"}])

    link = link!(txn, j, "1000")
    assert reload_txn(txn).reconcile_status == :reconciled

    Ash.destroy!(link, authorize?: false)
    loaded = reload_txn(txn)
    assert Decimal.equal?(loaded.reconciled_amount, 0)
    assert loaded.reconcile_status == :unreconciled
  end

  test "草稿凭证不可对账", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("100")})
    draft = draft_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])

    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, draft, "100") end
    assert Exception.message(err) =~ "已审核"
  end

  test "跨公司凭证被拒", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    other = company!()
    other_b = account!(other, %{code: "1002", name: "银行存款", direction: :debit})
    other_s = account!(other, %{code: "6001", name: "收入", direction: :credit})
    txn = txn!(co, ba, %{income: Decimal.new("100")})
    _ = {b, s}
    j = audited_journal!(other, [{other_b, "100", "0"}, {other_s, "0", "100"}])

    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "100") end
    assert Exception.message(err) =~ "同一公司"
  end

  test "未绑定科目的账户不可对账", %{company: co, bank_acct: b, sales: s} do
    unbound = bank_account!(co, nil)
    txn = txn!(co, unbound, %{income: Decimal.new("100")})
    j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])

    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "100") end
    assert Exception.message(err) =~ "绑定"
  end

  test "方向不匹配被拒:支出流水要求银行科目贷方行", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{expense: Decimal.new("100")})
    j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])

    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "100") end
    assert Exception.message(err) =~ "方向"
  end

  test "超流水未对账金额被拒", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("1000")})
    j1 = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
    j2 = audited_journal!(co, [{b, "700", "0"}, {s, "0", "700"}])

    link!(txn, j1, "400")
    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j2, "700") end
    assert Exception.message(err) =~ "未对账金额"
  end

  test "超凭证侧额度被拒", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn1 = txn!(co, ba, %{income: Decimal.new("300")})
    txn2 = txn!(co, ba, %{income: Decimal.new("300")})
    j = audited_journal!(co, [{b, "500", "0"}, {s, "0", "500"}])

    link!(txn1, j, "300")
    err = assert_raise Ash.Error.Invalid, fn -> link!(txn2, j, "300") end
    assert Exception.message(err) =~ "凭证"
  end

  test "内部转账凭证:两个银行科目额度独立", %{company: co, bank_acct: b, sales: _s} do
    b2 = account!(co, %{code: "1002.2", name: "银行存款二", direction: :debit})
    ba2 = bank_account!(co, b2)
    ba1 = bank_account!(co, b)
    txn_in = txn!(co, ba1, %{income: Decimal.new("500")})
    txn_out = txn!(co, ba2, %{expense: Decimal.new("500")})
    j = audited_journal!(co, [{b, "500", "0"}, {b2, "0", "500"}])

    link!(txn_in, j, "500")
    link!(txn_out, j, "500")
    assert reload_txn(txn_in).reconcile_status == :reconciled
    assert reload_txn(txn_out).reconcile_status == :reconciled
  end

  test "同一对流水-凭证唯一", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("1000")})
    j = audited_journal!(co, [{b, "1000", "0"}, {s, "0", "1000"}])

    link!(txn, j, "300")
    assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "200") end
  end

  test "权限:reconcile 码可建可删,仅 read 不可", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("100")})
    j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])

    writer = actor(co, ["acc.bank_transaction:read", "acc.bank_transaction:reconcile"])
    reader = actor(co, ["acc.bank_transaction:read"])

    link = link!(txn, j, "60", actor: writer)

    assert_raise Ash.Error.Forbidden, fn ->
      link!(txn, audited_journal!(co, [{b, "40", "0"}, {s, "0", "40"}]), "40", actor: reader)
    end

    assert_raise Ash.Error.Forbidden, fn -> Ash.destroy!(link, actor: reader) end
    assert :ok = Ash.destroy!(link, actor: writer)
  end
end
