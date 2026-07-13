defmodule SynieCore.Acc.BankTransactionTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.BankAccount
  alias SynieCore.Acc.BankTransaction
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Currency

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    %{company: company, bank_account: bank_account!(company)}
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
          alias: "基本户#{System.unique_integer([:positive])}",
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

  defp txn!(attrs) do
    BankTransaction
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp valid_attrs(company, bank_account, overrides \\ %{}) do
    Map.merge(
      %{
        occurred_at: ~U[2026-07-01 10:30:00Z],
        income: Decimal.new("100.50"),
        company_id: company.id,
        bank_account_id: bank_account.id
      },
      overrides
    )
  end

  defp actor(overrides) do
    struct!(
      %Actor{
        user_id: Ash.UUID.generate(),
        permissions: MapSet.new(["acc.bank_transaction:*"])
      },
      overrides
    )
  end

  test "创建流水,选填字段可空", %{company: co, bank_account: ba} do
    txn =
      txn!(
        valid_attrs(co, ba, %{
          counterparty_name: "某供应商",
          summary: "货款",
          note: "内部备注"
        })
      )

    assert txn.balance == nil
    assert txn.counterparty_account == nil
    assert txn.expense == nil
  end

  test "收入/支出恰填一项且大于零", %{company: co, bank_account: ba} do
    # 支出单填放行
    txn!(valid_attrs(co, ba, %{income: nil, expense: Decimal.new("88")}))

    invalid = [
      # 双空
      %{income: nil, expense: nil},
      # 双填
      %{income: Decimal.new("1"), expense: Decimal.new("1")},
      # 零值
      %{income: Decimal.new("0"), expense: nil},
      # 负数(不允许:冲正/退款按实际资金方向录)
      %{income: nil, expense: Decimal.new("-5")}
    ]

    for overrides <- invalid do
      assert_raise Ash.Error.Invalid, fn ->
        txn!(valid_attrs(co, ba, overrides))
      end
    end
  end

  test "账户必须属于同一公司", %{company: co} do
    other_ba = bank_account!(company!())

    assert_raise Ash.Error.Invalid, fn ->
      txn!(valid_attrs(co, other_ba))
    end
  end

  test "停用账户不能新增流水,存量流水可更新", %{company: co, bank_account: ba} do
    txn = txn!(valid_attrs(co, ba))

    ba
    |> Ash.Changeset.for_update(:update, %{active: false})
    |> Ash.update!(authorize?: false)

    assert_raise Ash.Error.Invalid, fn ->
      txn!(valid_attrs(co, ba))
    end

    updated =
      txn
      |> Ash.Changeset.for_update(:update, %{note: "补充说明"})
      |> Ash.update!(authorize?: false)

    assert updated.note == "补充说明"
  end

  test "读取按授权公司过滤(fail-closed)", %{company: co, bank_account: ba} do
    other = company!()
    txn!(valid_attrs(co, ba))
    txn!(valid_attrs(other, bank_account!(other)))

    rows = Ash.read!(BankTransaction, actor: actor(%{company_ids: [co.id]}))
    assert Enum.map(rows, & &1.company_id) == [co.id]

    assert Ash.read!(BankTransaction, actor: actor(%{})) == []
  end

  test "无权限拒绝创建", %{company: co, bank_account: ba} do
    no_perm = struct!(%Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new()}, %{})

    assert_raise Ash.Error.Forbidden, fn ->
      BankTransaction
      |> Ash.Changeset.for_create(:create, valid_attrs(co, ba))
      |> Ash.create!(actor: no_perm)
    end
  end
end
