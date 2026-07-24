defmodule SynieCore.Purchase.OutsourcedReceiptTest do
  @moduledoc """
  委外入库单(工单05)。接缝与断言口径同 receipt_test.exs/outsourced_issue_test.exs——
  Ash action 层直连,断言事实表(库存分录/总账分录)、受控投影
  (已收数量/已对账数量)与报错文案。
  """

  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.GlEntry
  alias SynieCore.Authz
  alias SynieCore.Base.{Account, Currency, Unit}

  alias SynieCore.Inv.{
    Material,
    MaterialCategory,
    StockDoc,
    StockDocItem,
    StockEntry,
    Warehouse
  }

  alias SynieCore.Purchase.{
    Order,
    OrderItem,
    OrderItemByproduct,
    OrderItemMaterial,
    OutsourcedReceipt,
    OutsourcedReceiptItem,
    OutsourcedReceiptItemByproduct,
    OutsourcedReceiptItemMaterial,
    Reconciliation,
    ReconciliationItem,
    Supplier
  }

  alias SynieCore.Sales.{CompanyAccountDefault, Setting}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    supplier = supplier!()

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-or#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "OR#{System.unique_integer([:positive])}",
        name: "委外料"
      })
      |> Ash.create!(authorize?: false)

    product = material!(leaf, kg, "成品网筒")
    raw = material!(leaf, kg, "铜丝")
    byprod = material!(leaf, kg, "铜屑")

    wh = warehouse!(company, "成品仓")

    outsourced_wh =
      Warehouse
      |> Ash.Changeset.for_create(:create, %{
        name: "外协仓-#{supplier.name}-#{System.unique_integer([:positive])}",
        company_id: company.id,
        is_outsourced: true,
        party_type: :supplier,
        party_id: supplier.id
      })
      |> Ash.create!(authorize?: false)

    debit = account!(company, "1405", "库存商品", nil)
    credit = account!(company, "2202U", "未开票应付", :unbilled_payable)
    Process.put(:test_oreceipt_debit_id, debit.id)
    Process.put(:test_oreceipt_credit_id, credit.id)

    {order, order_item, material_line, byproduct_line} =
      audited_order!(company, supplier, product, raw, byprod, kg)

    %{
      company: company,
      supplier: supplier,
      kg: kg,
      product: product,
      raw: raw,
      byprod: byprod,
      wh: wh,
      outsourced_wh: outsourced_wh,
      debit: debit,
      credit: credit,
      order: order,
      order_item: order_item,
      material_line: material_line,
      byproduct_line: byproduct_line
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

  defp material!(leaf, unit, name) do
    Ash.Seed.seed!(Material, %{
      code: "MAT-#{System.unique_integer([:positive])}",
      name: name,
      category_id: leaf.id,
      default_unit_id: unit.id
    })
  end

  defp warehouse!(company, name, attrs \\ %{}) do
    Warehouse
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{name: "#{name}-#{System.unique_integer([:positive])}", company_id: company.id},
        Map.new(attrs)
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp account!(company, code, name, role) do
    Account
    |> Ash.Changeset.for_create(:create, %{
      code: "#{code}-#{System.unique_integer([:positive])}",
      name: name,
      direction: :credit,
      company_id: company.id,
      role: role
    })
    |> Ash.create!(authorize?: false)
  end

  # 已审核零星委外订单:成品条目 10×100(加工费) + 发料清单(铜丝 20) + 副产物清单(铜屑 5)
  defp audited_order!(company, supplier, product, raw, byprod, unit, attrs \\ %{}) do
    order =
      Order
      |> Ash.Changeset.for_create(
        :create,
        Map.merge(
          %{
            order_no: "PO-#{System.unique_integer([:positive])}",
            order_date: ~D[2026-07-24],
            order_type: :spot,
            is_outsourced: true,
            company_id: company.id,
            party_type: :supplier,
            party_id: supplier.id
          },
          Map.new(attrs)
        )
      )
      |> Ash.create!(authorize?: false)

    order_item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: product.id,
        unit_id: unit.id,
        qty: Decimal.new(10),
        price: Decimal.new("100.00"),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    material_line =
      OrderItemMaterial
      |> Ash.Changeset.for_create(:create, %{
        order_item_id: order_item.id,
        material_id: raw.id,
        unit_id: unit.id,
        quantity: Decimal.new(20)
      })
      |> Ash.create!(authorize?: false)

    byproduct_line =
      OrderItemByproduct
      |> Ash.Changeset.for_create(:create, %{
        order_item_id: order_item.id,
        material_id: byprod.id,
        unit_id: unit.id,
        quantity: Decimal.new(5)
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    {order, order_item, material_line, byproduct_line}
  end

  defp receipt!(attrs) do
    # 草稿科目必填:默认带 setup 里的借贷科;显式传入可覆盖
    attrs =
      Map.merge(
        %{
          receipt_no: "ORN-#{System.unique_integer([:positive])}",
          receipt_date: ~D[2026-07-24],
          debit_account_id: Process.get(:test_oreceipt_debit_id),
          credit_account_id: Process.get(:test_oreceipt_credit_id)
        },
        attrs
      )

    OutsourcedReceipt |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp item!(receipt, attrs) do
    OutsourcedReceiptItem
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{idx: 1, qty: Decimal.new(5)}, attrs) |> Map.put(:receipt_id, receipt.id)
    )
    |> Ash.create!(authorize?: false)
  end

  defp material_rows(item_id) do
    OutsourcedReceiptItemMaterial
    |> Ash.Query.filter(receipt_item_id == ^item_id)
    |> Ash.read!(authorize?: false)
  end

  defp byproduct_rows(item_id) do
    OutsourcedReceiptItemByproduct
    |> Ash.Query.filter(receipt_item_id == ^item_id)
    |> Ash.read!(authorize?: false)
  end

  # 经手工出入库单审核给仓垫库存(direction :in 入库 / :out 出库)
  defp stock_move!(warehouse, material, unit, direction, qty) do
    doc =
      StockDoc
      |> Ash.Changeset.for_create(:create, %{
        doc_no: "IO-#{System.unique_integer([:positive])}",
        company_id: warehouse.company_id,
        warehouse_id: warehouse.id,
        direction: direction,
        doc_date: ~D[2026-07-24]
      })
      |> Ash.create!(authorize?: false)

    StockDocItem
    |> Ash.Changeset.for_create(:create, %{
      stock_doc_id: doc.id,
      idx: 1,
      material_id: material.id,
      unit_id: unit.id,
      qty: qty
    })
    |> Ash.create!(authorize?: false)

    doc |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
  end

  defp entries(receipt_id) do
    StockEntry
    |> Ash.Query.filter(
      voucher_type == "purchase.outsourced_receipt" and voucher_id == ^receipt_id
    )
    |> Ash.read!(authorize?: false)
  end

  defp gl_entries(receipt_id) do
    GlEntry
    |> Ash.Query.filter(
      voucher_type == "purchase.outsourced_receipt" and voucher_id == ^receipt_id
    )
    |> Ash.read!(authorize?: false)
  end

  defp reload_item(item), do: Ash.get!(OrderItem, item.id, authorize?: false)

  describe "建单与取行" do
    test "单号留空按编号规则自动取号(独立系列随迁移种子)", ctx do
      receipt =
        OutsourcedReceipt
        |> Ash.Changeset.for_create(:create, %{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          receipt_date: ~D[2026-07-24],
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })
        |> Ash.create!(authorize?: false)

      assert receipt.receipt_no =~ ~r/^P[(]O[)]-/
    end

    test "行必挂委外订单条目,带出物料/单位并冻结订单条目快照,折算数量系统算", ctx do
      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        item!(receipt, %{
          order_item_id: ctx.order_item.id,
          warehouse_id: ctx.wh.id,
          qty: Decimal.new(4),
          remarks: "首批"
        })

      assert item.material_id == ctx.product.id
      assert item.unit_id == ctx.kg.id
      assert item.company_id == ctx.company.id
      assert Decimal.equal?(item.base_qty, Decimal.new(4))
      # 订单条目快照
      assert item.order_no == ctx.order.order_no
      assert Decimal.equal?(item.order_base_qty, Decimal.new(10))
      assert Decimal.equal?(item.order_price, Decimal.new("100.00"))
      assert Decimal.equal?(item.order_base_amount, Decimal.new("1000.00"))
      assert item.order_currency_code != nil
    end

    test "非委外订单条目不可取行", ctx do
      {_order, plain_item, _ml, _bl} =
        audited_order!(ctx.company, ctx.supplier, ctx.product, ctx.raw, ctx.byprod, ctx.kg,
          is_outsourced: false
        )

      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      assert {:error, error} =
               OutsourcedReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: receipt.id,
                 idx: 1,
                 order_item_id: plain_item.id,
                 qty: Decimal.new(1),
                 warehouse_id: ctx.wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅委外订单条目可取行"
    end

    test "订单未审核/对手不一致/公司不一致被拒", ctx do
      # 草稿订单
      draft_order =
        Order
        |> Ash.Changeset.for_create(:create, %{
          order_no: "PO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-24],
          order_type: :spot,
          is_outsourced: true,
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id
        })
        |> Ash.create!(authorize?: false)

      draft_item =
        OrderItem
        |> Ash.Changeset.for_create(:create, %{
          order_id: draft_order.id,
          idx: 1,
          material_id: ctx.product.id,
          unit_id: ctx.kg.id,
          qty: Decimal.new(1),
          price: Decimal.new("1.00")
        })
        |> Ash.create!(authorize?: false)

      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      assert {:error, error} =
               OutsourcedReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: receipt.id,
                 idx: 1,
                 order_item_id: draft_item.id,
                 qty: Decimal.new(1),
                 warehouse_id: ctx.wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅已审核订单可入库"

      # 对手不一致
      other_supplier = supplier!()

      receipt2 =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: other_supplier.id
        })

      assert {:error, error} =
               OutsourcedReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: receipt2.id,
                 idx: 1,
                 order_item_id: ctx.order_item.id,
                 qty: Decimal.new(1),
                 warehouse_id: ctx.wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "订单对手与入库单不一致"

      # 公司不一致
      other_company = company!()

      receipt3 =
        receipt!(%{
          company_id: other_company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          debit_account_id: account!(other_company, "1405", "库存商品", nil).id,
          credit_account_id: account!(other_company, "2202U", "未开票应付", :unbilled_payable).id
        })

      assert {:error, error} =
               OutsourcedReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: receipt3.id,
                 idx: 1,
                 order_item_id: ctx.order_item.id,
                 qty: Decimal.new(1),
                 warehouse_id: warehouse!(other_company, "成品仓").id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "订单公司与入库单不一致"
    end

    test "可跨多张同公司同对手同币种委外订单取行", ctx do
      {_order2, item2, _ml2, _bl2} =
        audited_order!(ctx.company, ctx.supplier, ctx.product, ctx.raw, ctx.byprod, ctx.kg)

      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 1})

      item2_row =
        item!(receipt, %{idx: 2, order_item_id: item2.id, warehouse_id: ctx.wh.id, qty: 2})

      assert item2_row.order_item_id == item2.id
    end
  end

  describe "比例带出与手改" do
    test "按发料清单/副产物清单快照 × (本次入库量 ÷ 条目需求数量) 带出", ctx do
      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      # 入库 5 / 订购 10 → 比例 0.5:铜丝 20×0.5=10,铜屑 5×0.5=2.5
      item =
        item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      [mrow] = material_rows(item.id)
      assert mrow.order_item_material_id == ctx.material_line.id
      assert mrow.material_id == ctx.raw.id
      assert Decimal.equal?(mrow.qty, Decimal.new(10))
      assert Decimal.equal?(mrow.base_qty, Decimal.new(10))
      assert mrow.outsourced_warehouse_id == ctx.outsourced_wh.id
      assert mrow.order_no == ctx.order.order_no

      [brow] = byproduct_rows(item.id)
      assert brow.order_item_byproduct_id == ctx.byproduct_line.id
      assert brow.material_id == ctx.byprod.id
      assert Decimal.equal?(brow.qty, Decimal.new("2.5"))
      assert brow.warehouse_id == ctx.wh.id
    end

    test "头默认仓未填时带出行仓留空(草稿允许)", ctx do
      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      assert [ %{outsourced_warehouse_id: nil} ] = material_rows(item.id)
      assert [ %{warehouse_id: nil} ] = byproduct_rows(item.id)
    end

    test "带出后可手改:改数量/仓、删行、手工加行", ctx do
      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item =
        item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      [mrow] = material_rows(item.id)

      # 手改数量与仓
      other_out =
        warehouse!(ctx.company, "外协仓B",
          is_outsourced: true,
          party_type: :supplier,
          party_id: ctx.supplier.id
        )

      mrow =
        mrow
        |> Ash.Changeset.for_update(:update, %{
          qty: Decimal.new(7),
          outsourced_warehouse_id: other_out.id
        })
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(mrow.qty, Decimal.new(7))
      assert mrow.outsourced_warehouse_id == other_out.id

      # 删行
      :ok = mrow |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
      assert material_rows(item.id) == []

      # 手工加回(同条目发料清单行)
      added =
        OutsourcedReceiptItemMaterial
        |> Ash.Changeset.for_create(:create, %{
          receipt_item_id: item.id,
          idx: 2,
          order_item_material_id: ctx.material_line.id,
          qty: Decimal.new(3),
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })
        |> Ash.create!(authorize?: false)

      assert added.material_id == ctx.raw.id
      assert Decimal.equal?(added.qty, Decimal.new(3))

      # 副产物行亦可手删
      [brow] = byproduct_rows(item.id)
      :ok = brow |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
      assert byproduct_rows(item.id) == []
    end

    test "扣减行/副产物行须挂父条目同一订单条目的清单行", ctx do
      {_order2, item2, line2, bline2} =
        audited_order!(ctx.company, ctx.supplier, ctx.product, ctx.raw, ctx.byprod, ctx.kg)

      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 1})

      assert {:error, error} =
               OutsourcedReceiptItemMaterial
               |> Ash.Changeset.for_create(:create, %{
                 receipt_item_id: item.id,
                 idx: 9,
                 order_item_material_id: line2.id,
                 qty: Decimal.new(1),
                 outsourced_warehouse_id: ctx.outsourced_wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "发料清单行须属于入库条目的订单条目"

      assert {:error, error} =
               OutsourcedReceiptItemByproduct
               |> Ash.Changeset.for_create(:create, %{
                 receipt_item_id: item.id,
                 idx: 9,
                 order_item_byproduct_id: bline2.id,
                 qty: Decimal.new(1),
                 warehouse_id: ctx.wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "副产物清单行须属于入库条目的订单条目"

      # item2 的清单行挂到 item2 的入库条目则合法
      item2_row = item!(receipt, %{idx: 2, order_item_id: item2.id, warehouse_id: ctx.wh.id, qty: 1})

      assert OutsourcedReceiptItemMaterial
             |> Ash.Changeset.for_create(:create, %{
               receipt_item_id: item2_row.id,
               idx: 9,
               order_item_material_id: line2.id,
               qty: Decimal.new(1),
               outsourced_warehouse_id: ctx.outsourced_wh.id
             })
             |> Ash.create!(authorize?: false)
    end
  end

  describe "审核三副作用" do
    test "审核同事务:成品正分录＋材料扣减负分录＋副产物正分录,总账两行,已收累加", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id,
          remarks: "委外回库"
        })

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert receipt.status == :audited
      assert receipt.posting_date == ~D[2026-07-24]

      entries = entries(receipt.id)
      assert length(entries) == 3

      product_entry = Enum.find(entries, &(&1.material_id == ctx.product.id))
      assert product_entry.warehouse_id == ctx.wh.id
      assert Decimal.equal?(product_entry.quantity, Decimal.new(5))
      assert product_entry.remarks == "委外回库"

      raw_entry = Enum.find(entries, &(&1.material_id == ctx.raw.id))
      assert raw_entry.warehouse_id == ctx.outsourced_wh.id
      assert Decimal.equal?(raw_entry.quantity, Decimal.new(-10))

      byprod_entry = Enum.find(entries, &(&1.material_id == ctx.byprod.id))
      assert byprod_entry.warehouse_id == ctx.wh.id
      assert Decimal.equal?(byprod_entry.quantity, Decimal.new("2.5"))

      assert Enum.all?(entries, &(&1.is_cancelled == false))
      assert Enum.all?(entries, &(&1.voucher_no == receipt.receipt_no))

      # 总账:本币金额 5/10 × 1000 = 500;贷方(未开票应付)带对手,借方不带
      gl = gl_entries(receipt.id)
      assert length(gl) == 2
      debit_row = Enum.find(gl, &(Decimal.compare(&1.debit, 0) == :gt))
      credit_row = Enum.find(gl, &(Decimal.compare(&1.credit, 0) == :gt))
      assert Decimal.equal?(debit_row.debit, Decimal.new("500.00"))
      assert Decimal.equal?(credit_row.credit, Decimal.new("500.00"))
      assert credit_row.account_id == ctx.credit.id
      assert credit_row.party_id == ctx.supplier.id
      assert is_nil(debit_row.party_id)

      assert Decimal.equal?(reload_item(ctx.order_item).received_qty, Decimal.new(5))
    end

    test "手改后的扣减/副产物行按手改量过账", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item = item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      [mrow] = material_rows(item.id)

      mrow
      |> Ash.Changeset.for_update(:update, %{qty: Decimal.new(7)})
      |> Ash.update!(authorize?: false)

      [brow] = byproduct_rows(item.id)
      :ok = brow |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      entries = entries(receipt.id)
      assert length(entries) == 2

      raw_entry = Enum.find(entries, &(&1.material_id == ctx.raw.id))
      assert Decimal.equal?(raw_entry.quantity, Decimal.new(-7))
      refute Enum.any?(entries, &(&1.material_id == ctx.byprod.id))
    end

    test "三副作用同生同灭:外协仓材料不足整单拒,无半截账", ctx do
      # 外协仓只有 8,比例带出要扣 10
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(8))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      assert {:error, error} =
               receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "库存不足"
      assert Ash.get!(OutsourcedReceipt, receipt.id, authorize?: false).status == :draft
      # 无半截账:成品未入、总账未过、已收未加
      assert entries(receipt.id) == []
      assert gl_entries(receipt.id) == []
      assert Decimal.equal?(reload_item(ctx.order_item).received_qty, Decimal.new(0))
    end

    test "带出行仓为空审核拦截,补齐后放行", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item = item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      assert {:error, error} =
               receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "外协仓不能为空"

      [mrow] = material_rows(item.id)

      mrow
      |> Ash.Changeset.for_update(:update, %{outsourced_warehouse_id: ctx.outsourced_wh.id})
      |> Ash.update!(authorize?: false)

      [brow] = byproduct_rows(item.id)

      brow
      |> Ash.Changeset.for_update(:update, %{warehouse_id: ctx.wh.id})
      |> Ash.update!(authorize?: false)

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert receipt.status == :audited
      assert length(entries(receipt.id)) == 3
    end

    test "无行审核被拒;已审核不可重复审核", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      assert {:error, error} =
               receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "审核前必须至少填写一行入库条目"

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 1})

      receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外入库单可审核"
    end
  end

  describe "财务镜像" do
    test "草稿保存借贷科目必填", ctx do
      assert {:error, _} =
               OutsourcedReceipt
               |> Ash.Changeset.for_create(:create, %{
                 receipt_no: "ORN-#{System.unique_integer([:positive])}",
                 receipt_date: ~D[2026-07-24],
                 company_id: ctx.company.id,
                 party_type: :supplier,
                 party_id: ctx.supplier.id
               })
               |> Ash.create(authorize?: false)
    end

    test "贷方科目强制未开票应付角色", ctx do
      bad = account!(ctx.company, "2202", "应付账款", :payable)

      assert {:error, error} =
               OutsourcedReceipt
               |> Ash.Changeset.for_create(:create, %{
                 receipt_no: "ORN-#{System.unique_integer([:positive])}",
                 receipt_date: ~D[2026-07-24],
                 company_id: ctx.company.id,
                 party_type: :supplier,
                 party_id: ctx.supplier.id,
                 debit_account_id: ctx.debit.id,
                 credit_account_id: bad.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "贷方科目必须为未开票应付角色"
    end

    test "建单按公司默认过账科目整组代入(无默认则留空由必填兜底)", ctx do
      other_company = company!()
      d = account!(other_company, "1405", "库存商品", nil)
      c = account!(other_company, "2202U", "未开票应付", :unbilled_payable)

      CompanyAccountDefault
      |> Ash.Changeset.for_create(:create, %{
        company_id: other_company.id,
        receipt_debit_account_id: d.id,
        receipt_credit_account_id: c.id
      })
      |> Ash.create!(authorize?: false)

      receipt =
        OutsourcedReceipt
        |> Ash.Changeset.for_create(:create, %{
          receipt_no: "ORN-#{System.unique_integer([:positive])}",
          receipt_date: ~D[2026-07-24],
          company_id: other_company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id
        })
        |> Ash.create!(authorize?: false)

      assert receipt.debit_account_id == d.id
      assert receipt.credit_account_id == c.id
    end

    test "零加工费订单入库跳过总账,但科目仍必填;库存与已收照出", ctx do
      order =
        Order
        |> Ash.Changeset.for_create(:create, %{
          order_no: "PO-free-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-24],
          order_type: :spot,
          is_outsourced: true,
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id
        })
        |> Ash.create!(authorize?: false)

      free_item =
        OrderItem
        |> Ash.Changeset.for_create(:create, %{
          order_id: order.id,
          idx: 1,
          material_id: ctx.product.id,
          unit_id: ctx.kg.id,
          qty: Decimal.new(2),
          price: Decimal.new(0)
        })
        |> Ash.create!(authorize?: false)

      order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item!(receipt, %{order_item_id: free_item.id, warehouse_id: ctx.wh.id, qty: 2})

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert receipt.status == :audited
      assert gl_entries(receipt.id) == []
      assert length(entries(receipt.id)) == 1
      assert Decimal.equal?(reload_item(free_item).received_qty, Decimal.new(2))
    end

    test "外币委外订单按订单条目快照折算本币金额过总账", ctx do
      usd =
        Currency
        |> Ash.Changeset.for_create(:create, %{
          iso_code: "USD",
          name: "美元",
          symbol: "$"
        })
        |> Ash.create!(authorize?: false)

      {_order, order_item, _ml, _bl} =
        audited_order!(ctx.company, ctx.supplier, ctx.product, ctx.raw, ctx.byprod, ctx.kg,
          currency_id: usd.id,
          exchange_rate: Decimal.new(7)
        )

      order_item = Ash.get!(OrderItem, order_item.id, authorize?: false)
      # 10 × 100 × 7 = 7000 本币
      assert Decimal.equal?(order_item.base_amount, Decimal.new("7000.00"))

      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item!(receipt, %{order_item_id: order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      gl = gl_entries(receipt.id)
      assert length(gl) == 2
      debit_row = Enum.find(gl, &(Decimal.compare(&1.debit, 0) == :gt))
      assert Decimal.equal?(debit_row.debit, Decimal.new("3500.00"))
    end
  end

  describe "已收数量与超收容差" do
    test "超收默认 0% 审核拒绝;配置比例后放行", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(30))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 11})

      assert {:error, error} =
               receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "超出入库容差"
      assert Ash.get!(OutsourcedReceipt, receipt.id, authorize?: false).status == :draft

      Setting.get()
      |> Ash.Changeset.for_update(:update, %{receipt_overreceive_ratio: Decimal.new("0.2")})
      |> Ash.update!(authorize?: false)

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert receipt.status == :audited
      assert Decimal.equal?(reload_item(ctx.order_item).received_qty, Decimal.new(11))
    end
  end

  describe "对账池接入与作废拦截" do
    test "委外入库行进采购对账条目池:确认累加已对账,有已对账不可作废,撤回后可作废", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item = item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      recon =
        Reconciliation
        |> Ash.Changeset.for_create(:create, %{
          reconciliation_no: "PR-#{System.unique_integer([:positive])}",
          reconciliation_type: :regular,
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          debit_account_id: ctx.credit.id,
          credit_account_id: ctx.debit.id
        })
        |> Ash.create!(authorize?: false)

      ri =
        ReconciliationItem
        |> Ash.Changeset.for_create(:create, %{
          reconciliation_id: recon.id,
          idx: 1,
          outsourced_receipt_item_id: item.id,
          qty: Decimal.new(2)
        })
        |> Ash.create!(authorize?: false)

      # 行金额=对账数量×快照原币含税单价;base 按行比例折算;双来源 calculation 正常解析
      assert Decimal.equal?(ri.amount, Decimal.new("200.00"))
      assert Decimal.equal?(ri.base_qty, Decimal.new(2))

      ri = Ash.get!(ReconciliationItem, ri.id, authorize?: false, load: [:receipt_no, :material_name])
      assert ri.receipt_no == receipt.receipt_no
      assert ri.material_name == ctx.product.name

      recon = recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
      assert recon.status == :confirmed

      assert Decimal.equal?(
               Ash.get!(OutsourcedReceiptItem, item.id, authorize?: false).reconciled_qty,
               Decimal.new(2)
             )

      assert {:error, error} =
               receipt |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "已对账"
      assert Ash.get!(OutsourcedReceipt, receipt.id, authorize?: false).status == :audited

      recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update!(authorize?: false)

      assert Decimal.equal?(
               Ash.get!(OutsourcedReceiptItem, item.id, authorize?: false).reconciled_qty,
               Decimal.new(0)
             )

      voided = receipt |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert voided.status == :voided
    end

    test "超出剩余可对账量行保存即拒;对账行必须恰挂一种来源", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item = item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})
      receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      recon =
        Reconciliation
        |> Ash.Changeset.for_create(:create, %{
          reconciliation_no: "PR-#{System.unique_integer([:positive])}",
          reconciliation_type: :regular,
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          debit_account_id: ctx.credit.id,
          credit_account_id: ctx.debit.id
        })
        |> Ash.create!(authorize?: false)

      assert {:error, error} =
               ReconciliationItem
               |> Ash.Changeset.for_create(:create, %{
                 reconciliation_id: recon.id,
                 idx: 1,
                 outsourced_receipt_item_id: item.id,
                 qty: Decimal.new(6)
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "超出剩余可对账量"
    end
  end

  describe "作废回滚" do
    test "作废回滚全部库存分录、总账分录与已收数量", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert Decimal.equal?(reload_item(ctx.order_item).received_qty, Decimal.new(5))

      receipt =
        receipt |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      assert receipt.status == :voided
      assert Decimal.equal?(reload_item(ctx.order_item).received_qty, Decimal.new(0))
      assert entries(receipt.id) |> Enum.all?(& &1.is_cancelled)
      assert gl_entries(receipt.id) |> Enum.all?(& &1.is_cancelled)
    end

    test "作废照常过负库存校验:成品已耗用致负则拒", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      # 成品被后续出掉,作废入库会致负
      stock_move!(ctx.wh, ctx.product, ctx.kg, :out, Decimal.new(5))

      assert {:error, error} =
               receipt |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "库存不足"
      assert Ash.get!(OutsourcedReceipt, receipt.id, authorize?: false).status == :audited
      assert Decimal.equal?(reload_item(ctx.order_item).received_qty, Decimal.new(5))
    end

    test "仅已审核可作废", ctx do
      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      assert {:error, error} =
               receipt |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅已审核委外入库单可作废"
    end
  end

  describe "与订单交叉" do
    test "有已审核委外入库时订单不可作废,先作废委外入库后可作废", ctx do
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 1})

      receipt =
        receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               ctx.order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "订单存在已审核委外入库,请先作废相关委外入库单"

      receipt |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      voided = ctx.order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert voided.status == :voided
    end

    test "有草稿委外入库时订单不可作废,须先删草稿委外入库", ctx do
      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 1})

      assert {:error, error} =
               ctx.order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "请先删除引用本订单的草稿委外入库单"

      :ok = receipt |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      voided = ctx.order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert voided.status == :voided
    end
  end

  describe "生命周期" do
    test "仅草稿可改可删,行与带出子行随单级联删除", ctx do
      receipt =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      item = item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      updated =
        receipt
        |> Ash.Changeset.for_update(:update, %{remarks: "改备注"})
        |> Ash.update!(authorize?: false)

      assert updated.remarks == "改备注"

      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))
      receipt = receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               receipt
               |> Ash.Changeset.for_update(:update, %{remarks: "再改"})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外入库单可修改或删除"

      assert {:error, error} =
               receipt |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外入库单可修改或删除"

      # 已审核单据的行与扣减行不可编辑
      assert {:error, error} =
               item
               |> Ash.Changeset.for_update(:update, %{qty: Decimal.new(2)})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外入库单可编辑入库条目"

      [mrow] = material_rows(item.id)

      assert {:error, error} =
               mrow
               |> Ash.Changeset.for_update(:update, %{qty: Decimal.new(2)})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外入库单可编辑材料扣减/副产物行"

      # 草稿删单:行与带出子行级联删
      draft =
        receipt!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          warehouse_id: ctx.wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      draft_item =
        item!(draft, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 5})

      :ok = draft |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
      assert {:error, _} = Ash.get(OutsourcedReceiptItem, draft_item.id, authorize?: false)
      assert material_rows(draft_item.id) == []
      assert byproduct_rows(draft_item.id) == []
    end

    test "头有行时公司/对手不可再改", ctx do
      receipt =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item!(receipt, %{order_item_id: ctx.order_item.id, warehouse_id: ctx.wh.id, qty: 1})

      other_supplier = supplier!()

      assert {:error, error} =
               receipt
               |> Ash.Changeset.for_update(:update, %{party_id: other_supplier.id})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "请先删除入库条目"

      assert %{remarks: "只改备注"} =
               receipt
               |> Ash.Changeset.for_update(:update, %{remarks: "只改备注"})
               |> Ash.update!(authorize?: false)
    end
  end

  describe "权限" do
    test "无 purchase.outsourced_receipt 权限者创建被拒绝", ctx do
      user = user!()
      role = role!()
      assign!(user, role)
      grant_company!(user, ctx.company)
      actor = Authz.build_actor(user)

      assert_raise Ash.Error.Forbidden, fn ->
        OutsourcedReceipt
        |> Ash.Changeset.for_create(:create, %{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          receipt_no: "ORN-N1",
          receipt_date: ~D[2026-07-24],
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })
        |> Ash.create!(actor: actor)
      end
    end
  end
end
