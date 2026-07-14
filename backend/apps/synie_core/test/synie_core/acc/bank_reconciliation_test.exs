defmodule SynieCore.Acc.BankReconciliationTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{
    BankAccount,
    BankReconciliation,
    BankTransaction,
    GlEntry,
    GlJournal,
    GlJournalLine
  }

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

  describe "反向约束" do
    test "已对账凭证不可取消,解除后可以", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("100")})
      j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])
      link = link!(txn, j, "100")

      err =
        assert_raise Ash.Error.Invalid, fn ->
          j |> Ash.Changeset.for_update(:cancel, %{}) |> Ash.update!(authorize?: false)
        end

      assert Exception.message(err) =~ "解除对账"

      Ash.destroy!(link, authorize?: false)

      cancelled = j |> Ash.Changeset.for_update(:cancel, %{}) |> Ash.update!(authorize?: false)
      assert cancelled.status == :cancelled
    end

    test "已对账流水禁删、金额不得低于已对账、禁换边", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("1000")})
      j = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
      link!(txn, j, "400")
      txn = reload_txn(txn)

      assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(txn, authorize?: false) end

      err =
        assert_raise Ash.Error.Invalid, fn ->
          txn
          |> Ash.Changeset.for_update(:update, %{income: Decimal.new("300")})
          |> Ash.update!(authorize?: false)
        end

      assert Exception.message(err) =~ "已对账金额"

      assert_raise Ash.Error.Invalid, fn ->
        txn
        |> Ash.Changeset.for_update(:update, %{income: nil, expense: Decimal.new("1000")})
        |> Ash.update!(authorize?: false)
      end
    end

    test "上调金额后派生列同步刷新", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("400")})
      j = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
      link!(txn, j, "400")
      assert reload_txn(txn).reconcile_status == :reconciled

      updated =
        reload_txn(txn)
        |> Ash.Changeset.for_update(:update, %{income: Decimal.new("1000")})
        |> Ash.update!(authorize?: false)

      assert updated.reconcile_status == :partial
      assert Decimal.equal?(updated.unreconciled_amount, Decimal.new("600"))
    end

    test "无对账的流水删除/换边不受影响", %{company: co, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("100")})

      swapped =
        txn
        |> Ash.Changeset.for_update(:update, %{income: nil, expense: Decimal.new("80")})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(swapped.unreconciled_amount, Decimal.new("80"))
      assert :ok = Ash.destroy!(swapped, authorize?: false)
    end
  end

  describe "quick_create 快速凭证对账" do
    defp numbering_rule! do
      SynieCore.Numbering.Rule
      |> Ash.Changeset.for_create(
        :create,
        %{
          resource: "acc.gl_journal",
          name: "记账凭证",
          segments: [%{"type" => "text", "value" => "记"}, %{"type" => "seq", "padding" => 4}]
        },
        authorize?: false
      )
      |> Ash.create!()
    end

    defp quick!(txn, counter_account, amount, opts) do
      BankReconciliation
      |> Ash.Changeset.for_create(
        :quick_create,
        %{
          bank_transaction_id: txn.id,
          counter_account_id: counter_account.id,
          amount: Decimal.new(amount),
          summary: "货款",
          posting_date: ~D[2026-07-14]
        },
        opts
      )
      |> Ash.create!()
    end

    # user_id 须指向真实 sys_user 行:凭证 :create 动作会把 actor.user_id 落 created_by_id(FK)
    defp full_actor(co) do
      %{actor(co, ["acc.bank_transaction:*", "acc.gl_journal:*"]) | user_id: user!().id}
    end

    test "成功:凭证自动创建+审核+过账+关联", %{company: co, sales: s, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{income: Decimal.new("1000")})

      rec = quick!(txn, s, "1000", actor: full_actor(co))

      journal = Ash.get!(GlJournal, rec.journal_id, authorize?: false)
      assert journal.status == :audited
      assert journal.remarks == "货款"

      entries =
        GlEntry
        |> Ash.Query.filter(voucher_id == ^journal.id)
        |> Ash.read!(authorize?: false)

      assert length(entries) == 2
      assert reload_txn(txn).reconcile_status == :reconciled
    end

    test "支出流水方向反转:银行科目在贷方", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{expense: Decimal.new("200")})

      rec = quick!(txn, s, "200", actor: full_actor(co))

      lines =
        GlJournalLine
        |> Ash.Query.filter(journal_id == ^rec.journal_id)
        |> Ash.read!(authorize?: false)

      bank_line = Enum.find(lines, &(&1.account_id == b.id))
      assert Decimal.compare(bank_line.credit, 0) == :gt
    end

    test "缺凭证权限整体回滚", %{company: co, sales: s, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{income: Decimal.new("100")})
      bank_only = actor(co, ["acc.bank_transaction:*"])

      try do
        quick!(txn, s, "100", actor: bank_only)
        flunk("应当因缺少凭证权限而失败")
      rescue
        e in [Ash.Error.Forbidden, Ash.Error.Invalid, Ash.Error.Unknown] -> {:ok, e}
      end

      assert [] = Ash.read!(GlJournal, authorize?: false)
      assert [] = Ash.read!(BankReconciliation, authorize?: false)
      assert reload_txn(txn).reconcile_status == :unreconciled
    end

    test "汇总科目做对方科目整体回滚", %{company: co, sales: _s, bank_account: ba} do
      numbering_rule!()
      group = account!(co, %{code: "9001", name: "汇总", direction: :credit, is_group: true})
      txn = txn!(co, ba, %{income: Decimal.new("100")})

      assert_raise Ash.Error.Invalid, fn ->
        quick!(txn, group, "100", actor: full_actor(co))
      end

      assert [] = Ash.read!(GlJournal, authorize?: false)
    end

    test "超流水未对账余额被拒", %{company: co, sales: s, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{income: Decimal.new("100")})

      err =
        assert_raise Ash.Error.Invalid, fn ->
          quick!(txn, s, "200", actor: full_actor(co))
        end

      assert Exception.message(err) =~ "未对账金额"
    end

    test "对方科目为银行绑定科目整体回滚", %{company: co, bank_acct: b, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{income: Decimal.new("100")})

      err =
        assert_raise Ash.Error.Invalid, fn ->
          # b 即 ba 绑定的银行科目,借银行/贷银行自旋无对账语义
          quick!(txn, b, "100", actor: full_actor(co))
        end

      assert Exception.message(err) =~ "对方科目"
      assert [] = Ash.read!(GlJournal, authorize?: false)
    end
  end

  describe "remaining 剩余额度查询" do
    test "取流水/凭证双侧剩余的较小值", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("1000")})
      j = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
      reader = actor(co, ["acc.bank_transaction:*", "acc.gl_journal:read"])

      remaining =
        BankReconciliation
        |> Ash.ActionInput.for_action(:remaining, %{
          bank_transaction_id: txn.id,
          journal_id: j.id
        })
        |> Ash.run_action!(actor: reader)

      assert Decimal.equal?(remaining, Decimal.new("400"))

      link!(txn, j, "150")

      remaining2 =
        BankReconciliation
        |> Ash.ActionInput.for_action(:remaining, %{
          bank_transaction_id: txn.id,
          journal_id: j.id
        })
        |> Ash.run_action!(actor: reader)

      assert Decimal.equal?(remaining2, Decimal.new("250"))
    end
  end

  describe "科目绑定漂移防护" do
    test "已对账流水禁止更换银行账户,解除后可改", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      other_acct = account!(co, %{code: "1002.9", name: "银行存款九", direction: :debit})
      other_ba = bank_account!(co, other_acct)
      txn = txn!(co, ba, %{income: Decimal.new("500")})
      j = audited_journal!(co, [{b, "500", "0"}, {s, "0", "500"}])
      link = link!(txn, j, "500")
      txn = reload_txn(txn)

      err =
        assert_raise Ash.Error.Invalid, fn ->
          txn
          |> Ash.Changeset.for_update(:update, %{bank_account_id: other_ba.id})
          |> Ash.update!(authorize?: false)
        end

      assert Exception.message(err) =~ "更换银行账户"

      Ash.destroy!(link, authorize?: false)

      updated =
        reload_txn(txn)
        |> Ash.Changeset.for_update(:update, %{bank_account_id: other_ba.id})
        |> Ash.update!(authorize?: false)

      assert updated.bank_account_id == other_ba.id
    end

    test "账户有对账记录时禁止改绑/解绑科目,解除后可改", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      another = account!(co, %{code: "1002.8", name: "银行存款八", direction: :debit})
      txn = txn!(co, ba, %{income: Decimal.new("300")})
      j = audited_journal!(co, [{b, "300", "0"}, {s, "0", "300"}])
      link = link!(txn, j, "300")

      err =
        assert_raise Ash.Error.Invalid, fn ->
          ba
          |> Ash.Changeset.for_update(:update, %{account_id: another.id})
          |> Ash.update!(authorize?: false)
        end

      assert Exception.message(err) =~ "绑定科目"

      # 解绑(置 nil)同样被拒
      assert_raise Ash.Error.Invalid, fn ->
        ba
        |> Ash.Changeset.for_update(:update, %{account_id: nil})
        |> Ash.update!(authorize?: false)
      end

      Ash.destroy!(link, authorize?: false)

      rebound =
        ba
        |> Ash.Changeset.for_update(:update, %{account_id: another.id})
        |> Ash.update!(authorize?: false)

      assert rebound.account_id == another.id
    end

    test "无对账记录的账户改绑科目不受影响", %{company: co, bank_account: ba} do
      another = account!(co, %{code: "1002.7", name: "银行存款七", direction: :debit})

      rebound =
        ba
        |> Ash.Changeset.for_update(:update, %{account_id: another.id})
        |> Ash.update!(authorize?: false)

      assert rebound.account_id == another.id
    end
  end

  describe "权限负向" do
    test "跨公司 actor 建对账被拒", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("100")})
      j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])
      # 有 reconcile 码但 company_ids 不含流水公司 → CompanyAccessible 判 Invalid
      other = company!()
      cross = actor(other, ["acc.bank_transaction:read", "acc.bank_transaction:reconcile"])

      err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "100", actor: cross) end
      assert Exception.message(err) =~ "公司"
    end

    test "缺 reconcile 码 quick_create 被拒", %{company: co, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("100")})
      no_reconcile = actor(co, ["acc.bank_transaction:read", "acc.gl_journal:*"])

      assert_raise Ash.Error.Forbidden, fn ->
        quick!(txn, s, "100", actor: no_reconcile)
      end
    end

    test "缺 read 码 remaining 被拒", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("100")})
      j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])
      no_read = actor(co, ["acc.bank_transaction:reconcile"])

      assert_raise Ash.Error.Forbidden, fn ->
        BankReconciliation
        |> Ash.ActionInput.for_action(:remaining, %{bank_transaction_id: txn.id, journal_id: j.id})
        |> Ash.run_action!(actor: no_read)
      end
    end
  end
end
