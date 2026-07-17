defmodule SynieCore.Base.CurrencyTest do
  use ExUnit.Case, async: true

  alias SynieCore.Base.Currency

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp currency!(attrs) do
    Currency
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # CNY 已由迁移种入 DB(公司本币兜底),测试改用其他币种码,不再假设空库
  test "创建货币,符号可选" do
    jpy = currency!(%{name: "日元", iso_code: "JPY", symbol: "¥"})
    usd = currency!(%{name: "美元", iso_code: "USD"})

    assert jpy.symbol == "¥"
    assert is_nil(usd.symbol)
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
end
