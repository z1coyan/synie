defmodule SynieCore.Acc.BillTransactionTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{Bill, BankAccount, BillHolding, BillTransaction, GlEntry}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.{Account, Currency}
  alias SynieCore.Sales.Customer

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    bank_account = bank_account!(company)
    to_account = bank_account!(company)
    customer = customer!()
    bill = register_bill!()

    accounts = %{
      bill: account!(%{code: "1121", name: "应收票据", direction: :debit, company_id: company.id}),
      settle: account!(%{code: "1002", name: "银行存款", direction: :debit, company_id: company.id}),
      interest: account!(%{code: "6603", name: "财务费用", direction: :debit, company_id: company.id})
    }

    %{
      company: company,
      bank_account: bank_account,
      to_account: to_account,
      customer: customer,
      bill: bill,
      accounts: accounts,
      actor: actor(company_ids: [company.id])
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

  defp customer!(attrs \\ %{}) do
    attrs = Map.merge(%{code: "C#{System.unique_integer([:positive])}", name: "测试客户"}, attrs)

    Customer
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp register_bill!(attrs \\ %{}) do
    Bill
    |> Ash.Changeset.for_create(
      :register,
      Map.merge(
        %{
          bill_no: "BILL#{System.unique_integer([:positive])}",
          bill_kind: :bank_acceptance,
          due_date: ~D[2026-12-31],
          face_amount: Decimal.new("10000")
        },
        attrs
      ),
      authorize?: false
    )
    |> Ash.create!(authorize?: false)
  end

  defp account!(attrs) do
    Account
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # created_by_id 是真外键(sys_user),actor.user_id 须落在一个真实存在的用户上,
  # 不能像无 created_by 字段的资源那样随手生成一个不存在的 UUID
  defp actor(overrides) do
    struct!(
      %Actor{
        user_id: user!().id,
        permissions: MapSet.new(["acc.bill_transaction:*", "acc.bill:*"])
      },
      overrides
    )
  end

  defp txn!(attrs, opts) do
    BillTransaction
    |> Ash.Changeset.for_create(:create, attrs, opts)
    |> Ash.create!(opts)
  end

  # posting_date 为 nil(调拨)时不传该输入,照实现 accept [:posting_date] 的留空契约
  defp audit!(tx, posting_date, actor) do
    input = if posting_date, do: %{posting_date: posting_date}, else: %{}

    tx
    |> Ash.Changeset.for_update(:audit, input, actor: actor)
    |> Ash.update!()
  end

  defp void!(tx, actor) do
    tx
    |> Ash.Changeset.for_update(:void, %{}, actor: actor)
    |> Ash.update!()
  end

  defp entries_for(voucher_type, voucher_id) do
    GlEntry
    |> Ash.Query.filter(voucher_type == ^voucher_type and voucher_id == ^voucher_id)
    |> Ash.read!(authorize?: false)
  end

  defp holdings_for(bill_id) do
    BillHolding
    |> Ash.Query.filter(bill_id == ^bill_id)
    |> Ash.Query.sort([:sub_start])
    |> Ash.read!(authorize?: false)
  end

  # 默认接收交易(带对手),覆盖字段按测试场景传 overrides
  defp base_attrs(%{company: co, bank_account: ba, bill: bill, customer: cust}, overrides \\ %{}) do
    Map.merge(
      %{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        company_id: co.id,
        bank_account_id: ba.id,
        bill_id: bill.id,
        transaction_type: :receive,
        occurred_on: ~D[2026-07-01],
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1"),
        party_type: :customer,
        party_id: cust.id
      },
      overrides
    )
  end

  # ------------------------------------------------------------------
  # 用例
  # ------------------------------------------------------------------

  test "接收带 bill_attrs 建档并挂接;再录同票号第二段自动挂既有票", ctx do
    %{company: co, bank_account: ba, customer: cust, actor: act} = ctx
    bill_no = "NEWBILL#{System.unique_integer([:positive])}"

    attrs1 = %{
      doc_no: "BT-#{System.unique_integer([:positive])}",
      company_id: co.id,
      bank_account_id: ba.id,
      transaction_type: :receive,
      occurred_on: ~D[2026-07-01],
      sub_start: 1,
      sub_end: 100,
      amount: Decimal.new("1"),
      party_type: :customer,
      party_id: cust.id,
      bill_attrs: %{
        "bill_no" => bill_no,
        "bill_kind" => :bank_acceptance,
        "due_date" => ~D[2026-12-31],
        "face_amount" => Decimal.new("10000")
      }
    }

    txn1 = txn!(attrs1, actor: act)
    assert txn1.bill_id != nil

    bill = Ash.get!(Bill, txn1.bill_id, authorize?: false)
    assert bill.bill_no == bill_no
    assert Decimal.equal?(bill.face_amount, Decimal.new("10000"))

    # 再录同票号第二段:仍传相同 bill_attrs,自动挂接既有票(不新建、票面以首录为准)
    attrs2 =
      attrs1
      |> Map.merge(%{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        sub_start: 101,
        sub_end: 200
      })

    txn2 = txn!(attrs2, actor: act)
    assert txn2.bill_id == txn1.bill_id
  end

  test "接收缺 bill_id 又缺 bill_attrs 被拒;bill_attrs 缺票号/种类/到期日/金额被拒(中文报错)", ctx do
    %{actor: act} = ctx
    base = base_attrs(ctx) |> Map.delete(:bill_id)

    error1 = assert_raise Ash.Error.Invalid, fn -> txn!(base, actor: act) end
    assert Exception.message(error1) =~ "票据"

    incomplete =
      Map.put(base, :bill_attrs, %{"bill_no" => "ONLYNO#{System.unique_integer([:positive])}"})

    error2 = assert_raise Ash.Error.Invalid, fn -> txn!(incomplete, actor: act) end
    assert Exception.message(error2) =~ "建档失败"

    # 非接收类型必须传 bill_id
    non_receive =
      base_attrs(ctx, %{transaction_type: :settle})
      |> Map.delete(:bill_id)
      |> Map.delete(:party_type)
      |> Map.delete(:party_id)

    error3 = assert_raise Ash.Error.Invalid, fn -> txn!(non_receive, actor: act) end
    assert Exception.message(error3) =~ "票据"
  end

  test "勾稽:sub_end−sub_start+1 ≠ amount×100 被拒;段越出 [1, face×100] 被拒;amount ≤ 0 被拒", ctx do
    %{actor: act} = ctx

    err1 =
      assert_raise Ash.Error.Invalid, fn ->
        txn!(base_attrs(ctx, %{sub_start: 1, sub_end: 99, amount: Decimal.new("1")}), actor: act)
      end

    assert Exception.message(err1) =~ "子票止必须等于"

    # face_amount = 10000 → 最大子票号 = 1_000_000
    err2 =
      assert_raise Ash.Error.Invalid, fn ->
        txn!(
          base_attrs(ctx, %{sub_start: 1_000_001, sub_end: 1_000_100, amount: Decimal.new("1")}),
          actor: act
        )
      end

    assert Exception.message(err2) =~ "超出票据包范围"

    err3 =
      assert_raise Ash.Error.Invalid, fn ->
        txn!(base_attrs(ctx, %{sub_start: 1, sub_end: 100, amount: Decimal.new("0")}), actor: act)
      end

    assert Exception.message(err3) =~ "必须大于零"
  end

  test "类型-字段矩阵:接收/转让必填对手,兑付/贴现/调拨对手必须为空", ctx do
    %{to_account: to_ba, customer: cust, actor: act} = ctx

    for type <- [:receive, :endorse] do
      err =
        assert_raise Ash.Error.Invalid, fn ->
          txn!(
            base_attrs(ctx, %{transaction_type: type})
            |> Map.delete(:party_type)
            |> Map.delete(:party_id),
            actor: act
          )
        end

      assert Exception.message(err) =~ "接收/转让必须选择交易对手"
    end

    settle_attrs =
      base_attrs(ctx, %{
        transaction_type: :settle,
        party_type: :customer,
        party_id: cust.id
      })

    err_settle = assert_raise Ash.Error.Invalid, fn -> txn!(settle_attrs, actor: act) end
    assert Exception.message(err_settle) =~ "该交易类型不填交易对手"

    discount_attrs =
      base_attrs(ctx, %{
        transaction_type: :discount,
        party_type: :customer,
        party_id: cust.id,
        discount_org: "工商银行",
        discount_rate: Decimal.new("3"),
        interest: Decimal.new("0"),
        net_amount: Decimal.new("1")
      })

    err_discount = assert_raise Ash.Error.Invalid, fn -> txn!(discount_attrs, actor: act) end
    assert Exception.message(err_discount) =~ "该交易类型不填交易对手"

    reallocate_attrs =
      base_attrs(ctx, %{
        transaction_type: :reallocate,
        party_type: :customer,
        party_id: cust.id,
        to_bank_account_id: to_ba.id
      })

    err_reallocate = assert_raise Ash.Error.Invalid, fn -> txn!(reallocate_attrs, actor: act) end
    assert Exception.message(err_reallocate) =~ "该交易类型不填交易对手"
  end

  test "类型-字段矩阵:贴现必填 discount_org/rate/interest/net_amount 且 amount=interest+net;非贴现四字段必须为空",
       ctx do
    %{actor: act} = ctx

    base =
      base_attrs(ctx, %{
        transaction_type: :discount,
        sub_start: 1,
        sub_end: 1000,
        amount: Decimal.new("10")
      })
      |> Map.delete(:party_type)
      |> Map.delete(:party_id)

    err1 = assert_raise Ash.Error.Invalid, fn -> txn!(base, actor: act) end
    assert Exception.message(err1) =~ "贴现"

    bad_sum =
      Map.merge(base, %{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        discount_org: "工商银行",
        discount_rate: Decimal.new("3"),
        interest: Decimal.new("1"),
        net_amount: Decimal.new("8")
      })

    err2 = assert_raise Ash.Error.Invalid, fn -> txn!(bad_sum, actor: act) end
    assert Exception.message(err2) =~ "贴现金额必须等于利息+实收金额"

    ok_attrs =
      Map.merge(base, %{
        doc_no: "BT-#{System.unique_integer([:positive])}",
        discount_org: "工商银行",
        discount_rate: Decimal.new("3"),
        interest: Decimal.new("2"),
        net_amount: Decimal.new("8")
      })

    txn = txn!(ok_attrs, actor: act)
    assert txn.transaction_type == :discount

    settle_with_discount =
      base_attrs(ctx, %{
        transaction_type: :settle,
        sub_start: 1,
        sub_end: 100,
        amount: Decimal.new("1"),
        discount_org: "工商银行"
      })
      |> Map.delete(:party_type)
      |> Map.delete(:party_id)

    err3 = assert_raise Ash.Error.Invalid, fn -> txn!(settle_with_discount, actor: act) end
    assert Exception.message(err3) =~ "非贴现交易不填"
  end

  test "类型-字段矩阵:调拨必填 to_bank_account_id(同公司/启用/≠转出账户);非调拨必须为空", ctx do
    %{bank_account: ba, to_account: to_ba, customer: cust, actor: act} = ctx

    base =
      base_attrs(ctx, %{transaction_type: :reallocate})
      |> Map.delete(:party_type)
      |> Map.delete(:party_id)

    err1 = assert_raise Ash.Error.Invalid, fn -> txn!(base, actor: act) end
    assert Exception.message(err1) =~ "必须选择转入账户"

    err2 =
      assert_raise Ash.Error.Invalid, fn ->
        txn!(
          Map.merge(base, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            to_bank_account_id: ba.id
          }),
          actor: act
        )
      end

    assert Exception.message(err2) =~ "转入账户不能与转出账户相同"

    other_ba = bank_account!(company!())

    err3 =
      assert_raise Ash.Error.Invalid, fn ->
        txn!(
          Map.merge(base, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            to_bank_account_id: other_ba.id
          }),
          actor: act
        )
      end

    assert Exception.message(err3) =~ "必须属于同一公司"

    ok =
      txn!(
        Map.merge(base, %{
          doc_no: "BT-#{System.unique_integer([:positive])}",
          to_bank_account_id: to_ba.id
        }),
        actor: act
      )

    assert ok.to_bank_account_id == to_ba.id

    receive_with_to =
      base_attrs(ctx, %{
        transaction_type: :receive,
        party_type: :customer,
        party_id: cust.id,
        to_bank_account_id: to_ba.id
      })

    err4 = assert_raise Ash.Error.Invalid, fn -> txn!(receive_with_to, actor: act) end
    assert Exception.message(err4) =~ "该交易类型不填转入账户"
  end

  test "银行账户:同公司校验;停用账户 create 被拒", ctx do
    %{company: co, actor: act} = ctx

    other_ba = bank_account!(company!())

    err1 =
      assert_raise Ash.Error.Invalid, fn ->
        txn!(base_attrs(ctx, %{bank_account_id: other_ba.id}), actor: act)
      end

    assert Exception.message(err1) =~ "必须属于同一公司"

    disabled = bank_account!(co, %{active: false})

    err2 =
      assert_raise Ash.Error.Invalid, fn ->
        txn!(base_attrs(ctx, %{bank_account_id: disabled.id}), actor: act)
      end

    assert Exception.message(err2) =~ "停用账户不能新增流水"
  end

  test "transaction_type 建后不可改(update 不收);仅草稿可改可删", ctx do
    %{company: co, bank_account: ba, bill: bill, customer: cust, actor: act} = ctx

    txn = txn!(base_attrs(ctx), actor: act)

    # transaction_type 不在 update 的 accept 列表内,传入即被拒绝(改不动)
    assert_raise Ash.Error.Invalid, fn ->
      txn
      |> Ash.Changeset.for_update(:update, %{transaction_type: :endorse}, actor: act)
      |> Ash.update!()
    end

    updated =
      txn
      |> Ash.Changeset.for_update(:update, %{remarks: "备注"}, actor: act)
      |> Ash.update!()

    assert updated.transaction_type == :receive
    assert updated.remarks == "备注"

    audited =
      Ash.Seed.seed!(
        BillTransaction,
        %{
          doc_no: "BT-#{System.unique_integer([:positive])}",
          company_id: co.id,
          bank_account_id: ba.id,
          bill_id: bill.id,
          transaction_type: :receive,
          occurred_on: ~D[2026-07-01],
          sub_start: 201,
          sub_end: 300,
          amount: Decimal.new("1"),
          party_type: :customer,
          party_id: cust.id,
          status: :audited
        }
      )

    assert_raise Ash.Error.Invalid, fn ->
      audited
      |> Ash.Changeset.for_update(:update, %{remarks: "x"}, actor: act)
      |> Ash.update!()
    end

    assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(audited, actor: act) end
    assert :ok = Ash.destroy!(txn, actor: act)
  end

  test "update 置空 bill_id 被拒", ctx do
    %{actor: act} = ctx

    txn = txn!(base_attrs(ctx), actor: act)

    error =
      assert_raise Ash.Error.Invalid, fn ->
        txn
        |> Ash.Changeset.for_update(:update, %{bill_id: nil}, actor: act)
        |> Ash.update!()
      end

    assert Exception.message(error) =~ "交易必须关联票据"

    # 改挂到另一张票仍然允许(bill_id 保留在 accept 内)
    other_bill = register_bill!()

    updated =
      txn
      |> Ash.Changeset.for_update(:update, %{bill_id: other_bill.id}, actor: act)
      |> Ash.update!()

    assert updated.bill_id == other_bill.id
  end

  test "读取按公司范围过滤 fail-closed", ctx do
    %{company: co, actor: act} = ctx

    txn!(base_attrs(ctx), actor: act)

    in_scope = actor(company_ids: [co.id])
    out_scope = actor([])

    assert [_] = Ash.read!(BillTransaction, actor: in_scope)
    assert [] = Ash.read!(BillTransaction, actor: out_scope)
  end

  # ------------------------------------------------------------------
  # 审核过账与库存
  # ------------------------------------------------------------------

  describe "审核过账与库存" do
    test "接收审核:借票据科目/贷结算科目(带对手)两行配平;持有段生成", ctx do
      %{customer: cust, accounts: accts, bill: bill, bank_account: ba, actor: act} = ctx

      txn =
        txn!(
          base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
          actor: act
        )

      audited = audit!(txn, ~D[2026-07-15], act)
      assert audited.status == :audited
      assert audited.audited_at != nil
      assert audited.audited_by_id == act.user_id

      entries = entries_for("acc.bill_transaction", txn.id)
      assert length(entries) == 2

      bill_line = Enum.find(entries, &(&1.account_id == accts.bill.id))
      settle_line = Enum.find(entries, &(&1.account_id == accts.settle.id))

      assert Decimal.equal?(bill_line.debit, txn.amount)
      assert Decimal.equal?(bill_line.credit, Decimal.new("0"))
      assert bill_line.party_id == nil

      assert Decimal.equal?(settle_line.debit, Decimal.new("0"))
      assert Decimal.equal?(settle_line.credit, txn.amount)
      assert settle_line.party_type == :customer
      assert settle_line.party_id == cust.id

      assert [holding] = holdings_for(bill.id)
      assert holding.bank_account_id == ba.id
      assert holding.sub_start == txn.sub_start
      assert holding.sub_end == txn.sub_end
    end

    test "转让审核:借结算(带对手)/贷票据;原持有段消耗", ctx do
      %{customer: cust, accounts: accts, bill: bill, actor: act} = ctx

      txn!(
        base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      endorse_tx =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :endorse,
            occurred_on: ~D[2026-07-10],
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          }),
          actor: act
        )

      audited = audit!(endorse_tx, ~D[2026-07-10], act)
      assert audited.status == :audited

      entries = entries_for("acc.bill_transaction", endorse_tx.id)
      assert length(entries) == 2

      settle_line = Enum.find(entries, &(&1.account_id == accts.settle.id))
      bill_line = Enum.find(entries, &(&1.account_id == accts.bill.id))

      assert Decimal.equal?(settle_line.debit, endorse_tx.amount)
      assert Decimal.equal?(settle_line.credit, Decimal.new("0"))
      assert settle_line.party_type == :customer
      assert settle_line.party_id == cust.id

      assert Decimal.equal?(bill_line.debit, Decimal.new("0"))
      assert Decimal.equal?(bill_line.credit, endorse_tx.amount)
      assert bill_line.party_id == nil

      assert holdings_for(bill.id) == []
    end

    test "兑付审核:借结算(银行存款)/贷票据;无对手行", ctx do
      %{accounts: accts, bill: bill, actor: act} = ctx

      txn!(
        base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      settle_tx =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :settle,
            occurred_on: bill.due_date,
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      audited = audit!(settle_tx, bill.due_date, act)
      assert audited.status == :audited

      entries = entries_for("acc.bill_transaction", settle_tx.id)
      assert length(entries) == 2
      assert Enum.all?(entries, &is_nil(&1.party_id))

      settle_line = Enum.find(entries, &(&1.account_id == accts.settle.id))
      bill_line = Enum.find(entries, &(&1.account_id == accts.bill.id))

      assert Decimal.equal?(settle_line.debit, settle_tx.amount)
      assert Decimal.equal?(settle_line.credit, Decimal.new("0"))

      assert Decimal.equal?(bill_line.debit, Decimal.new("0"))
      assert Decimal.equal?(bill_line.credit, settle_tx.amount)

      assert holdings_for(bill.id) == []
    end

    test "贴现审核:借结算 net + 借利息 interest / 贷票据 amount 三行;利息为 0 只两行", ctx do
      %{accounts: accts, actor: act} = ctx

      txn!(
        base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      discount_tx =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :discount,
            occurred_on: ~D[2026-07-10],
            amount: Decimal.new("1"),
            discount_org: "工商银行",
            discount_rate: Decimal.new("3"),
            interest: Decimal.new("0.1"),
            net_amount: Decimal.new("0.9"),
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id,
            interest_account_id: accts.interest.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      audited = audit!(discount_tx, ~D[2026-07-10], act)
      assert audited.status == :audited

      entries = entries_for("acc.bill_transaction", discount_tx.id)
      assert length(entries) == 3

      settle_line = Enum.find(entries, &(&1.account_id == accts.settle.id))
      interest_line = Enum.find(entries, &(&1.account_id == accts.interest.id))
      bill_line = Enum.find(entries, &(&1.account_id == accts.bill.id))

      assert Decimal.equal?(settle_line.debit, Decimal.new("0.9"))
      assert Decimal.equal?(interest_line.debit, Decimal.new("0.1"))
      assert Decimal.equal?(bill_line.credit, Decimal.new("1"))

      debit_total = Enum.reduce(entries, Decimal.new(0), &Decimal.add(&1.debit, &2))
      credit_total = Enum.reduce(entries, Decimal.new(0), &Decimal.add(&1.credit, &2))
      assert Decimal.equal?(debit_total, credit_total)

      # 利息为 0 只两行,利息科目可不填
      txn!(
        base_attrs(ctx, %{
          doc_no: "BT-#{System.unique_integer([:positive])}",
          sub_start: 101,
          sub_end: 200,
          bill_account_id: accts.bill.id,
          settle_account_id: accts.settle.id
        }),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      zero_interest_tx =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :discount,
            occurred_on: ~D[2026-07-10],
            sub_start: 101,
            sub_end: 200,
            amount: Decimal.new("1"),
            discount_org: "工商银行",
            discount_rate: Decimal.new("3"),
            interest: Decimal.new("0"),
            net_amount: Decimal.new("1"),
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      audited2 = audit!(zero_interest_tx, ~D[2026-07-10], act)
      assert audited2.status == :audited

      entries2 = entries_for("acc.bill_transaction", zero_interest_tx.id)
      assert length(entries2) == 2
      assert Enum.all?(entries2, &(&1.account_id in [accts.settle.id, accts.bill.id]))
    end

    test "调拨审核:零分录,posting_date 不填;持有段迁移账户", ctx do
      %{bill: bill, to_account: to_ba, accounts: accts, actor: act} = ctx

      txn!(
        base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      realloc_tx =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :reallocate,
            occurred_on: ~D[2026-07-10],
            to_bank_account_id: to_ba.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      audited =
        realloc_tx
        |> Ash.Changeset.for_update(:audit, %{}, actor: act)
        |> Ash.update!()

      assert audited.status == :audited
      assert entries_for("acc.bill_transaction", realloc_tx.id) == []

      assert [holding] = holdings_for(bill.id)
      assert holding.bank_account_id == to_ba.id
    end

    test "voucher_no 优先 doc_no,无则票号", ctx do
      %{bill: bill, accounts: accts, actor: act} = ctx

      with_doc =
        txn!(
          base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
          actor: act
        )

      audit!(with_doc, ~D[2026-07-05], act)
      entries_a = entries_for("acc.bill_transaction", with_doc.id)
      assert Enum.all?(entries_a, &(&1.voucher_no == with_doc.doc_no))

      # 无编号规则时 create 会拒收空 doc_no,这里直接 Seed 绕过取号(照 vat_invoice_test 先例)
      no_doc =
        Ash.Seed.seed!(
          BillTransaction,
          base_attrs(ctx, %{
            doc_no: nil,
            sub_start: 101,
            sub_end: 200,
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          })
        )

      assert no_doc.doc_no == nil
      audit!(no_doc, ~D[2026-07-05], act)

      entries_b = entries_for("acc.bill_transaction", no_doc.id)
      assert Enum.all?(entries_b, &(&1.voucher_no == bill.bill_no))
    end

    test "审核必填:非调拨缺 posting_date 被拒;缺票据/结算科目被拒;贴现缺利息科目被拒", ctx do
      %{accounts: accts, actor: act} = ctx

      no_posting =
        txn!(
          base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
          actor: act
        )

      err1 =
        assert_raise Ash.Error.Invalid, fn ->
          no_posting |> Ash.Changeset.for_update(:audit, %{}, actor: act) |> Ash.update!()
        end

      assert Exception.message(err1) =~ "过账日期"

      no_bill_account =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            settle_account_id: accts.settle.id
          }),
          actor: act
        )

      err2 =
        assert_raise Ash.Error.Invalid, fn -> audit!(no_bill_account, ~D[2026-07-05], act) end

      assert Exception.message(err2) =~ "票据科目"

      no_settle_account =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            bill_account_id: accts.bill.id
          }),
          actor: act
        )

      err3 =
        assert_raise Ash.Error.Invalid, fn -> audit!(no_settle_account, ~D[2026-07-05], act) end

      assert Exception.message(err3) =~ "结算科目"

      discount_no_interest_acct =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :discount,
            amount: Decimal.new("1"),
            discount_org: "工商银行",
            discount_rate: Decimal.new("3"),
            interest: Decimal.new("0.1"),
            net_amount: Decimal.new("0.9"),
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      err4 =
        assert_raise Ash.Error.Invalid, fn ->
          audit!(discount_no_interest_acct, ~D[2026-07-05], act)
        end

      assert Exception.message(err4) =~ "利息科目"
    end

    test "日期硬校验:兑付早于到期日拒;接收/转让/贴现晚于到期日拒;调拨不限", ctx do
      %{bill: bill, accounts: accts, to_account: to_ba, actor: act} = ctx

      early_settle =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :settle,
            occurred_on: Date.add(bill.due_date, -1),
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      err1 =
        assert_raise Ash.Error.Invalid, fn ->
          audit!(early_settle, Date.add(bill.due_date, -1), act)
        end

      assert Exception.message(err1) =~ "兑付发生日期不能早于票据到期日"

      late_receive =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            occurred_on: Date.add(bill.due_date, 1),
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          }),
          actor: act
        )

      err2 =
        assert_raise Ash.Error.Invalid, fn ->
          audit!(late_receive, Date.add(bill.due_date, 1), act)
        end

      assert Exception.message(err2) =~ "接收发生日期不能晚于票据到期日"

      # 先收一段供后面转让/贴现测试消耗,发生日期在到期日之内
      txn!(
        base_attrs(ctx, %{
          doc_no: "BT-#{System.unique_integer([:positive])}",
          sub_start: 101,
          sub_end: 200,
          bill_account_id: accts.bill.id,
          settle_account_id: accts.settle.id
        }),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      late_endorse =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :endorse,
            occurred_on: Date.add(bill.due_date, 1),
            sub_start: 101,
            sub_end: 200,
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          }),
          actor: act
        )

      err3 =
        assert_raise Ash.Error.Invalid, fn ->
          audit!(late_endorse, Date.add(bill.due_date, 1), act)
        end

      assert Exception.message(err3) =~ "转让发生日期不能晚于票据到期日"

      late_discount =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :discount,
            occurred_on: Date.add(bill.due_date, 1),
            sub_start: 101,
            sub_end: 200,
            amount: Decimal.new("1"),
            discount_org: "工商银行",
            discount_rate: Decimal.new("3"),
            interest: Decimal.new("0"),
            net_amount: Decimal.new("1"),
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      err4 =
        assert_raise Ash.Error.Invalid, fn ->
          audit!(late_discount, Date.add(bill.due_date, 1), act)
        end

      assert Exception.message(err4) =~ "贴现发生日期不能晚于票据到期日"

      # 调拨不限日期:发生日晚于到期日仍放行
      late_realloc =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :reallocate,
            occurred_on: Date.add(bill.due_date, 30),
            sub_start: 101,
            sub_end: 200,
            to_bank_account_id: to_ba.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      audited_realloc =
        late_realloc |> Ash.Changeset.for_update(:audit, %{}, actor: act) |> Ash.update!()

      assert audited_realloc.status == :audited
    end

    test "不得转让票:转让/贴现拒,兑付/调拨放行", ctx do
      %{accounts: accts, to_account: to_ba, actor: act} = ctx

      locked_bill = register_bill!(%{transferable: false})
      locked_ctx = Map.put(ctx, :bill, locked_bill)

      txn!(
        base_attrs(locked_ctx, %{
          bill_account_id: accts.bill.id,
          settle_account_id: accts.settle.id
        }),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      endorse_tx =
        txn!(
          base_attrs(locked_ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :endorse,
            occurred_on: ~D[2026-07-10],
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          }),
          actor: act
        )

      err1 = assert_raise Ash.Error.Invalid, fn -> audit!(endorse_tx, ~D[2026-07-10], act) end
      assert Exception.message(err1) =~ "不得转让"

      discount_tx =
        txn!(
          base_attrs(locked_ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :discount,
            occurred_on: ~D[2026-07-10],
            amount: Decimal.new("1"),
            discount_org: "工商银行",
            discount_rate: Decimal.new("3"),
            interest: Decimal.new("0.1"),
            net_amount: Decimal.new("0.9"),
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id,
            interest_account_id: accts.interest.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      err2 = assert_raise Ash.Error.Invalid, fn -> audit!(discount_tx, ~D[2026-07-10], act) end
      assert Exception.message(err2) =~ "不得转让"

      settle_tx =
        txn!(
          base_attrs(locked_ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :settle,
            occurred_on: locked_bill.due_date,
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      audited_settle = audit!(settle_tx, locked_bill.due_date, act)
      assert audited_settle.status == :audited

      # 调拨放行:重新收一段测调拨
      txn!(
        base_attrs(locked_ctx, %{
          doc_no: "BT-#{System.unique_integer([:positive])}",
          sub_start: 101,
          sub_end: 200,
          bill_account_id: accts.bill.id,
          settle_account_id: accts.settle.id
        }),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      realloc_tx =
        txn!(
          base_attrs(locked_ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :reallocate,
            occurred_on: ~D[2026-07-10],
            sub_start: 101,
            sub_end: 200,
            to_bank_account_id: to_ba.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      audited_realloc =
        realloc_tx |> Ash.Changeset.for_update(:audit, %{}, actor: act) |> Ash.update!()

      assert audited_realloc.status == :audited
    end

    test "转让未持有段:audit 报「并未持有」且事务回滚(状态仍 draft、无分录)", ctx do
      %{accounts: accts, actor: act} = ctx

      endorse_tx =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :endorse,
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          }),
          actor: act
        )

      err = assert_raise Ash.Error.Invalid, fn -> audit!(endorse_tx, ~D[2026-07-05], act) end
      assert Exception.message(err) =~ "并未持有"
      assert Exception.message(err) =~ endorse_tx.doc_no

      reloaded = Ash.get!(BillTransaction, endorse_tx.id, authorize?: false)
      assert reloaded.status == :draft
      assert entries_for("acc.bill_transaction", endorse_tx.id) == []
    end

    test "审核后 update/destroy 被拒", ctx do
      %{accounts: accts, actor: act} = ctx

      audited =
        txn!(
          base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
          actor: act
        )
        |> audit!(~D[2026-07-05], act)

      assert_raise Ash.Error.Invalid, fn ->
        audited |> Ash.Changeset.for_update(:update, %{remarks: "x"}, actor: act) |> Ash.update!()
      end

      assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(audited, actor: act) end
    end
  end

  # ------------------------------------------------------------------
  # 作废
  # ------------------------------------------------------------------

  describe "作废" do
    test "作废接收(段未动):分录标 is_cancelled,持有段消失,状态 voided", ctx do
      %{bill: bill, accounts: accts, actor: act} = ctx

      audited =
        txn!(
          base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
          actor: act
        )
        |> audit!(~D[2026-07-05], act)

      assert [_holding] = holdings_for(bill.id)

      voided = void!(audited, act)
      assert voided.status == :voided

      entries = entries_for("acc.bill_transaction", audited.id)
      assert length(entries) == 2
      assert Enum.all?(entries, & &1.is_cancelled)

      assert holdings_for(bill.id) == []
    end

    test "作废接收(段已被转让消耗):被拒,报错含后续单号线索;状态回滚仍 audited", ctx do
      %{accounts: accts, actor: act} = ctx

      receive_tx =
        txn!(
          base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
          actor: act
        )
        |> audit!(~D[2026-07-05], act)

      endorse_tx =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :endorse,
            occurred_on: ~D[2026-07-10],
            bill_account_id: accts.bill.id,
            settle_account_id: accts.settle.id
          }),
          actor: act
        )
        |> audit!(~D[2026-07-10], act)

      err = assert_raise Ash.Error.Invalid, fn -> void!(receive_tx, act) end
      assert Exception.message(err) =~ "并未持有"
      assert Exception.message(err) =~ endorse_tx.doc_no

      reloaded = Ash.get!(BillTransaction, receive_tx.id, authorize?: false)
      assert reloaded.status == :audited

      entries = entries_for("acc.bill_transaction", receive_tx.id)
      assert entries != []
      assert Enum.all?(entries, &(not &1.is_cancelled))
    end

    test "作废调拨:无分录可取消也不报错,持有回到转出账户", ctx do
      %{bill: bill, bank_account: ba, to_account: to_ba, accounts: accts, actor: act} = ctx

      txn!(
        base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
        actor: act
      )
      |> audit!(~D[2026-07-05], act)

      realloc_tx =
        txn!(
          base_attrs(ctx, %{
            doc_no: "BT-#{System.unique_integer([:positive])}",
            transaction_type: :reallocate,
            occurred_on: ~D[2026-07-10],
            to_bank_account_id: to_ba.id
          })
          |> Map.delete(:party_type)
          |> Map.delete(:party_id),
          actor: act
        )

      audited_realloc =
        realloc_tx |> Ash.Changeset.for_update(:audit, %{}, actor: act) |> Ash.update!()

      assert [holding_after_audit] = holdings_for(bill.id)
      assert holding_after_audit.bank_account_id == to_ba.id

      voided = void!(audited_realloc, act)
      assert voided.status == :voided
      assert entries_for("acc.bill_transaction", audited_realloc.id) == []

      assert [holding_after_void] = holdings_for(bill.id)
      assert holding_after_void.bank_account_id == ba.id
    end

    test "草稿不能作废;作废后不能再审", ctx do
      %{accounts: accts, actor: act} = ctx

      draft =
        txn!(
          base_attrs(ctx, %{bill_account_id: accts.bill.id, settle_account_id: accts.settle.id}),
          actor: act
        )

      err1 = assert_raise Ash.Error.Invalid, fn -> void!(draft, act) end
      assert Exception.message(err1) =~ "仅已审核交易可作废"

      audited = draft |> audit!(~D[2026-07-05], act)
      voided = void!(audited, act)

      err2 =
        assert_raise Ash.Error.Invalid, fn ->
          voided
          |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-06]}, actor: act)
          |> Ash.update!()
        end

      assert Exception.message(err2) =~ "仅草稿交易可审核"
    end
  end
end
