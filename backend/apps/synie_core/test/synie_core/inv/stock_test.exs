defmodule SynieCore.Inv.StockTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, Stock, StockEntry, Warehouse}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    other_company = company!()

    kg = unit!(%{unit_type: :weight, name: "千克", symbol: "kg-st", ratio: 1})

    category =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "ST#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material = material!(category, kg, %{name: "螺丝"})

    warehouse = warehouse!(%{name: "主仓", company_id: company.id})

    %{
      company: company,
      other_company: other_company,
      kg: kg,
      category: category,
      material: material,
      warehouse: warehouse
    }
  end

  defp unit!(attrs),
    do: Unit |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

  defp warehouse!(attrs),
    do: Warehouse |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

  # 物料编号仅自动取号(动作不接受 code),夹具用 seed 直写以保留确定性编号
  defp material!(category, unit, attrs) do
    Ash.Seed.seed!(
      Material,
      Map.merge(
        %{code: "MAT-#{System.unique_integer([:positive])}", name: "螺母"},
        Map.merge(attrs, %{category_id: category.id, default_unit_id: unit.id})
      )
    )
  end

  defp voucher(company, attrs \\ %{}) do
    Map.merge(
      %{
        voucher_type: "inv.stock_doc",
        voucher_id: Ash.UUID.generate(),
        voucher_no: "CRK-#{System.unique_integer([:positive])}",
        company_id: company.id,
        posting_date: ~D[2026-07-19]
      },
      attrs
    )
  end

  defp entries_of(voucher_id) do
    StockEntry
    |> Ash.Query.filter(voucher_id == ^voucher_id)
    |> Ash.read!(authorize?: false)
  end

  defp balance(warehouse_id, material_id) do
    StockEntry
    |> Ash.Query.filter(
      warehouse_id == ^warehouse_id and material_id == ^material_id and is_cancelled == false
    )
    |> Ash.read!(authorize?: false)
    |> Enum.reduce(Decimal.new(0), &Decimal.add(&1.quantity, &2))
  end

  test "post! 落分录并回填单据引用", %{company: co, warehouse: wh, material: mat} do
    v = voucher(co)

    assert :ok =
             Stock.post!(v, [
               %{
                 warehouse_id: wh.id,
                 material_id: mat.id,
                 quantity: Decimal.new("10"),
                 remarks: "期初"
               }
             ])

    assert [entry] = entries_of(v.voucher_id)
    assert entry.company_id == co.id
    assert entry.warehouse_id == wh.id
    assert entry.material_id == mat.id
    assert Decimal.equal?(entry.quantity, 10)
    assert entry.posting_date == ~D[2026-07-19]
    assert entry.voucher_type == "inv.stock_doc"
    assert entry.voucher_no == v.voucher_no
    assert entry.remarks == "期初"
    refute entry.is_cancelled
    assert is_integer(entry.seq)
  end

  test "空分录组与零数量被拒", %{company: co, warehouse: wh, material: mat} do
    assert_raise ArgumentError, ~r/分录不少于一行/, fn -> Stock.post!(voucher(co), []) end

    assert_raise ArgumentError, ~r/数量不能为零/, fn ->
      Stock.post!(voucher(co), [
        %{warehouse_id: wh.id, material_id: mat.id, quantity: 0}
      ])
    end
  end

  describe "仓与物料防御校验" do
    test "仓不存在/跨公司/非叶子被拒", %{
      company: co,
      other_company: other,
      warehouse: wh,
      material: mat
    } do
      entry = fn warehouse_id ->
        [%{warehouse_id: warehouse_id, material_id: mat.id, quantity: 1}]
      end

      assert_raise ArgumentError, ~r/仓库不存在/, fn ->
        Stock.post!(voucher(co), entry.(Ash.UUID.generate()))
      end

      foreign = warehouse!(%{name: "外司仓", company_id: other.id})

      assert_raise ArgumentError, ~r/仓库必须属于单据公司/, fn ->
        Stock.post!(voucher(co), entry.(foreign.id))
      end

      root = warehouse!(%{name: "总仓", is_leaf: false, company_id: co.id})

      assert_raise ArgumentError, ~r/只有叶子仓库才能发生库存/, fn ->
        Stock.post!(voucher(co), entry.(root.id))
      end

      # 停用仓不拦(拦新不拦旧在单据保存侧,过账只认结构约束)
      inactive = warehouse!(%{name: "停用仓", company_id: co.id, active: false})
      assert :ok = Stock.post!(voucher(co), entry.(inactive.id))

      # 正常仓对照
      assert :ok = Stock.post!(voucher(co), entry.(wh.id))
    end

    test "物料不存在被拒", %{company: co, warehouse: wh} do
      assert_raise ArgumentError, ~r/物料不存在/, fn ->
        Stock.post!(voucher(co), [
          %{warehouse_id: wh.id, material_id: Ash.UUID.generate(), quantity: 1}
        ])
      end
    end
  end

  describe "负库存校验" do
    test "余额不足整单拒,报错含仓名与物料名", %{company: co, warehouse: wh, material: mat} do
      error =
        assert_raise ArgumentError, fn ->
          Stock.post!(voucher(co), [
            %{warehouse_id: wh.id, material_id: mat.id, quantity: -5}
          ])
        end

      message = Exception.message(error)
      assert message =~ "库存不足"
      assert message =~ wh.name
      assert message =~ mat.name
    end

    test "同键多行合并后判定(入 10 出 12 被拒,出 10 放行)", %{
      company: co,
      warehouse: wh,
      material: mat
    } do
      :ok =
        Stock.post!(voucher(co), [
          %{warehouse_id: wh.id, material_id: mat.id, quantity: 10}
        ])

      assert_raise ArgumentError, ~r/库存不足/, fn ->
        Stock.post!(voucher(co), [
          %{warehouse_id: wh.id, material_id: mat.id, quantity: -5},
          %{warehouse_id: wh.id, material_id: mat.id, quantity: -7}
        ])
      end

      assert :ok =
               Stock.post!(voucher(co), [
                 %{warehouse_id: wh.id, material_id: mat.id, quantity: -5},
                 %{warehouse_id: wh.id, material_id: mat.id, quantity: -5}
               ])

      assert Decimal.equal?(balance(wh.id, mat.id), 0)
    end

    test "allow_negative 仓跳过校验", %{company: co, material: mat} do
      wh = warehouse!(%{name: "负仓", company_id: co.id, allow_negative: true})

      assert :ok =
               Stock.post!(voucher(co), [
                 %{warehouse_id: wh.id, material_id: mat.id, quantity: -5}
               ])

      assert Decimal.equal?(balance(wh.id, mat.id), -5)
    end

    test "仓级口径,不跨仓相抵", %{company: co, warehouse: wh, material: mat} do
      wh2 = warehouse!(%{name: "二仓", company_id: co.id})

      :ok =
        Stock.post!(voucher(co), [
          %{warehouse_id: wh.id, material_id: mat.id, quantity: 10}
        ])

      # 主仓有货不抵二仓
      assert_raise ArgumentError, ~r/库存不足/, fn ->
        Stock.post!(voucher(co), [
          %{warehouse_id: wh2.id, material_id: mat.id, quantity: -1}
        ])
      end
    end
  end

  describe "cancel!" do
    test "标记该单据全部分录,余额归零", %{company: co, warehouse: wh, material: mat} do
      v = voucher(co)

      :ok =
        Stock.post!(v, [
          %{warehouse_id: wh.id, material_id: mat.id, quantity: 10}
        ])

      assert :ok = Stock.cancel!(v.voucher_type, v.voucher_id)
      assert Enum.all?(entries_of(v.voucher_id), & &1.is_cancelled)
      assert Decimal.equal?(balance(wh.id, mat.id), 0)
    end

    test "作废入库致负被拒(与审核同一口径)", %{company: co, warehouse: wh, material: mat} do
      v_in = voucher(co)

      :ok =
        Stock.post!(v_in, [
          %{warehouse_id: wh.id, material_id: mat.id, quantity: 10}
        ])

      v_out = voucher(co)

      :ok =
        Stock.post!(v_out, [
          %{warehouse_id: wh.id, material_id: mat.id, quantity: -8}
        ])

      # 作废入库单 = 减 10,余额 2 - 10 < 0,被拒
      assert_raise ArgumentError, ~r/库存不足/, fn ->
        Stock.cancel!(v_in.voucher_type, v_in.voucher_id)
      end

      refute Enum.any?(entries_of(v_in.voucher_id), & &1.is_cancelled)

      # 作废出库单 = 加回 8,永不致负
      assert :ok = Stock.cancel!(v_out.voucher_type, v_out.voucher_id)
    end
  end
end
