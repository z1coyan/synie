defmodule SynieCore.Sales.DeliveryTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.GlEntry
  alias SynieCore.Base.{Account, Unit}
  alias SynieCore.Inv.{Material, MaterialCategory, StockDoc, StockDocItem, StockEntry, Warehouse}
  alias SynieCore.Sales.{Customer, Delivery, DeliveryItem, Order, OrderItem, Setting}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    customer =
      Customer
      |> Ash.Changeset.for_create(:create, %{
        code: "C-#{System.unique_integer([:positive])}",
        name: "测试客户"
      })
      |> Ash.create!(authorize?: false)

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
      |> Ash.Changeset.for_create(:create, %{name: "发货仓", company_id: company.id})
      |> Ash.create!(authorize?: false)

    # 铺底库存
    stock_in!(warehouse, material, kg, Decimal.new(100))

    debit = account!(company, "1122U", "未开票应收", :unbilled_receivable)
    credit = account!(company, "6001", "主营业务收入", nil)

    order =
      Order
      |> Ash.Changeset.for_create(:create, %{
        order_no: "SO-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-17],
        order_type: :sample,
        company_id: company.id,
        party_type: :customer,
        party_id: customer.id
      })
      |> Ash.create!(authorize?: false)

    order_item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: material.id,
        unit_id: kg.id,
        qty: Decimal.new(10),
        price: Decimal.new("100.00"),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    %{
      company: company,
      customer: customer,
      kg: kg,
      material: material,
      warehouse: warehouse,
      debit: debit,
      credit: credit,
      order: order,
      order_item: order_item
    }
  end

  defp account!(company, code, name, role) do
    Account
    |> Ash.Changeset.for_create(:create, %{
      code: "#{code}-#{System.unique_integer([:positive])}",
      name: name,
      direction: :debit,
      company_id: company.id,
      role: role
    })
    |> Ash.create!(authorize?: false)
  end

  defp stock_in!(warehouse, material, unit, qty) do
    doc =
      StockDoc
      |> Ash.Changeset.for_create(:create, %{
        doc_no: "CRK-#{System.unique_integer([:positive])}",
        company_id: warehouse.company_id,
        warehouse_id: warehouse.id,
        direction: :in,
        doc_date: ~D[2026-07-19]
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

  defp delivery!(attrs) do
    attrs =
      Map.merge(
        %{
          delivery_no: "DN-#{System.unique_integer([:positive])}",
          delivery_date: ~D[2026-07-20]
        },
        attrs
      )

    Delivery |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp line!(delivery, attrs) do
    DeliveryItem
    |> Ash.Changeset.for_create(:create, Map.merge(%{idx: 1, qty: Decimal.new(3)}, attrs) |> Map.put(:delivery_id, delivery.id))
    |> Ash.create!(authorize?: false)
  end

  test "审核写出库分录、总账、累加已发;作废回滚", ctx do
    %{
      company: co,
      customer: cu,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit,
      order_item: oi
    } = ctx

    d =
      delivery!(%{
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id,
        remarks: "测试发货"
      })

    line!(d, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(4)
    })

    d = d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert d.status == :audited
    assert d.posting_date == ~D[2026-07-20]

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.shipped_qty, Decimal.new(4))

    stock =
      StockEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    assert length(stock) == 1
    assert Decimal.equal?(hd(stock).quantity, Decimal.new(-4))
    assert hd(stock).is_cancelled == false

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    # 本币金额 4/10 * 1000 = 400
    assert length(gl) == 2
    debit_row = Enum.find(gl, &Decimal.compare(&1.debit, 0) == :gt)
    credit_row = Enum.find(gl, &Decimal.compare(&1.credit, 0) == :gt)
    assert Decimal.equal?(debit_row.debit, Decimal.new("400.00"))
    assert Decimal.equal?(credit_row.credit, Decimal.new("400.00"))
    assert debit_row.party_id == cu.id
    assert is_nil(credit_row.party_id)

    d = d |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
    assert d.status == :voided

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.shipped_qty, Decimal.new(0))

    stock = Ash.reload!(hd(stock), authorize?: false)
    assert stock.is_cancelled == true

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    assert Enum.all?(gl, & &1.is_cancelled)
  end

  test "超发默认 0% 审核拒绝;配置比例后放行", ctx do
    %{
      company: co,
      customer: cu,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit,
      order_item: oi
    } = ctx

    d =
      delivery!(%{
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })

    line!(d, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(11)
    })

    assert {:error, _} = d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

    setting = Setting.get()

    setting
    |> Ash.Changeset.for_update(:update, %{delivery_overship_ratio: Decimal.new("0.2")})
    |> Ash.update!(authorize?: false)

    d = d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert d.status == :audited

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.shipped_qty, Decimal.new(11))
  end

  test "零单价订单发货跳过总账", ctx do
    %{company: co, customer: cu, warehouse: wh, material: mat, kg: kg} = ctx

    order =
      Order
      |> Ash.Changeset.for_create(:create, %{
        order_no: "SO-free-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-17],
        order_type: :sample,
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id
      })
      |> Ash.create!(authorize?: false)

    oi =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: mat.id,
        unit_id: kg.id,
        qty: Decimal.new(2),
        price: Decimal.new(0),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    d =
      delivery!(%{
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id
      })

    line!(d, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(2)
    })

    d = d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert d.status == :audited

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    assert gl == []

    stock =
      StockEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    assert length(stock) == 1
  end

  test "有已审核发货时订单不可作废", ctx do
    %{
      company: co,
      customer: cu,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit,
      order: order,
      order_item: oi
    } = ctx

    d =
      delivery!(%{
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })

    line!(d, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(1)
    })

    d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    assert {:error, _} =
             order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)
  end

  test "借方科目非未开票应收角色时保存报错", ctx do
    %{company: co, customer: cu, credit: credit} = ctx
    bad = account!(co, "1122", "应收账款", :receivable)

    assert {:error, _} =
             Delivery
             |> Ash.Changeset.for_create(:create, %{
               delivery_no: "DN-bad-#{System.unique_integer([:positive])}",
               company_id: co.id,
               party_type: :customer,
               party_id: cu.id,
               debit_account_id: bad.id,
               credit_account_id: credit.id
             })
             |> Ash.create(authorize?: false)
  end
end
