defmodule SynieCore.Acc.BillLedgerTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{Bill, BankAccount, BillHolding, BillLedger, BillTransaction}
  alias SynieCore.Base.Currency

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    co_a = company!()
    co_b = company!()

    %{
      co_a: co_a,
      co_b: co_b,
      ba_a1: bank_account!(co_a),
      ba_a2: bank_account!(co_a),
      ba_b1: bank_account!(co_b),
      ba_b2: bank_account!(co_b)
    }
  end

  # ------------------------------------------------------------------
  # 夹具
  # ------------------------------------------------------------------

  defp currency! do
    i = System.unique_integer([:positive])
    code = <<?A + rem(div(i, 676), 26), ?A + rem(div(i, 26), 26), ?A + rem(i, 26)>>

    Currency
    |> Ash.Changeset.for_create(:create, %{name: "测试币", iso_code: code})
    |> Ash.create!(authorize?: false)
  end

  defp bank_account!(company, attrs \\ %{}) do
    BankAccount
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          alias: "户#{System.unique_integer([:positive])}",
          bank_name: "招商银行",
          holder_name: "测试公司",
          account_no: "#{System.unique_integer([:positive])}",
          company_id: company.id,
          currency_id: currency!().id
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  # 票据 face 100 元 = 10000 子票,与夹具语境一致
  defp bill!(attrs \\ %{}) do
    Bill
    |> Ash.Changeset.for_create(
      :register,
      Map.merge(
        %{
          bill_no: "HOLD#{System.unique_integer([:positive])}",
          bill_kind: :bank_acceptance,
          due_date: ~D[2026-12-31],
          face_amount: Decimal.new("100")
        },
        attrs
      ),
      authorize?: false
    )
    |> Ash.create!(authorize?: false)
  end

  # 直造已审核交易(不依赖 Task 4 的 audit 动作);status/audited_at 属性层 writable? false,
  # Ash.Seed 绕过动作直写数据层,不受此限制
  defp seed_tx(attrs) do
    defaults = %{status: :audited, audited_at: DateTime.utc_now()}
    Ash.Seed.seed!(BillTransaction, Map.merge(defaults, attrs))
  end

  # 固定基准时间的合成 audited_at,只用于控制测试内的审核先后顺序,与真实时间无关
  defp at(n), do: DateTime.add(~U[2020-01-01 00:00:00.000000Z], n, :second)

  defp holdings_for(bill_id) do
    BillHolding
    |> Ash.Query.filter(bill_id == ^bill_id)
    |> Ash.Query.sort([:sub_start])
    |> Ash.read!(authorize?: false)
  end

  defp holdings_signature(bill_id) do
    bill_id
    |> holdings_for()
    |> Enum.map(
      &Map.take(&1, [
        :company_id,
        :bank_account_id,
        :sub_start,
        :sub_end,
        :amount,
        :acquired_on,
        :source_transaction_id
      ])
    )
  end

  # ------------------------------------------------------------------
  # 用例
  # ------------------------------------------------------------------

  test "接收产生持有段,字段齐全(含 bill_no/due_date 冗余与 amount)", ctx do
    %{co_a: co, ba_a1: ba} = ctx
    bill = bill!()

    tx =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co.id,
        bank_account_id: ba.id,
        bill_id: bill.id,
        transaction_type: :receive,
        occurred_on: ~D[2026-07-01],
        audited_at: at(0),
        sub_start: 1,
        sub_end: 500,
        amount: Decimal.new("5")
      })

    assert :ok = BillLedger.replay!(bill.id)

    assert [holding] = holdings_for(bill.id)
    assert holding.company_id == co.id
    assert holding.bank_account_id == ba.id
    assert holding.bill_id == bill.id
    assert holding.bill_no == bill.bill_no
    assert holding.sub_start == 1
    assert holding.sub_end == 500
    assert Decimal.equal?(holding.amount, Decimal.new("5"))
    assert holding.due_date == bill.due_date
    assert holding.acquired_on == tx.occurred_on
    assert holding.source_transaction_id == tx.id
  end

  test "接收段与既有持有重叠被拒(同公司);跨公司同段重叠同样被拒", ctx do
    %{co_a: co_a, ba_a1: ba_a1, co_b: co_b, ba_b1: ba_b1} = ctx

    bill1 = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co_a.id,
      bank_account_id: ba_a1.id,
      bill_id: bill1.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    tx2 =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co_a.id,
        bank_account_id: ba_a1.id,
        bill_id: bill1.id,
        transaction_type: :receive,
        occurred_on: ~D[2026-07-02],
        audited_at: at(1),
        sub_start: 50,
        sub_end: 150,
        amount: Decimal.new("1.01")
      })

    err1 = assert_raise ArgumentError, fn -> BillLedger.replay!(bill1.id) end
    assert Exception.message(err1) =~ "重叠"
    assert Exception.message(err1) =~ tx2.doc_no

    bill2 = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co_a.id,
      bank_account_id: ba_a1.id,
      bill_id: bill2.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    tx4 =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co_b.id,
        bank_account_id: ba_b1.id,
        bill_id: bill2.id,
        transaction_type: :receive,
        occurred_on: ~D[2026-07-02],
        audited_at: at(1),
        sub_start: 50,
        sub_end: 150,
        amount: Decimal.new("1.01")
      })

    err2 = assert_raise ArgumentError, fn -> BillLedger.replay!(bill2.id) end
    assert Exception.message(err2) =~ "重叠"
    assert Exception.message(err2) =~ tx4.doc_no
  end

  test "转让消耗整段:持有清空", ctx do
    %{co_a: co, ba_a1: ba} = ctx
    bill = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :endorse,
      occurred_on: ~D[2026-07-02],
      audited_at: at(1),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    assert :ok = BillLedger.replay!(bill.id)
    assert holdings_for(bill.id) == []
  end

  test "部分消耗拆段:余段保留原取得日期与来源交易", ctx do
    %{co_a: co, ba_a1: ba} = ctx
    bill = bill!()

    tx1 =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co.id,
        bank_account_id: ba.id,
        bill_id: bill.id,
        transaction_type: :receive,
        occurred_on: ~D[2026-07-01],
        audited_at: at(0),
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1")
      })

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :endorse,
      occurred_on: ~D[2026-07-05],
      audited_at: at(1),
      sub_start: 1,
      sub_end: 40,
      amount: Decimal.new("0.4")
    })

    assert :ok = BillLedger.replay!(bill.id)

    assert [holding] = holdings_for(bill.id)
    assert holding.sub_start == 41
    assert holding.sub_end == 100
    assert holding.acquired_on == tx1.occurred_on
    assert holding.source_transaction_id == tx1.id
  end

  test "横跨两个相邻持有段的消耗成功;中间有空洞被拒(报单号与缺口)", ctx do
    %{co_a: co, ba_a1: ba} = ctx

    bill1 = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill1.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 50,
      amount: Decimal.new("0.5")
    })

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill1.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-02],
      audited_at: at(1),
      sub_start: 51,
      sub_end: 100,
      amount: Decimal.new("0.5")
    })

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill1.id,
      transaction_type: :endorse,
      occurred_on: ~D[2026-07-03],
      audited_at: at(2),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    assert :ok = BillLedger.replay!(bill1.id)
    assert holdings_for(bill1.id) == []

    bill2 = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill2.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 50,
      amount: Decimal.new("0.5")
    })

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill2.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-02],
      audited_at: at(1),
      sub_start: 61,
      sub_end: 100,
      amount: Decimal.new("0.4")
    })

    gap_tx =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co.id,
        bank_account_id: ba.id,
        bill_id: bill2.id,
        transaction_type: :endorse,
        occurred_on: ~D[2026-07-03],
        audited_at: at(2),
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1")
      })

    err = assert_raise ArgumentError, fn -> BillLedger.replay!(bill2.id) end
    assert Exception.message(err) =~ gap_tx.doc_no
    assert Exception.message(err) =~ "51-60"
  end

  test "消耗他人账户/他公司的段被拒", ctx do
    %{co_a: co_a, ba_a1: ba_a1, ba_a2: ba_a2, co_b: co_b, ba_b1: ba_b1} = ctx

    bill1 = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co_a.id,
      bank_account_id: ba_a1.id,
      bill_id: bill1.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    wrong_account_tx =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co_a.id,
        bank_account_id: ba_a2.id,
        bill_id: bill1.id,
        transaction_type: :endorse,
        occurred_on: ~D[2026-07-02],
        audited_at: at(1),
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1")
      })

    err1 = assert_raise ArgumentError, fn -> BillLedger.replay!(bill1.id) end
    assert Exception.message(err1) =~ wrong_account_tx.doc_no
    assert Exception.message(err1) =~ "并未持有"

    bill2 = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co_a.id,
      bank_account_id: ba_a1.id,
      bill_id: bill2.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    wrong_company_tx =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co_b.id,
        bank_account_id: ba_b1.id,
        bill_id: bill2.id,
        transaction_type: :endorse,
        occurred_on: ~D[2026-07-02],
        audited_at: at(1),
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1")
      })

    err2 = assert_raise ArgumentError, fn -> BillLedger.replay!(bill2.id) end
    assert Exception.message(err2) =~ wrong_company_tx.doc_no
    assert Exception.message(err2) =~ "并未持有"
  end

  test "倒填日期:先审 7-10 接收,再审 7-01 转让同段 → replay 报「该段当时未持有」", ctx do
    %{co_a: co, ba_a1: ba} = ctx
    bill = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-10],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    late_tx =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co.id,
        bank_account_id: ba.id,
        bill_id: bill.id,
        transaction_type: :endorse,
        occurred_on: ~D[2026-07-01],
        audited_at: at(1),
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1")
      })

    err = assert_raise ArgumentError, fn -> BillLedger.replay!(bill.id) end
    assert Exception.message(err) =~ late_tx.doc_no
    assert Exception.message(err) =~ "并未持有"
  end

  test "同日接收+转让按 audited_at 定序通过", ctx do
    %{co_a: co, ba_a1: ba} = ctx
    bill = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :endorse,
      occurred_on: ~D[2026-07-01],
      audited_at: at(1),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    assert :ok = BillLedger.replay!(bill.id)
    assert holdings_for(bill.id) == []
  end

  test "调拨:转出账户段迁到转入账户,取得日期=调拨发生日", ctx do
    %{co_a: co, ba_a1: from_ba, ba_a2: to_ba} = ctx
    bill = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: from_ba.id,
      bill_id: bill.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    realloc_tx =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co.id,
        bank_account_id: from_ba.id,
        to_bank_account_id: to_ba.id,
        bill_id: bill.id,
        transaction_type: :reallocate,
        occurred_on: ~D[2026-07-05],
        audited_at: at(1),
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1")
      })

    assert :ok = BillLedger.replay!(bill.id)

    assert [holding] = holdings_for(bill.id)
    assert holding.bank_account_id == to_ba.id
    assert holding.acquired_on == realloc_tx.occurred_on
    assert holding.source_transaction_id == realloc_tx.id
  end

  test "作废模拟:seed 三笔(收→转→收),把中间转让改回 draft 后 replay,持有恢复", ctx do
    %{co_a: co, ba_a1: ba} = ctx
    bill = bill!()

    t1 =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co.id,
        bank_account_id: ba.id,
        bill_id: bill.id,
        transaction_type: :receive,
        occurred_on: ~D[2026-07-01],
        audited_at: at(0),
        sub_start: 1,
        sub_end: 50,
        amount: Decimal.new("0.5")
      })

    t2 =
      seed_tx(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co.id,
        bank_account_id: ba.id,
        bill_id: bill.id,
        transaction_type: :endorse,
        occurred_on: ~D[2026-07-02],
        audited_at: at(1),
        sub_start: 1,
        sub_end: 50,
        amount: Decimal.new("0.5")
      })

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-03],
      audited_at: at(2),
      sub_start: 51,
      sub_end: 100,
      amount: Decimal.new("0.5")
    })

    assert :ok = BillLedger.replay!(bill.id)
    assert [holding] = holdings_for(bill.id)
    assert holding.sub_start == 51

    Ash.Seed.update!(t2, %{status: :draft})

    assert :ok = BillLedger.replay!(bill.id)
    holdings = holdings_for(bill.id)
    assert length(holdings) == 2
    assert Enum.map(holdings, & &1.sub_start) == [1, 51]

    restored = Enum.find(holdings, &(&1.sub_start == 1))
    assert restored.source_transaction_id == t1.id
    assert restored.acquired_on == t1.occurred_on
  end

  test "replay 整建幂等:连续两次 replay 结果一致", ctx do
    %{co_a: co, ba_a1: ba} = ctx
    bill = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1")
    })

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :endorse,
      occurred_on: ~D[2026-07-02],
      audited_at: at(1),
      sub_start: 1,
      sub_end: 40,
      amount: Decimal.new("0.4")
    })

    assert :ok = BillLedger.replay!(bill.id)
    snapshot1 = holdings_signature(bill.id)

    assert :ok = BillLedger.replay!(bill.id)
    snapshot2 = holdings_signature(bill.id)

    assert snapshot1 == snapshot2
    assert snapshot1 != []
  end

  test "label 拼串含票号/段/金额", ctx do
    %{co_a: co, ba_a1: ba} = ctx
    bill = bill!()

    seed_tx(%{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      bill_id: bill.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      audited_at: at(0),
      sub_start: 1,
      sub_end: 500,
      amount: Decimal.new("5")
    })

    assert :ok = BillLedger.replay!(bill.id)

    [holding] =
      BillHolding
      |> Ash.Query.filter(bill_id == ^bill.id)
      |> Ash.Query.load(:label)
      |> Ash.read!(authorize?: false)

    expected =
      "#{holding.bill_no} #{holding.sub_start}-#{holding.sub_end} ¥#{holding.amount} 到期#{holding.due_date}"

    assert holding.label == expected
    assert holding.label =~ bill.bill_no
    assert holding.label =~ "1-500"
    assert holding.label =~ "¥"
    assert holding.label =~ Date.to_string(bill.due_date)
  end
end
