defmodule SynieCore.Purchase.DemandLinkageTest do
  @moduledoc """
  履约需求与采购/委外串联集成测试(ADR 2026-07-25)。

  主接缝:Ash 资源外部行为——勾选带入字段、审核投影/容差/复核、作废回滚、
  下游约束、入库回写完成闭环、点完成拦截。
  """

  # async: false — 超下单比例测试会改共享 sal_setting 种子行
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, Warehouse}

  alias SynieCore.Mfg.{Demand, DemandItem}

  alias SynieCore.Purchase.{
    Order,
    OrderItem,
    Receipt,
    ReceiptItem,
    Supplier
  }

  alias SynieCore.Sales.Setting

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    supplier = supplier!()

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-dl#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "D#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material =
      Ash.Seed.seed!(Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "铜杆",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    warehouse =
      Warehouse
      |> Ash.Changeset.for_create(:create, %{name: "收货仓", company_id: company.id})
      |> Ash.create!(authorize?: false)

    %{
      company: company,
      supplier: supplier,
      kg: kg,
      material: material,
      warehouse: warehouse
    }
  end

  defp supplier! do
    Supplier
    |> Ash.Changeset.for_create(:create, %{
      code: "S-#{System.unique_integer([:positive])}",
      name: "测试供应商"
    })
    |> Ash.create!(authorize?: false)
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

  defp demand_item!(demand, material, unit, attrs \\ %{}) do
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
          fulfillment_method: :buy
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp confirmed_buy_line!(company, material, unit, attrs \\ %{}) do
    d = demand!(company)
    item = demand_item!(d, material, unit, attrs)
    d = d |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
    {d, item}
  end

  defp confirmed_outsource_line!(company, material, unit, attrs \\ %{}) do
    confirmed_buy_line!(company, material, unit, Map.put(attrs, :fulfillment_method, :outsource))
  end

  defp spot_order!(company, supplier, attrs \\ %{}) do
    Order
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          order_no: "PO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-20],
          order_type: :spot,
          company_id: company.id,
          party_type: :supplier,
          party_id: supplier.id,
          is_outsourced: false
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp order_item!(order, material, unit, attrs \\ %{}) do
    OrderItem
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          order_id: order.id,
          idx: 1,
          material_id: material.id,
          unit_id: unit.id,
          qty: Decimal.new(10),
          price: Decimal.new("10.00"),
          tax_rate: Decimal.new("0.13")
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp reload_demand_item!(id) do
    DemandItem
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.load([:ordered])
    |> Ash.read_one!(authorize?: false)
  end

  defp account!(company, code, name, role) do
    SynieCore.Base.Account
    |> Ash.Changeset.for_create(:create, %{
      company_id: company.id,
      code: "#{code}-#{System.unique_integer([:positive])}",
      name: name,
      direction: :credit,
      role: role
    })
    |> Ash.create!(authorize?: false)
  end

  describe "勾选带入" do
    test "带入落字段:数量/需求日/来源需求行", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {_d, line} = confirmed_buy_line!(company, material, kg, %{qty: Decimal.new(10), need_date: ~D[2026-08-01]})
      order = spot_order!(company, supplier)

      item =
        order_item!(order, material, kg, %{
          qty: Decimal.new(6),
          demand_line_id: line.id,
          demand_date: ~D[2026-08-01]
        })

      assert item.demand_line_id == line.id
      assert item.demand_date == ~D[2026-08-01]
      assert Decimal.equal?(item.qty, Decimal.new(6))
    end

    test "池查询:外购单只列外购行,委外单只列委外行", %{
      company: company,
      material: material,
      kg: kg
    } do
      {_d1, buy} = confirmed_buy_line!(company, material, kg)
      {_d2, out} = confirmed_outsource_line!(company, material, kg)

      assert {:ok, buy_pool} =
               OrderItem
               |> Ash.ActionInput.for_action(:demand_line_pool, %{
                 company_id: company.id,
                 is_outsourced: false
               })
               |> Ash.run_action(authorize?: false)

      buy_ids = Enum.map(buy_pool, & &1["demandLineId"])
      assert buy.id in buy_ids
      refute out.id in buy_ids

      assert {:ok, out_pool} =
               OrderItem
               |> Ash.ActionInput.for_action(:demand_line_pool, %{
                 company_id: company.id,
                 is_outsourced: true
               })
               |> Ash.run_action(authorize?: false)

      out_ids = Enum.map(out_pool, & &1["demandLineId"])
      assert out.id in out_ids
      refute buy.id in out_ids
    end
  end

  describe "审核投影与容差" do
    test "草稿不占量;审核累加已下单;作废回滚", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {_d, line} = confirmed_buy_line!(company, material, kg, %{qty: Decimal.new(10)})
      order = spot_order!(company, supplier)

      order_item!(order, material, kg, %{
        qty: Decimal.new(4),
        demand_line_id: line.id,
        demand_date: ~D[2026-07-25]
      })

      line = reload_demand_item!(line.id)
      assert Decimal.equal?(line.ordered_qty, Decimal.new(0))
      assert line.ordered == false

      order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert order.status == :audited

      line = reload_demand_item!(line.id)
      assert Decimal.equal?(line.ordered_qty, Decimal.new(4))
      assert line.ordered == true

      order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      line = reload_demand_item!(line.id)
      assert Decimal.equal?(line.ordered_qty, Decimal.new(0))
      assert line.ordered == false
    end

    test "超下单比例 0 拒审;配置比例后放行", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {_d, line} = confirmed_buy_line!(company, material, kg, %{qty: Decimal.new(10)})
      order = spot_order!(company, supplier)

      order_item!(order, material, kg, %{
        qty: Decimal.new(11),
        demand_line_id: line.id
      })

      assert {:error, err} =
               order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(err) =~ "超出需求可下单"

      setting = Setting.get()

      setting
      |> Ash.Changeset.for_update(:update, %{demand_overorder_ratio: Decimal.new("0.2")})
      |> Ash.update!(authorize?: false)

      order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert order.status == :audited

      line = reload_demand_item!(line.id)
      assert Decimal.equal?(line.ordered_qty, Decimal.new(11))

      # 还原设置,避免污染其它测试(async true 但共享 seed 行)
      setting
      |> Ash.Changeset.for_update(:update, %{demand_overorder_ratio: Decimal.new(0)})
      |> Ash.update!(authorize?: false)
    end

    test "两张草稿挂同一行;后审核撞容差", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {_d, line} = confirmed_buy_line!(company, material, kg, %{qty: Decimal.new(10)})

      o1 = spot_order!(company, supplier)
      o2 = spot_order!(company, supplier)

      order_item!(o1, material, kg, %{qty: Decimal.new(7), demand_line_id: line.id})
      order_item!(o2, material, kg, %{qty: Decimal.new(7), demand_line_id: line.id})

      o1 = o1 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert o1.status == :audited

      assert {:error, _} =
               o2 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      line = reload_demand_item!(line.id)
      assert Decimal.equal?(line.ordered_qty, Decimal.new(7))
    end

    test "审核复核:行已完成拒审", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {_d, line} = confirmed_buy_line!(company, material, kg)
      # 无下单量可手工点完成
      line = line |> Ash.Changeset.for_update(:complete, %{}) |> Ash.update!(authorize?: false)
      assert line.status == :completed

      order = spot_order!(company, supplier)
      order_item!(order, material, kg, %{qty: Decimal.new(5), demand_line_id: line.id})

      assert {:error, err} =
               order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(err) =~ "已完成"
    end

    test "审核复核:履约方式不匹配拒审", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {_d, line} = confirmed_outsource_line!(company, material, kg)
      # 普通采购单挂委外需求行
      order = spot_order!(company, supplier, %{is_outsourced: false})
      order_item!(order, material, kg, %{qty: Decimal.new(5), demand_line_id: line.id})

      assert {:error, err} =
               order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(err) =~ "履约方式"
    end

    test "委外订单审核累加已下单", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {_d, line} = confirmed_outsource_line!(company, material, kg, %{qty: Decimal.new(10)})
      order = spot_order!(company, supplier, %{is_outsourced: true})

      order_item!(order, material, kg, %{
        qty: Decimal.new(5),
        demand_line_id: line.id,
        demand_date: ~D[2026-07-25]
      })

      order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      line = reload_demand_item!(line.id)
      assert Decimal.equal?(line.ordered_qty, Decimal.new(5))
      assert line.ordered == true
    end
  end

  describe "下游约束" do
    test "有已审核订单条目:改履约方式被拒、需求单作废被拒;仅草稿不挡", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {demand, line} = confirmed_buy_line!(company, material, kg)
      draft = spot_order!(company, supplier)
      order_item!(draft, material, kg, %{qty: Decimal.new(3), demand_line_id: line.id})

      # 仅草稿引用:可改履约方式
      line =
        line
        |> Ash.Changeset.for_update(:change_fulfillment, %{fulfillment_method: :stock})
        |> Ash.update!(authorize?: false)

      assert line.fulfillment_method == :stock

      # 改回外购再挂已审核订单
      line =
        line
        |> Ash.Changeset.for_update(:change_fulfillment, %{fulfillment_method: :buy})
        |> Ash.update!(authorize?: false)

      audited = spot_order!(company, supplier)
      order_item!(audited, material, kg, %{qty: Decimal.new(4), demand_line_id: line.id})
      audited |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert {:error, err} =
               line
               |> Ash.Changeset.for_update(:change_fulfillment, %{fulfillment_method: :stock})
               |> Ash.update(authorize?: false)

      assert Exception.message(err) =~ "采购"

      assert {:error, err2} =
               demand |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(err2) =~ "采购"
    end
  end

  describe "点完成前置" do
    test "无下单量可行;有下单量被拒;库存行不受影响", %{
      company: company,
      supplier: supplier,
      material: material,
      kg: kg
    } do
      {_d, buy} = confirmed_buy_line!(company, material, kg)
      buy = buy |> Ash.Changeset.for_update(:complete, %{}) |> Ash.update!(authorize?: false)
      assert buy.status == :completed

      {_d2, buy2} = confirmed_buy_line!(company, material, kg)
      order = spot_order!(company, supplier)
      order_item!(order, material, kg, %{qty: Decimal.new(5), demand_line_id: buy2.id})
      order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert {:error, err} =
               buy2 |> Ash.Changeset.for_update(:complete, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(err) =~ "已下单"

      d3 = demand!(company)
      stock = demand_item!(d3, material, kg, %{fulfillment_method: :stock})
      d3 |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      stock = stock |> Ash.Changeset.for_update(:complete, %{}) |> Ash.update!(authorize?: false)
      assert stock.status == :completed
    end
  end

  describe "入库回写" do
    setup %{company: company, supplier: supplier, material: material, kg: kg, warehouse: warehouse} do
      debit = account!(company, "1405D#{System.unique_integer([:positive])}", "库存", nil)

      credit =
        account!(company, "2202D#{System.unique_integer([:positive])}", "未开票应付", :unbilled_payable)

      {_d, demand_line} = confirmed_buy_line!(company, material, kg, %{qty: Decimal.new(10)})
      order = spot_order!(company, supplier)

      oi =
        order_item!(order, material, kg, %{
          qty: Decimal.new(10),
          demand_line_id: demand_line.id
        })

      order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      %{
        demand_line: demand_line,
        order: order,
        order_item: oi,
        warehouse: warehouse,
        supplier: supplier,
        material: material,
        kg: kg,
        debit: debit,
        credit: credit
      }
    end

    defp receipt!(company, supplier, debit, credit) do
      Receipt
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        party_type: :supplier,
        party_id: supplier.id,
        receipt_date: ~D[2026-07-21],
        receipt_no: "PR-#{System.unique_integer([:positive])}",
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })
      |> Ash.create!(authorize?: false)
    end

    defp receipt_item!(receipt, order_item, material, unit, warehouse, qty) do
      ReceiptItem
      |> Ash.Changeset.for_create(:create, %{
        receipt_id: receipt.id,
        order_item_id: order_item.id,
        material_id: material.id,
        unit_id: unit.id,
        warehouse_id: warehouse.id,
        idx: 1,
        qty: Decimal.new(qty)
      })
      |> Ash.create!(authorize?: false)
    end

    test "分次回写已收、满量自动完成、作废回退", %{
      company: company,
      supplier: supplier,
      warehouse: warehouse,
      material: material,
      kg: kg,
      demand_line: demand_line,
      order_item: oi,
      debit: debit,
      credit: credit
    } do
      r1 = receipt!(company, supplier, debit, credit)
      receipt_item!(r1, oi, material, kg, warehouse, 4)

      r1 = r1 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert r1.status == :audited

      demand_line = reload_demand_item!(demand_line.id)
      assert Decimal.equal?(demand_line.received_qty, Decimal.new(4))
      assert demand_line.status == :pending

      r2 = receipt!(company, supplier, debit, credit)
      receipt_item!(r2, oi, material, kg, warehouse, 6)

      r2 = r2 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert r2.status == :audited

      demand_line = reload_demand_item!(demand_line.id)
      assert Decimal.equal?(demand_line.received_qty, Decimal.new(10))
      assert demand_line.status == :completed
      assert demand_line.ordered == false

      # 作废第二批 → 已收回退、完成回退
      r2 |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      demand_line = reload_demand_item!(demand_line.id)
      assert Decimal.equal?(demand_line.received_qty, Decimal.new(4))
      assert demand_line.status == :pending
      assert demand_line.ordered == true
    end
  end
end
