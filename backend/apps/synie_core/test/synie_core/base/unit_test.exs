defmodule SynieCore.Base.UnitTest do
  use ExUnit.Case, async: true

  alias SynieCore.Base.Unit

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp unit!(attrs) do
    Unit
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  test "基准单位与换算单位" do
    kg = unit!(%{unit_type: :weight, is_base: true, name: "千克", symbol: "kgs", ratio: 1})
    g = unit!(%{unit_type: :weight, name: "克", symbol: "g", ratio: "0.001"})

    assert kg.is_base
    refute g.is_base
    assert Decimal.eq?(g.ratio, Decimal.new("0.001"))
  end

  test "单位符号唯一" do
    unit!(%{unit_type: :quantity, is_base: true, name: "个", symbol: "pcs", ratio: 1})

    assert_raise Ash.Error.Invalid, fn ->
      unit!(%{unit_type: :quantity, name: "件", symbol: "pcs", ratio: 10})
    end
  end

  test "每类型只能有一个基准单位" do
    unit!(%{unit_type: :length, is_base: true, name: "米", symbol: "m", ratio: 1})

    assert_raise Ash.Error.Invalid, fn ->
      unit!(%{unit_type: :length, is_base: true, name: "厘米", symbol: "cm", ratio: 1})
    end
  end

  test "基准单位换算比例必须为 1" do
    assert_raise Ash.Error.Invalid, fn ->
      unit!(%{unit_type: :area, is_base: true, name: "平方米", symbol: "sqm", ratio: 2})
    end
  end

  test "换算比例必须大于 0" do
    assert_raise Ash.Error.Invalid, fn ->
      unit!(%{unit_type: :weight, name: "负数", symbol: "neg", ratio: -1})
    end
  end

  test "资源声明了权限前缀" do
    assert Unit.permission_prefix() == "base.unit"
  end
end
