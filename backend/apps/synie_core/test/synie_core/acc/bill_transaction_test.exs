defmodule SynieCore.Acc.BillTransactionTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.{Bill, BankAccount, BillTransaction}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Currency
  alias SynieCore.Sales.Customer

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    bank_account = bank_account!(company)
    to_account = bank_account!(company)
    customer = customer!()
    bill = register_bill!()

    %{
      company: company,
      bank_account: bank_account,
      to_account: to_account,
      customer: customer,
      bill: bill,
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

  test "读取按公司范围过滤 fail-closed", ctx do
    %{company: co, actor: act} = ctx

    txn!(base_attrs(ctx), actor: act)

    in_scope = actor(company_ids: [co.id])
    out_scope = actor([])

    assert [_] = Ash.read!(BillTransaction, actor: in_scope)
    assert [] = Ash.read!(BillTransaction, actor: out_scope)
  end
end
