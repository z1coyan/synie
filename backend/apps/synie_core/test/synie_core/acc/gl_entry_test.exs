defmodule SynieCore.Acc.GlEntryTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.GlEntry
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Account

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    account = account!(%{code: "1001", name: "库存现金", direction: :debit, company_id: company.id})
    %{company: company, account: account}
  end

  defp account!(attrs) do
    Account
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp entry!(attrs) do
    GlEntry
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp base_attrs(co, acc) do
    %{
      company_id: co.id,
      account_id: acc.id,
      posting_date: ~D[2026-07-09],
      debit: Decimal.new("100"),
      credit: Decimal.new("0"),
      voucher_type: "acc.gl_journal",
      voucher_id: Ash.UUID.generate(),
      voucher_no: "记-0001"
    }
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["acc.gl_entry:read"])},
      overrides
    )
  end

  test "内部创建分录,seq 由库生成", %{company: co, account: acc} do
    entry = entry!(base_attrs(co, acc))
    assert is_integer(entry.seq)
    assert entry.is_cancelled == false
  end

  test "CHECK:借贷双边同时大于零被拒绝", %{company: co, account: acc} do
    assert_raise Ash.Error.Invalid, fn ->
      entry!(%{base_attrs(co, acc) | credit: Decimal.new("100")})
    end
  end

  test "CHECK:对手类型与对手必须同空同有", %{company: co, account: acc} do
    assert_raise Ash.Error.Invalid, fn ->
      entry!(Map.put(base_attrs(co, acc), :party_id, Ash.UUID.generate()))
    end
  end

  test "读取按公司范围过滤,fail-closed", %{company: co, account: acc} do
    entry!(base_attrs(co, acc))

    in_scope = actor(company_ids: [co.id])
    out_scope = actor([])

    assert [_] = Ash.read!(GlEntry, actor: in_scope)
    assert [] = Ash.read!(GlEntry, actor: out_scope)
  end

  test "mark_cancelled 内部标记作废", %{company: co, account: acc} do
    entry = entry!(base_attrs(co, acc))

    cancelled =
      entry
      |> Ash.Changeset.for_update(:mark_cancelled, %{})
      |> Ash.update!(authorize?: false)

    assert cancelled.is_cancelled == true
  end
end
