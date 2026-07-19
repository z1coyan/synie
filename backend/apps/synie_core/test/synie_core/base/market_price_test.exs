defmodule SynieCore.Base.MarketPriceTest do
  use ExUnit.Case, async: true

  alias SynieCore.Base.Currency
  alias SynieCore.Base.MarketInstrument
  alias SynieCore.Base.MarketPricePoint
  alias SynieCore.Base.MarketQuote
  alias SynieCore.Base.Unit

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp currency! do
    # 三位纯大写字母,从 unique_integer 映射到 A-Z 空间避免撞 CNY 等种子
    n = System.unique_integer([:positive])
    a = rem(div(n, 26 * 26), 26)
    b = rem(div(n, 26), 26)
    c = rem(n, 26)
    iso = <<?A + a, ?A + b, ?A + c>>

    Currency
    |> Ash.Changeset.for_create(:create, %{name: "测币", iso_code: iso})
    |> Ash.create!(authorize?: false)
  end

  defp unit! do
    sym = "u#{System.unique_integer([:positive])}"

    Unit
    |> Ash.Changeset.for_create(:create, %{
      unit_type: :weight,
      is_base: false,
      name: "测吨",
      symbol: sym,
      ratio: Decimal.new(1)
    })
    |> Ash.create!(authorize?: false)
  end

  defp instrument!(attrs \\ %{}) do
    c = currency!()
    u = unit!()

    defaults = %{
      code: "I#{System.unique_integer([:positive])}",
      name: "测试品种",
      source_type: :exchange,
      default_price_kind: :settlement,
      currency_id: c.id,
      unit_id: u.id
    }

    MarketInstrument
    |> Ash.Changeset.for_create(:create, Map.merge(defaults, attrs))
    |> Ash.create!(authorize?: false)
  end

  defp point!(instrument, attrs) do
    defaults = %{
      instrument_id: instrument.id,
      observed_at: ~U[2026-07-01 00:00:00Z],
      price: Decimal.new("70000"),
      source: :manual
    }

    MarketPricePoint
    |> Ash.Changeset.for_create(:create, Map.merge(defaults, attrs))
    |> Ash.create!(authorize?: false)
  end

  test "权限前缀" do
    assert MarketInstrument.permission_prefix() == "base.market_instrument"
    assert MarketPricePoint.permission_prefix() == "base.market_price"
    assert MarketPricePoint.permission_actions() == ~w(create read void)
  end

  test "创建品种,编码唯一" do
    i = instrument!(%{code: "CU_TEST_A"})
    assert i.active == true
    assert i.source_type == :exchange

    assert_raise Ash.Error.Invalid, fn ->
      instrument!(%{code: "CU_TEST_A"})
    end
  end

  test "价点继承品种币种单位与默认价类" do
    i = instrument!(%{default_price_kind: :average})
    p = point!(i, %{price: Decimal.new("100"), observed_at: ~U[2026-07-10 08:00:00Z]})

    assert p.currency_id == i.currency_id
    assert p.unit_id == i.unit_id
    assert p.price_kind == :average
    assert p.is_voided == false
    assert p.source == :manual
  end

  test "有效价点(品种+时刻+价类)唯一,作废后可重录" do
    i = instrument!()
    at = ~U[2026-07-15 00:00:00Z]
    p1 = point!(i, %{observed_at: at, price: Decimal.new("1")})

    assert_raise Ash.Error.Invalid, fn ->
      point!(i, %{observed_at: at, price: Decimal.new("2")})
    end

    p1
    |> Ash.Changeset.for_update(:void, %{})
    |> Ash.update!(authorize?: false)

    p2 = point!(i, %{observed_at: at, price: Decimal.new("2")})
    assert Decimal.eq?(p2.price, Decimal.new("2"))
    assert p2.is_voided == false
  end

  test "价格必须大于 0" do
    i = instrument!()

    assert_raise Ash.Error.Invalid, fn ->
      point!(i, %{price: Decimal.new("0")})
    end
  end

  test "有价点不可删品种,无价点可删" do
    i = instrument!()
    point!(i, %{})

    assert_raise Ash.Error.Invalid, fn ->
      i |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    end

    j = instrument!()

    assert :ok ==
             (j |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false) && :ok)
  end

  test "取价:≤ 时点最近有效点,跳过已作废" do
    i = instrument!()
    point!(i, %{observed_at: ~U[2026-07-01 00:00:00Z], price: Decimal.new("10")})
    p2 = point!(i, %{observed_at: ~U[2026-07-05 00:00:00Z], price: Decimal.new("20")})
    p3 = point!(i, %{observed_at: ~U[2026-07-10 00:00:00Z], price: Decimal.new("30")})

    p3
    |> Ash.Changeset.for_update(:void, %{})
    |> Ash.update!(authorize?: false)

    assert {:ok, got} = MarketQuote.take(i.id, ~U[2026-07-12 12:00:00Z])
    assert got.id == p2.id

    assert {:ok, got2} = MarketQuote.take(i.id, ~U[2026-07-03 00:00:00Z])
    assert Decimal.eq?(got2.price, Decimal.new("10"))

    assert {:error, :not_found} = MarketQuote.take(i.id, ~U[2026-06-01 00:00:00Z])
  end

  test "已作废价点不可再作废" do
    i = instrument!()
    p = point!(i, %{})

    voided =
      p
      |> Ash.Changeset.for_update(:void, %{})
      |> Ash.update!(authorize?: false)

    assert voided.is_voided

    assert_raise Ash.Error.Invalid, fn ->
      voided
      |> Ash.Changeset.for_update(:void, %{})
      |> Ash.update!(authorize?: false)
    end
  end
end
