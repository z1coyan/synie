defmodule SynieCore.Acc.BillTest do
  use ExUnit.Case, async: true

  alias SynieCore.Acc.Bill
  alias SynieCore.Authz.Actor

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

  test "register 建档:票号/种类/到期日/金额必填,其余票面可空" do
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

    for field <- [:bill_no, :bill_kind, :due_date, :face_amount] do
      attrs = base_attrs() |> Map.delete(field)

      assert_raise Ash.Error.Invalid, fn -> register!(attrs) end
    end
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
end
