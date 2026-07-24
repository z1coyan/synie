defmodule SynieCore.Mfg.FulfillmentTest do
  # async: false — 避免与 authz 写矩阵 shared sandbox 并发时污染 mfg_demand 世界行
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, StockEntry, Warehouse}

  alias SynieCore.Mfg.{
    Demand,
    DemandItem,
    Output,
    OutputItem,
    Setting,
    WorkOrder
  }

  alias SynieCore.Sales.{Customer, Order, OrderItem}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-ff#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "F#{System.unique_integer([:positive])}",
        name: "成品"
      })
      |> Ash.create!(authorize?: false)

    material =
      Ash.Seed.seed!(Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "成品A",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    warehouse =
      Warehouse
      |> Ash.Changeset.for_create(:create, %{name: "成品仓", company_id: company.id})
      |> Ash.create!(authorize?: false)

    customer =
      Customer
      |> Ash.Changeset.for_create(:create, %{
        code: "C-#{System.unique_integer([:positive])}",
        name: "测试客户"
      })
      |> Ash.create!(authorize?: false)

    %{
      company: company,
      kg: kg,
      material: material,
      warehouse: warehouse,
      customer: customer
    }
  end

  defp demand!(company, attrs \\ %{}) do
    Demand
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          company_id: company.id,
          demand_no: "MD-#{System.unique_integer([:positive])}",
          demand_date: ~D[2026-07-20]
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp item!(demand, material, unit, attrs \\ %{}) do
    DemandItem
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          demand_id: demand.id,
          idx: 1,
          material_id: material.id,
          unit_id: unit.id,
          qty: Decimal.new(10),
          need_date: ~D[2026-07-25],
          fulfillment_method: :make
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp audited_sales_item!(company, customer, material, unit, qty) do
    order =
      Order
      |> Ash.Changeset.for_create(:create, %{
        order_no: "SO-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-15],
        order_type: :sample,
        company_id: company.id,
        party_type: :customer,
        party_id: customer.id,
        currency_id: cny!().id
      })
      |> Ash.create!(authorize?: false)

    item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: material.id,
        unit_id: unit.id,
        qty: Decimal.new(qty),
        price: Decimal.new("10.00"),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    {order, item}
  end

  describe "履约需求单状态机" do
    test "草稿→确认→关闭", %{company: company, material: material, kg: kg} do
      d = demand!(company)
      item!(d, material, kg)

      assert d.status == :draft

      d = d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
      assert d.status == :confirmed

      d = d |> Ash.Changeset.for_update(:close, %{}) |> Ash.update!(authorize?: false)
      assert d.status == :closed
    end

    test "无行不可确认", %{company: company} do
      d = demand!(company)

      assert {:error, _} =
               d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update(authorize?: false)
    end

    test "草稿不可作废(走删除);确认后无工单可作废", %{company: company, material: material, kg: kg} do
      d1 = demand!(company)

      assert {:error, err} =
               d1 |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(err) =~ "草稿"

      # 草稿应走删除而非作废
      d1 |> Ash.Changeset.for_destroy(:destroy, %{}) |> Ash.destroy!(authorize?: false)

      d2 = demand!(company)
      item!(d2, material, kg)
      d2 = d2 |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
      d2 = d2 |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert d2.status == :voided
    end

    test "仅草稿可改可删", %{company: company, material: material, kg: kg} do
      d = demand!(company)
      item!(d, material, kg)
      d = d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      assert {:error, _} =
               d
               |> Ash.Changeset.for_update(:update, %{remarks: "x"})
               |> Ash.update(authorize?: false)
    end
  end

  describe "四态履约与完成" do
    test "外购/委外/库存可点完成;自制不可", %{company: company, material: material, kg: kg} do
      d = demand!(company)

      buy =
        item!(d, material, kg, %{idx: 1, fulfillment_method: :buy})

      outsource =
        item!(d, material, kg, %{idx: 2, fulfillment_method: :outsource})

      stock =
        item!(d, material, kg, %{idx: 3, fulfillment_method: :stock})

      make =
        item!(d, material, kg, %{idx: 4, fulfillment_method: :make})

      _d = d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      buy = buy |> Ash.Changeset.for_update(:complete, %{}) |> Ash.update!(authorize?: false)
      assert buy.status == :completed

      outsource =
        outsource |> Ash.Changeset.for_update(:complete, %{}) |> Ash.update!(authorize?: false)

      assert outsource.status == :completed

      stock = stock |> Ash.Changeset.for_update(:complete, %{}) |> Ash.update!(authorize?: false)
      assert stock.status == :completed

      assert {:error, _} =
               make |> Ash.Changeset.for_update(:complete, %{}) |> Ash.update(authorize?: false)
    end

    test "手工无销售来源行合法", %{company: company, material: material, kg: kg} do
      d = demand!(company)
      item = item!(d, material, kg)
      assert is_nil(item.sales_order_item_id)
      assert Decimal.equal?(item.base_qty, Decimal.new(10))
    end
  end

  describe "销售占用" do
    test "纳入成功与两草稿合计超占失败", %{
      company: company,
      material: material,
      kg: kg,
      customer: customer
    } do
      {_order, so_item} = audited_sales_item!(company, customer, material, kg, 20)

      d1 = demand!(company)

      item!(d1, material, kg, %{
        sales_order_item_id: so_item.id,
        qty: Decimal.new(12)
      })

      d2 = demand!(company)

      assert {:error, _} =
               DemandItem
               |> Ash.Changeset.for_create(:create, %{
                 demand_id: d2.id,
                 idx: 1,
                 material_id: material.id,
                 unit_id: kg.id,
                 qty: Decimal.new(10),
                 fulfillment_method: :make,
                 sales_order_item_id: so_item.id
               })
               |> Ash.create(authorize?: false)

      # 剩余 8 可再占
      item!(d2, material, kg, %{
        sales_order_item_id: so_item.id,
        qty: Decimal.new(8)
      })

      assert Decimal.equal?(DemandItem.occupied_base_qty(so_item.id), Decimal.new(20))
    end

    test "作废需求单释放占用", %{
      company: company,
      material: material,
      kg: kg,
      customer: customer
    } do
      {_order, so_item} = audited_sales_item!(company, customer, material, kg, 10)

      d = demand!(company)

      item!(d, material, kg, %{
        sales_order_item_id: so_item.id,
        qty: Decimal.new(10)
      })

      assert Decimal.equal?(DemandItem.occupied_base_qty(so_item.id), Decimal.new(10))

      d = d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
      d |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert Decimal.equal?(DemandItem.occupied_base_qty(so_item.id), Decimal.new(0))
    end

    test "跨销售单勾选", %{company: company, material: material, kg: kg, customer: customer} do
      {_o1, i1} = audited_sales_item!(company, customer, material, kg, 5)
      {_o2, i2} = audited_sales_item!(company, customer, material, kg, 7)

      d = demand!(company)
      item!(d, material, kg, %{idx: 1, sales_order_item_id: i1.id, qty: Decimal.new(5)})
      item!(d, material, kg, %{idx: 2, sales_order_item_id: i2.id, qty: Decimal.new(7)})

      d = d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
      assert d.status == :confirmed
    end

    test "占用边界:恰好占满成功,再占一单位被拒", %{
      company: company,
      material: material,
      kg: kg,
      customer: customer
    } do
      {_order, so_item} = audited_sales_item!(company, customer, material, kg, 10)

      d1 = demand!(company)

      item!(d1, material, kg, %{
        sales_order_item_id: so_item.id,
        qty: Decimal.new(10)
      })

      assert Decimal.equal?(DemandItem.remaining_occupiable(so_item.id), Decimal.new(0))

      d2 = demand!(company)

      assert {:error, _} =
               DemandItem
               |> Ash.Changeset.for_create(:create, %{
                 demand_id: d2.id,
                 idx: 1,
                 material_id: material.id,
                 unit_id: kg.id,
                 qty: Decimal.new(1),
                 fulfillment_method: :make,
                 sales_order_item_id: so_item.id
               })
               |> Ash.create(authorize?: false)
    end

    test "占用查询动作:订购/已占用/剩余可占用", %{
      company: company,
      material: material,
      kg: kg,
      customer: customer
    } do
      {_order, so_item} = audited_sales_item!(company, customer, material, kg, 10)

      d = demand!(company)

      item!(d, material, kg, %{
        sales_order_item_id: so_item.id,
        qty: Decimal.new(4)
      })

      assert {:ok, [row]} =
               DemandItem
               |> Ash.ActionInput.for_action(:sales_item_occupancy, %{
                 sales_order_item_ids: [so_item.id]
               })
               |> Ash.run_action(authorize?: false)

      assert row["salesOrderItemId"] == so_item.id
      assert row["orderedBaseQty"] == "10"
      assert row["occupiedBaseQty"] == "4"
      assert row["remainingBaseQty"] == "6"
    end

    test "并发纳入同一销售条目:合计超占仅一条成功", %{
      company: company,
      material: material,
      kg: kg,
      customer: customer
    } do
      {_order, so_item} = audited_sales_item!(company, customer, material, kg, 10)

      d1 = demand!(company)
      d2 = demand!(company)

      # shared 沙箱下两任务共用一条连接、语句串行执行;占用复检对销售条目行
      # 加 FOR UPDATE 锁后,合计超占必有一条被拒。单连接沙箱无法复现真实多连接
      # 竞态,本用例钉死「并发提交合计超占 → 恰好一条成功」的行为契约。
      Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, {:shared, self()})

      results =
        [d1, d2]
        |> Task.async_stream(
          fn d ->
            DemandItem
            |> Ash.Changeset.for_create(:create, %{
              demand_id: d.id,
              idx: 1,
              material_id: material.id,
              unit_id: kg.id,
              qty: Decimal.new(8),
              fulfillment_method: :make,
              sales_order_item_id: so_item.id
            })
            |> Ash.create(authorize?: false)
          end,
          max_concurrency: 2
        )
        |> Enum.map(fn {:ok, result} -> result end)

      assert Enum.count(results, &match?({:ok, _}, &1)) == 1
      assert Enum.count(results, &match?({:error, _}, &1)) == 1
      assert Decimal.equal?(DemandItem.occupied_base_qty(so_item.id), Decimal.new(8))
    end
  end

  describe "生产工单" do
    test "确认自制行可生成;二次生成失败;确认前不可生成", %{
      company: company,
      material: material,
      kg: kg
    } do
      d = demand!(company)
      item = item!(d, material, kg)

      assert {:error, _} =
               WorkOrder
               |> Ash.Changeset.for_create(:create, %{
                 demand_item_id: item.id,
                 work_order_no: "WO-#{System.unique_integer([:positive])}"
               })
               |> Ash.create(authorize?: false)

      d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      wo =
        WorkOrder
        |> Ash.Changeset.for_create(:create, %{
          demand_item_id: item.id,
          work_order_no: "WO-#{System.unique_integer([:positive])}"
        })
        |> Ash.create!(authorize?: false)

      assert wo.status == :in_progress
      assert Decimal.equal?(wo.qty, Decimal.new(10))
      assert Decimal.equal?(wo.received_base_qty, Decimal.new(0))
      assert is_nil(Map.get(wo, :customer_id))

      item = Ash.get!(DemandItem, item.id, authorize?: false)
      assert item.status == :scheduled

      assert {:error, _} =
               WorkOrder
               |> Ash.Changeset.for_create(:create, %{
                 demand_item_id: item.id,
                 work_order_no: "WO-#{System.unique_integer([:positive])}"
               })
               |> Ash.create(authorize?: false)
    end

    test "无入库可作废工单并回写待安排;有未作废工单不可作废需求单", %{
      company: company,
      material: material,
      kg: kg
    } do
      d = demand!(company)
      item = item!(d, material, kg)
      d = d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      wo =
        WorkOrder
        |> Ash.Changeset.for_create(:create, %{
          demand_item_id: item.id,
          work_order_no: "WO-#{System.unique_integer([:positive])}"
        })
        |> Ash.create!(authorize?: false)

      assert {:error, _} =
               d |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      wo = wo |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert wo.status == :voided

      item = Ash.get!(DemandItem, item.id, authorize?: false)
      assert item.status == :pending

      # 可再生成
      wo2 =
        WorkOrder
        |> Ash.Changeset.for_create(:create, %{
          demand_item_id: item.id,
          work_order_no: "WO-#{System.unique_integer([:positive])}"
        })
        |> Ash.create!(authorize?: false)

      assert wo2.status == :in_progress
    end
  end

  describe "生产入库" do
    defp confirmed_wo!(company, material, unit) do
      d = demand!(company)
      item = item!(d, material, unit)
      d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      WorkOrder
      |> Ash.Changeset.for_create(:create, %{
        demand_item_id: item.id,
        work_order_no: "WO-#{System.unique_integer([:positive])}"
      })
      |> Ash.create!(authorize?: false)
    end

    defp output_with_line!(company, warehouse, wo, _material, unit, qty) do
      out =
        Output
        |> Ash.Changeset.for_create(:create, %{
          company_id: company.id,
          output_no: "MR-#{System.unique_integer([:positive])}",
          output_date: ~D[2026-07-22],
          warehouse_id: warehouse.id
        })
        |> Ash.create!(authorize?: false)

      OutputItem
      |> Ash.Changeset.for_create(:create, %{
        output_id: out.id,
        idx: 1,
        work_order_id: wo.id,
        unit_id: unit.id,
        qty: Decimal.new(qty),
        warehouse_id: warehouse.id
      })
      |> Ash.create!(authorize?: false)

      out
    end

    test "分次入库、分录正数、满量完工回写", %{
      company: company,
      material: material,
      kg: kg,
      warehouse: warehouse
    } do
      wo = confirmed_wo!(company, material, kg)

      out1 = output_with_line!(company, warehouse, wo, material, kg, 6)
      out1 = out1 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert out1.status == :audited

      wo = Ash.get!(WorkOrder, wo.id, authorize?: false)
      assert Decimal.equal?(wo.received_base_qty, Decimal.new(6))
      assert wo.status == :in_progress

      entries =
        StockEntry
        |> Ash.Query.filter(voucher_type == "mfg.output" and voucher_id == ^out1.id)
        |> Ash.read!(authorize?: false)

      assert length(entries) == 1
      assert Decimal.equal?(hd(entries).quantity, Decimal.new(6))
      refute hd(entries).is_cancelled

      out2 = output_with_line!(company, warehouse, wo, material, kg, 4)
      out2 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      wo = Ash.get!(WorkOrder, wo.id, authorize?: false)
      assert Decimal.equal?(wo.received_base_qty, Decimal.new(10))
      assert wo.status == :completed

      item = Ash.get!(DemandItem, wo.demand_item_id, authorize?: false)
      assert item.status == :completed
    end

    test "超入比例 0 禁超入;比例 >0 容差内成功", %{
      company: company,
      material: material,
      kg: kg,
      warehouse: warehouse
    } do
      wo = confirmed_wo!(company, material, kg)

      out = output_with_line!(company, warehouse, wo, material, kg, 11)

      assert {:error, _} =
               out |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      Setting.get()
      |> Ash.Changeset.for_update(:update, %{output_overreceive_ratio: Decimal.new("0.2")})
      |> Ash.update!(authorize?: false)

      out |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      wo = Ash.get!(WorkOrder, wo.id, authorize?: false)
      assert Decimal.equal?(wo.received_base_qty, Decimal.new(11))
      assert wo.status == :completed

      # 恢复默认,避免污染同进程其它用例(async 各库沙箱,但仍好还原)
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{output_overreceive_ratio: Decimal.new(0)})
      |> Ash.update!(authorize?: false)
    end

    test "作废回滚分录与已入;有已审核入库不可作废工单", %{
      company: company,
      material: material,
      kg: kg,
      warehouse: warehouse
    } do
      wo = confirmed_wo!(company, material, kg)
      out = output_with_line!(company, warehouse, wo, material, kg, 5)
      out = out |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert {:error, _} =
               wo |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      out = out |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert out.status == :voided

      entries =
        StockEntry
        |> Ash.Query.filter(voucher_type == "mfg.output" and voucher_id == ^out.id)
        |> Ash.read!(authorize?: false)

      assert Enum.all?(entries, & &1.is_cancelled)

      wo = Ash.get!(WorkOrder, wo.id, authorize?: false)
      assert Decimal.equal?(wo.received_base_qty, Decimal.new(0))
      assert wo.status == :in_progress

      item = Ash.get!(DemandItem, wo.demand_item_id, authorize?: false)
      assert item.status == :scheduled
    end
  end
end
