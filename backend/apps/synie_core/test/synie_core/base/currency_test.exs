defmodule SynieCore.Base.CurrencyTest do
  # 非 async:测试币种 iso_code 唯一性,须用固定码(EUR 重复等);串行运行避免与
  # 其它模块并发写 bas_currency 唯一索引互锁(deadlock)
  use ExUnit.Case, async: false

  alias SynieCore.Base.Currency
  alias SynieCore.Base.Company

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp currency!(attrs) do
    Currency
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # CNY 已由迁移种入 DB(公司本币兜底),测试改用其他币种码,不再假设空库
  test "创建货币,符号可选,默认启用" do
    jpy = currency!(%{name: "日元", iso_code: "JPY", symbol: "¥"})
    usd = currency!(%{name: "美元", iso_code: "USD"})

    assert jpy.symbol == "¥"
    assert jpy.active == true
    assert is_nil(usd.symbol)
    assert usd.active == true
  end

  test "可显式创建为停用" do
    eur = currency!(%{name: "欧元", iso_code: "EUR", active: false})
    assert eur.active == false
  end

  test "iso_code 唯一" do
    currency!(%{name: "欧元", iso_code: "EUR"})

    assert_raise Ash.Error.Invalid, fn ->
      currency!(%{name: "欧元2", iso_code: "EUR"})
    end
  end

  test "iso_code 必须三位大写字母" do
    for bad <- ["cny", "CN", "CNYY", "C1Y"] do
      assert_raise Ash.Error.Invalid, fn ->
        currency!(%{name: "坏货币", iso_code: bad})
      end
    end
  end

  test "资源声明了权限前缀" do
    assert Currency.permission_prefix() == "base.currency"
  end

  test "启停可翻转;被公司引用为本币的不可停用" do
    usd = currency!(%{name: "美元", iso_code: "USD", active: true})

    disabled =
      usd
      |> Ash.Changeset.for_update(:update, %{active: false})
      |> Ash.update!(authorize?: false)

    assert disabled.active == false

    reenabled =
      disabled
      |> Ash.Changeset.for_update(:update, %{active: true})
      |> Ash.update!(authorize?: false)

    assert reenabled.active == true

    Company
    |> Ash.Changeset.for_create(:create, %{
      code: "SH",
      name: "上海",
      short_name: "上海",
      base_currency_id: reenabled.id
    })
    |> Ash.create!(authorize?: false)

    assert_raise Ash.Error.Invalid, fn ->
      reenabled
      |> Ash.Changeset.for_update(:update, %{active: false})
      |> Ash.update!(authorize?: false)
    end
  end
end
