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

  test "创建货币,符号可选" do
    cny = currency!(%{name: "人民币", iso_code: "CNY", symbol: "¥"})
    usd = currency!(%{name: "美元", iso_code: "USD"})

    assert cny.symbol == "¥"
    assert is_nil(usd.symbol)
  end

  test "iso_code 唯一" do
    currency!(%{name: "人民币", iso_code: "CNY"})

    assert_raise Ash.Error.Invalid, fn ->
      currency!(%{name: "人民币2", iso_code: "CNY"})
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
