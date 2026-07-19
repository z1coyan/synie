defmodule SynieCore.Inv.StockBalanceTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, Stock, StockEntry, Warehouse}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    other_company = company!()

    kg = unit!(%{unit_type: :weight, name: "千克", symbol: "kg-sb", ratio: 1})

    category =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "SB#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material = material!(category, kg, %{name: "螺丝", spec: "M6×20"})
    material2 = material!(category, kg, %{name: "螺母"})

    warehouse = warehouse!(%{name: "主仓", company_id: company.id})
    transit = warehouse!(%{name: "在途仓", company_id: company.id})

    %{
      company: company,
      other_company: other_company,
      kg: kg,
      category: category,
      material: material,
      material2: material2,
      warehouse: warehouse,
      transit: transit
    }
  end

  defp unit!(attrs),
    do: Unit |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

  defp warehouse!(attrs),
    do: Warehouse |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

  defp material!(category, unit, attrs) do
    Ash.Seed.seed!(
      Material,
      Map.merge(
        %{code: "MAT-#{System.unique_integer([:positive])}", name: "垫片"},
        Map.merge(attrs, %{category_id: category.id, default_unit_id: unit.id})
      )
    )
  end

  # 直接 post! 造分录:报表只查分录不查单据(来源单据此处无关紧要)
  defp post!(company, warehouse, material, qty, posting_date, voucher_id \\ nil) do
    voucher_id = voucher_id || Ash.UUID.generate()

    :ok =
      Stock.post!(
        %{
          voucher_type: "inv.stock_doc",
          voucher_id: voucher_id,
          voucher_no: "RK-#{System.unique_integer([:positive])}",
          company_id: company.id,
          posting_date: posting_date
        },
        [
          %{
            warehouse_id: warehouse.id,
            material_id: material.id,
            quantity: qty,
            remarks: nil
          }
        ]
      )

    voucher_id
  end

  defp balance(args, opts \\ [authorize?: false]) do
    StockEntry
    |> Ash.ActionInput.for_action(:stock_balance, args)
    |> Ash.run_action!(opts)
  end

  defp row(rows, warehouse_id, material_id),
    do: Enum.find(rows, &(&1["warehouseId"] == warehouse_id and &1["materialId"] == material_id))

  test "仓×物料聚合:入出轧差,名称规格单位齐全", ctx do
    post!(ctx.company, ctx.warehouse, ctx.material, 10, ~D[2026-07-18])
    post!(ctx.company, ctx.warehouse, ctx.material, -3, ~D[2026-07-19])
    post!(ctx.company, ctx.transit, ctx.material, 4, ~D[2026-07-19])
    post!(ctx.company, ctx.warehouse, ctx.material2, 8, ~D[2026-07-19])

    rows = balance(%{company_id: ctx.company.id, as_of: ~D[2026-07-19]})
    assert length(rows) == 3

    row = row(rows, ctx.warehouse.id, ctx.material.id)
    assert row["quantity"] == "7"
    assert row["warehouseName"] == "主仓"
    assert row["materialCode"] == ctx.material.code
    assert row["materialName"] == "螺丝"
    assert row["materialSpec"] == "M6×20"
    assert row["unitName"] == "千克"

    assert row(rows, ctx.transit.id, ctx.material.id)["quantity"] == "4"
    assert row(rows, ctx.warehouse.id, ctx.material2.id)["quantity"] == "8"
  end

  test "as_of 截至日:晚于截至日的分录不计;缺省取今天", ctx do
    post!(ctx.company, ctx.warehouse, ctx.material, 10, ~D[2026-07-18])
    post!(ctx.company, ctx.warehouse, ctx.material, 5, ~D[2026-07-20])

    rows = balance(%{company_id: ctx.company.id, as_of: ~D[2026-07-19]})
    assert row(rows, ctx.warehouse.id, ctx.material.id)["quantity"] == "10"

    rows = balance(%{company_id: ctx.company.id, as_of: ~D[2026-07-21]})
    assert row(rows, ctx.warehouse.id, ctx.material.id)["quantity"] == "15"

    today = Date.utc_today()
    post!(ctx.company, ctx.warehouse, ctx.material2, 2, today)
    rows = balance(%{company_id: ctx.company.id})
    assert row(rows, ctx.warehouse.id, ctx.material2.id)["quantity"] == "2"
  end

  test "作废分录不计;hide_zero 缺省隐藏零行,显式 false 展示", ctx do
    # 未作废分录轧差为零:缺省隐藏,显式 hide_zero: false 展示
    post!(ctx.company, ctx.warehouse, ctx.material, 10, ~D[2026-07-18])
    post!(ctx.company, ctx.warehouse, ctx.material, -10, ~D[2026-07-19])

    rows = balance(%{company_id: ctx.company.id, as_of: ~D[2026-07-19]})
    assert rows == []

    rows = balance(%{company_id: ctx.company.id, as_of: ~D[2026-07-19], hide_zero: false})
    assert row(rows, ctx.warehouse.id, ctx.material.id)["quantity"] == "0"

    # 作废分录整体排除(不是按零行展示)
    voucher_id = post!(ctx.company, ctx.warehouse, ctx.material2, 5, ~D[2026-07-19])
    :ok = Stock.cancel!("inv.stock_doc", voucher_id)

    rows = balance(%{company_id: ctx.company.id, as_of: ~D[2026-07-19], hide_zero: false})
    assert row(rows, ctx.warehouse.id, ctx.material2.id) == nil
  end

  test "按仓/物料筛选", ctx do
    post!(ctx.company, ctx.warehouse, ctx.material, 10, ~D[2026-07-19])
    post!(ctx.company, ctx.transit, ctx.material, 4, ~D[2026-07-19])
    post!(ctx.company, ctx.warehouse, ctx.material2, 8, ~D[2026-07-19])

    rows =
      balance(%{
        company_id: ctx.company.id,
        as_of: ~D[2026-07-19],
        warehouse_id: ctx.transit.id
      })

    assert length(rows) == 1
    assert hd(rows)["warehouseId"] == ctx.transit.id

    rows =
      balance(%{
        company_id: ctx.company.id,
        as_of: ~D[2026-07-19],
        material_id: ctx.material2.id
      })

    assert length(rows) == 1
    assert hd(rows)["materialId"] == ctx.material2.id
  end

  test "他公司分录不进报表", ctx do
    foreign = warehouse!(%{name: "外司仓", company_id: ctx.other_company.id})
    post!(ctx.other_company, foreign, ctx.material, 99, ~D[2026-07-19])

    rows = balance(%{company_id: ctx.company.id, as_of: ~D[2026-07-19]})
    assert rows == []
  end

  test "无 read 权限被拒;有权限但无公司授权报无权查看", ctx do
    post!(ctx.company, ctx.warehouse, ctx.material, 10, ~D[2026-07-19])

    assert_raise Ash.Error.Forbidden, fn ->
      balance(%{company_id: ctx.company.id},
        actor: %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new([])}
      )
    end

    no_company =
      %Actor{
        user_id: Ash.UUID.generate(),
        permissions: MapSet.new(["inv.stock_entry:read"]),
        company_ids: []
      }

    assert {:error, error} =
             StockEntry
             |> Ash.ActionInput.for_action(:stock_balance, %{company_id: ctx.company.id})
             |> Ash.run_action(actor: no_company)

    assert Exception.message(error) =~ "无权查看该公司数据"

    rows =
      balance(%{company_id: ctx.company.id},
        actor: %{no_company | company_ids: [ctx.company.id]}
      )

    assert row(rows, ctx.warehouse.id, ctx.material.id)["quantity"] == "10"
  end
end
