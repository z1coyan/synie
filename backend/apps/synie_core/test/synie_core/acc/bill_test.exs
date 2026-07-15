defmodule SynieCore.Acc.BillTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.{BankAccount, Bill, BillTransaction}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Currency

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    :ok
  end

  # 夹具:actor(permissions: ["acc.bill:*"]);register 走 authorize?: false(内部动作)
  defp actor(overrides \\ []) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["acc.bill:*"])},
      overrides
    )
  end

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

  # 直接落一笔草稿交易(不经完整校验矩阵),仅用于挂接票据做读过滤/拒删场景
  defp seed_transaction!(company, bank_account, bill, overrides \\ %{}) do
    Ash.Seed.seed!(
      BillTransaction,
      Map.merge(
        %{
          company_id: company.id,
          bank_account_id: bank_account.id,
          bill_id: bill.id,
          transaction_type: :receive,
          occurred_on: ~D[2026-07-01],
          sub_start: 1,
          sub_end: 100,
          amount: Decimal.new("1")
        },
        overrides
      )
    )
  end

  defp base_attrs(overrides \\ %{}) do
    Map.merge(
      %{
        bill_no: "BILL#{System.unique_integer([:positive])}",
        bill_kind: :bank_acceptance,
        due_date: ~D[2026-12-31],
        face_amount: Decimal.new("10000")
      },
      overrides
    )
  end

  defp register!(attrs) do
    Bill
    |> Ash.Changeset.for_create(:register, attrs, authorize?: false)
    |> Ash.create!(authorize?: false)
  end

  test "register 建档:票号/种类/到期日必填,其余票面可空(含票据包金额)" do
    bill = register!(base_attrs())

    assert bill.bill_kind == :bank_acceptance
    assert bill.due_date == ~D[2026-12-31]
    assert Decimal.equal?(bill.face_amount, Decimal.new("10000"))
    # 未传的票面字段保持可空
    assert bill.issue_date == nil
    assert bill.drawer_name == nil
    assert bill.payee_name == nil
    assert bill.acceptor_name == nil
    assert bill.acceptance_date == nil
    assert bill.remarks == nil
    assert bill.transferable == true

    for field <- [:bill_no, :bill_kind, :due_date] do
      attrs = base_attrs() |> Map.delete(field)

      assert_raise Ash.Error.Invalid, fn -> register!(attrs) end
    end

    # 票据包金额可空:承兑均来源于接收,原包金额不关心
    no_face = register!(base_attrs() |> Map.delete(:face_amount))
    assert no_face.face_amount == nil
  end

  test "register 重复票号 upsert 挂接不覆盖:二次提交不同票面,读回仍是首录票面" do
    attrs = base_attrs(%{drawer_name: "甲出票人"})
    first = register!(attrs)

    second =
      register!(Map.merge(attrs, %{drawer_name: "乙出票人", face_amount: Decimal.new("99999")}))

    assert second.id == first.id
    assert second.drawer_name == "甲出票人"
    assert Decimal.equal?(second.face_amount, Decimal.new("10000"))
  end

  test "bill_no 全局唯一(identity)" do
    attrs = base_attrs()
    Ash.Seed.seed!(Bill, attrs)

    assert_raise Ash.Error.Invalid, fn ->
      Ash.Seed.seed!(Bill, Map.put(attrs, :face_amount, Decimal.new("1")))
    end
  end

  test "update 票面修正:承兑人名称可改;bill_no 不在 accept 内改不动" do
    bill = register!(base_attrs())
    act = actor()

    updated =
      bill
      |> Ash.Changeset.for_update(:update, %{acceptor_name: "承兑人甲"}, actor: act)
      |> Ash.update!()

    assert updated.acceptor_name == "承兑人甲"

    # bill_no 不在 update 的 accept 列表内,传入即被拒绝(改不动)
    assert_raise Ash.Error.Invalid, fn ->
      updated
      |> Ash.Changeset.for_update(
        :update,
        %{bill_no: "OTHER-#{System.unique_integer([:positive])}"},
        actor: act
      )
      |> Ash.update!()
    end
  end

  test "face_amount 非正数被拒" do
    assert_raise Ash.Error.Invalid, fn ->
      register!(base_attrs(%{face_amount: Decimal.new("0")}))
    end

    assert_raise Ash.Error.Invalid, fn ->
      register!(base_attrs(%{face_amount: Decimal.new("-100")}))
    end
  end

  test "destroy:无交易的票可删" do
    bill = register!(base_attrs())
    act = actor()

    assert :ok = Ash.destroy!(bill, actor: act)
  end

  test "票据读过滤:A 公司录过交易后 A 可见该票,无交易公司的 actor 不可见" do
    company_a = company!()
    company_b = company!()
    bill = register!(base_attrs())
    seed_transaction!(company_a, bank_account!(company_a), bill)

    visible = actor(company_ids: [company_a.id])
    other = actor(company_ids: [company_b.id])
    none = actor([])

    assert [seen] = Ash.read!(Bill, actor: visible)
    assert seen.id == bill.id

    assert Ash.read!(Bill, actor: other) == []
    assert Ash.read!(Bill, actor: none) == []
  end

  test "有交易的票据 destroy 被拒;有交易后改 due_date/face_amount/transferable 被拒" do
    company = company!()
    bill = register!(base_attrs())
    seed_transaction!(company, bank_account!(company), bill)
    act = actor()

    assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(bill, actor: act) end

    for {field, value} <- [
          {:due_date, ~D[2027-01-01]},
          {:face_amount, Decimal.new("1")},
          {:transferable, false}
        ] do
      assert_raise Ash.Error.Invalid, fn ->
        bill
        |> Ash.Changeset.for_update(:update, %{field => value}, actor: act)
        |> Ash.update!()
      end
    end
  end
end
