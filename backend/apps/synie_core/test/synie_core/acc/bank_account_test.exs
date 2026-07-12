defmodule SynieCore.Acc.BankAccountTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.BankAccount
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.{Account, Currency}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    %{company: company!(), currency: currency!()}
  end

  defp currency!(attrs \\ %{}) do
    # iso_code 固定三位大写字母,同公司 code 的映射思路
    i = System.unique_integer([:positive])
    code = <<?A + rem(div(i, 676), 26), ?A + rem(div(i, 26), 26), ?A + rem(i, 26)>>

    Currency
    |> Ash.Changeset.for_create(:create, Map.merge(%{name: "测试币", iso_code: code}, attrs))
    |> Ash.create!(authorize?: false)
  end

  defp account!(attrs) do
    Account
    |> Ash.Changeset.for_create(:create, Map.merge(%{direction: :debit}, attrs))
    |> Ash.create!(authorize?: false)
  end

  defp bank_account!(attrs) do
    BankAccount
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp valid_attrs(company, currency, overrides \\ %{}) do
    Map.merge(
      %{
        alias: "基本户#{System.unique_integer([:positive])}",
        bank_name: "招商银行",
        holder_name: "测试公司",
        account_no: "#{System.unique_integer([:positive])}",
        company_id: company.id,
        currency_id: currency.id
      },
      overrides
    )
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["acc.bank_account:*"])},
      overrides
    )
  end

  test "创建银行账户,选填字段可空", %{company: co, currency: cur} do
    ba = bank_account!(valid_attrs(co, cur, %{branch_name: "深圳分行", note: "工资户"}))

    assert ba.active == true
    assert ba.account_id == nil
  end

  test "别名同公司唯一,跨公司可重复", %{company: co, currency: cur} do
    other = company!()
    bank_account!(valid_attrs(co, cur, %{alias: "基本户"}))
    bank_account!(valid_attrs(other, cur, %{alias: "基本户"}))

    assert_raise Ash.Error.Invalid, fn ->
      bank_account!(valid_attrs(co, cur, %{alias: "基本户"}))
    end
  end

  test "账号同公司唯一", %{company: co, currency: cur} do
    bank_account!(valid_attrs(co, cur, %{account_no: "6225880212345678"}))

    assert_raise Ash.Error.Invalid, fn ->
      bank_account!(valid_attrs(co, cur, %{account_no: "6225880212345678"}))
    end
  end

  test "绑定科目必须同公司", %{company: co, currency: cur} do
    other = company!()
    acc = account!(%{code: "1002", name: "银行存款", company_id: other.id})

    assert_raise Ash.Error.Invalid, fn ->
      bank_account!(valid_attrs(co, cur, %{account_id: acc.id}))
    end
  end

  test "汇总/停用科目不能绑定", %{company: co, currency: cur} do
    group = account!(%{code: "1002", name: "银行存款", is_group: true, company_id: co.id})
    inactive = account!(%{code: "100201", name: "招行户", active: false, company_id: co.id})

    for acc <- [group, inactive] do
      assert_raise Ash.Error.Invalid, fn ->
        bank_account!(valid_attrs(co, cur, %{account_id: acc.id}))
      end
    end
  end

  test "科目指定币种时须与账户货币一致,未指定则不校验", %{company: co, currency: cur} do
    usd = currency!()
    usd_acc = account!(%{code: "100202", name: "美元户", company_id: co.id, currency_id: usd.id})
    plain_acc = account!(%{code: "100203", name: "通用户", company_id: co.id})

    assert_raise Ash.Error.Invalid, fn ->
      bank_account!(valid_attrs(co, cur, %{account_id: usd_acc.id}))
    end

    bank_account!(valid_attrs(co, usd, %{account_id: usd_acc.id}))
    bank_account!(valid_attrs(co, cur, %{account_id: plain_acc.id}))
  end

  test "update 换绑科目同样校验", %{company: co, currency: cur} do
    ba = bank_account!(valid_attrs(co, cur))
    group = account!(%{code: "1002", name: "银行存款", is_group: true, company_id: co.id})

    assert_raise Ash.Error.Invalid, fn ->
      ba
      |> Ash.Changeset.for_update(:update, %{account_id: group.id})
      |> Ash.update!(authorize?: false)
    end
  end

  test "读取按授权公司过滤(fail-closed)", %{company: co, currency: cur} do
    other = company!()
    bank_account!(valid_attrs(co, cur))
    bank_account!(valid_attrs(other, cur))

    rows = Ash.read!(BankAccount, actor: actor(%{company_ids: [co.id]}))
    assert Enum.map(rows, & &1.company_id) == [co.id]

    assert Ash.read!(BankAccount, actor: actor(%{})) == []
  end

  test "无权限拒绝创建", %{company: co, currency: cur} do
    no_perm = struct!(%Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new()}, %{})

    assert_raise Ash.Error.Forbidden, fn ->
      BankAccount
      |> Ash.Changeset.for_create(:create, valid_attrs(co, cur))
      |> Ash.create!(actor: no_perm)
    end
  end
end
