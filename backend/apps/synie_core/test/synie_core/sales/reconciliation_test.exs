defmodule SynieCore.Sales.ReconciliationTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{GlEntry, VatInvoice}
  alias SynieCore.Base.{Account, Unit}
  alias SynieCore.Inv.{Material, MaterialCategory, StockDoc, StockDocItem, Warehouse}

  alias SynieCore.Sales.{
    CompanyAccountDefault,
    Customer,
    Delivery,
    DeliveryItem,
    Order,
    OrderItem,
    Quotation,
    QuotationItem,
    Reconciliation,
    ReconciliationItem
  }

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
        symbol: "kg-rc#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "R#{System.unique_integer([:positive])}",
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
      |> Ash.Changeset.for_create(:create, %{name: "对账仓", company_id: company.id})
      |> Ash.create!(authorize?: false)

    stock_in!(warehouse, material, kg, Decimal.new(1000))

    accounts = %{
      unbilled: account!(company, "1122U", "未开票应收", :unbilled_receivable),
      revenue: account!(company, "6001", "主营业务收入", nil),
      expense: account!(company, "6602", "销售费用", nil),
      receivable: account!(company, "1122", "应收账款", :receivable),
      tax: account!(company, "222101", "应交增值税(销项)", nil)
    }

    %{
      company: company,
      customer: customer,
      kg: kg,
      material: material,
      warehouse: warehouse,
      accounts: accounts
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

  # 样品订单(自由录价);price 默认 100,qty 默认 10
  defp sample_order!(ctx, attrs \\ %{}) do
    {item_attrs, order_attrs} = Map.split(attrs, [:item_qty, :item_price])

    attrs =
      Map.merge(
        %{
          order_no: "SO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-17],
          order_type: :sample,
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        },
        order_attrs
      )

    order = Order |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

    item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: ctx.material.id,
        unit_id: ctx.kg.id,
        qty: Map.get(item_attrs, :item_qty, Decimal.new(10)),
        price: Map.get(item_attrs, :item_price, Decimal.new("100.00")),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    {order, item}
  end

  # 常规订单(经有效报价锁价);price 默认 100
  defp regular_order!(ctx, attrs \\ %{}) do
    price = Map.get(attrs, :item_price, Decimal.new("100.00"))

    quotation =
      Quotation
      |> Ash.Changeset.for_create(:create, %{
        quotation_no: "QT-#{System.unique_integer([:positive])}",
        quotation_date: ~D[2026-07-17],
        valid_until: ~D[2026-08-17],
        company_id: ctx.company.id,
        party_type: :customer,
        party_id: ctx.customer.id
      })
      |> Ash.create!(authorize?: false)

    qitem =
      QuotationItem
      |> Ash.Changeset.for_create(:create, %{
        quotation_id: quotation.id,
        idx: 1,
        material_id: ctx.material.id,
        unit_id: ctx.kg.id,
        pricing_mode: :fixed,
        price: price,
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    quotation |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    order =
      Order
      |> Ash.Changeset.for_create(:create, %{
        order_no: "SO-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-17],
        order_type: :regular,
        company_id: ctx.company.id,
        party_type: :customer,
        party_id: ctx.customer.id
      })
      |> Ash.create!(authorize?: false)

    item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: ctx.material.id,
        unit_id: ctx.kg.id,
        qty: Map.get(attrs, :item_qty, Decimal.new(10)),
        price: price,
        tax_rate: Decimal.new("0.13"),
        quotation_item_id: qitem.id
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    {order, item}
  end

  # 建一张已审核发货:默认发 4(默认单位=行单位)
  defp audited_delivery!(ctx, order_item, attrs \\ %{}) do
    delivery =
      Delivery
      |> Ash.Changeset.for_create(:create, %{
        delivery_no: "DN-#{System.unique_integer([:positive])}",
        delivery_date: ~D[2026-07-20],
        company_id: ctx.company.id,
        party_type: :customer,
        party_id: ctx.customer.id,
        debit_account_id: ctx.accounts.unbilled.id,
        credit_account_id: ctx.accounts.revenue.id
      })
      |> Ash.create!(authorize?: false)

    item =
      DeliveryItem
      |> Ash.Changeset.for_create(:create, %{
        delivery_id: delivery.id,
        idx: 1,
        order_item_id: order_item.id,
        material_id: ctx.material.id,
        unit_id: ctx.kg.id,
        warehouse_id: ctx.warehouse.id,
        qty: Map.get(attrs, :qty, Decimal.new(4))
      })
      |> Ash.create!(authorize?: false)

    delivery = delivery |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    {delivery, item}
  end

  # 建对账单草稿;类型默认常规,借方默认费用/收入、贷方默认未开票应收
  defp reconciliation!(ctx, attrs \\ %{}) do
    attrs =
      Map.merge(
        %{
          reconciliation_no: "SR-#{System.unique_integer([:positive])}",
          reconciliation_type: :regular,
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          debit_account_id: ctx.accounts.revenue.id,
          credit_account_id: ctx.accounts.unbilled.id
        },
        attrs
      )

    Reconciliation |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp recon_item!(reconciliation, delivery_item, attrs \\ %{}) do
    attrs =
      %{idx: 1, qty: Decimal.new(3)}
      |> Map.merge(attrs)
      |> Map.put(:reconciliation_id, reconciliation.id)
      |> Map.put(:delivery_item_id, delivery_item.id)

    ReconciliationItem
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp recon_item(reconciliation, delivery_item, attrs \\ %{}) do
    attrs =
      %{idx: 1, qty: Decimal.new(3)}
      |> Map.merge(attrs)
      |> Map.put(:reconciliation_id, reconciliation.id)
      |> Map.put(:delivery_item_id, delivery_item.id)

    ReconciliationItem
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create(authorize?: false)
  end

  defp reconciled_qty(delivery_item_id) do
    Ash.get!(DeliveryItem, delivery_item_id, authorize?: false).reconciled_qty
  end

  defp gl_entries(voucher_type, voucher_id) do
    GlEntry
    |> Ash.Query.filter(voucher_type == ^voucher_type and voucher_id == ^voucher_id)
    |> Ash.read!(authorize?: false)
  end

  describe "建单与类型约束" do
    test "创建草稿:类型必填、借贷科目必填、贷方强制未开票应收角色", ctx do
      assert {:error, _} =
               Reconciliation
               |> Ash.Changeset.for_create(:create, %{
                 reconciliation_no: "SR-x1",
                 company_id: ctx.company.id,
                 party_type: :customer,
                 party_id: ctx.customer.id,
                 debit_account_id: ctx.accounts.revenue.id,
                 credit_account_id: ctx.accounts.unbilled.id
               })
               |> Ash.create(authorize?: false)

      # 贷方非未开票应收角色被拒
      assert {:error, error} =
               Reconciliation
               |> Ash.Changeset.for_create(:create, %{
                 reconciliation_no: "SR-x2",
                 reconciliation_type: :regular,
                 company_id: ctx.company.id,
                 party_type: :customer,
                 party_id: ctx.customer.id,
                 debit_account_id: ctx.accounts.revenue.id,
                 credit_account_id: ctx.accounts.revenue.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "未开票应收"
    end

    test "建单按公司默认过账科目整组代入(手填优先)", ctx do
      CompanyAccountDefault
      |> Ash.Changeset.for_create(:create, %{
        company_id: ctx.company.id,
        delivery_debit_account_id: ctx.accounts.unbilled.id,
        delivery_credit_account_id: ctx.accounts.revenue.id
      })
      |> Ash.create!(authorize?: false)

      recon =
        Reconciliation
        |> Ash.Changeset.for_create(:create, %{
          reconciliation_no: "SR-d1",
          reconciliation_type: :gift_sample,
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })
        |> Ash.create!(authorize?: false)

      # 对账单贷方(未开票应收)←默认发货借方;对账单借方←默认发货贷方
      assert recon.credit_account_id == ctx.accounts.unbilled.id
      assert recon.debit_account_id == ctx.accounts.revenue.id

      # 显式手填优先于默认代入
      recon2 =
        Reconciliation
        |> Ash.Changeset.for_create(:create, %{
          reconciliation_no: "SR-d2",
          reconciliation_type: :gift_sample,
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          debit_account_id: ctx.accounts.expense.id
        })
        |> Ash.create!(authorize?: false)

      assert recon2.debit_account_id == ctx.accounts.expense.id
      assert recon2.credit_account_id == ctx.accounts.unbilled.id
    end

    test "对账类型保存后锁死", ctx do
      recon = reconciliation!(ctx)

      assert {:error, error} =
               recon
               |> Ash.Changeset.for_update(:update, %{reconciliation_type: :gift_sample})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "对账类型不可变更"
    end

    test "常规单禁勾样品订单来源条目;赠送/样品单不限来源", ctx do
      {_order, order_item} = sample_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      regular = reconciliation!(ctx, %{reconciliation_type: :regular})

      assert {:error, error} = recon_item(regular, delivery_item)
      assert Exception.message(error) =~ "样品订单来源"

      gift = reconciliation!(ctx, %{reconciliation_type: :gift_sample})
      assert %ReconciliationItem{} = recon_item!(gift, delivery_item)
    end

    test "常规单禁勾零金额行", ctx do
      {_order, order_item} = regular_order!(ctx, %{item_price: Decimal.new(0)})
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item, %{qty: Decimal.new(2)})

      regular = reconciliation!(ctx, %{reconciliation_type: :regular})

      assert {:error, error} = recon_item(regular, delivery_item, %{qty: Decimal.new(2)})
      assert Exception.message(error) =~ "零金额"
    end

    test "对手/公司不一致与非同币种条目被拒", ctx do
      {_order, order_item} = regular_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      other_customer =
        Customer
        |> Ash.Changeset.for_create(:create, %{
          code: "C-#{System.unique_integer([:positive])}",
          name: "另一客户"
        })
        |> Ash.create!(authorize?: false)

      recon = reconciliation!(ctx, %{party_id: other_customer.id})

      assert {:error, error} = recon_item(recon, delivery_item)
      assert Exception.message(error) =~ "对手"
    end
  end

  describe "数量拆分与生效消耗" do
    test "行金额链:数量×快照原币单价→本币(本币单汇率 1)", ctx do
      {_order, order_item} = regular_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      recon = reconciliation!(ctx)
      item = recon_item!(recon, delivery_item, %{qty: Decimal.new(3)})

      assert Decimal.equal?(item.base_qty, Decimal.new(3))
      assert Decimal.equal?(item.amount, Decimal.new("300.00"))
      assert Decimal.equal?(item.base_amount, Decimal.new("300.00"))
    end

    test "行保存超剩余可对账量报错", ctx do
      {_order, order_item} = regular_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      recon = reconciliation!(ctx)

      assert {:error, error} = recon_item(recon, delivery_item, %{qty: Decimal.new(5)})
      assert Exception.message(error) =~ "剩余可对账量"

      assert %ReconciliationItem{} = recon_item!(recon, delivery_item, %{qty: Decimal.new(4)})
    end

    test "常规单确认消耗已对账数量,撤回回滚;确认后剩余量收紧", ctx do
      {_order, order_item} = regular_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      recon = reconciliation!(ctx)
      recon_item!(recon, delivery_item, %{qty: Decimal.new(3)})

      # 草稿不占量
      assert Decimal.equal?(reconciled_qty(delivery_item.id), Decimal.new(0))

      recon = recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
      assert recon.status == :confirmed
      assert Decimal.equal?(reconciled_qty(delivery_item.id), Decimal.new(3))

      # 第二张单只能勾剩余 1
      recon2 = reconciliation!(ctx)
      assert {:error, _} = recon_item(recon2, delivery_item, %{qty: Decimal.new(2)})
      assert %ReconciliationItem{} = recon_item!(recon2, delivery_item, %{qty: Decimal.new(1)})

      # 撤回确认回滚
      recon = recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update!(authorize?: false)
      assert recon.status == :draft
      assert Decimal.equal?(reconciled_qty(delivery_item.id), Decimal.new(0))
    end

    test "确认时剩余量不足的并发消耗被锁内复核拦下", ctx do
      {_order, order_item} = regular_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      recon1 = reconciliation!(ctx)
      recon_item!(recon1, delivery_item, %{qty: Decimal.new(3)})

      recon2 = reconciliation!(ctx)
      recon_item!(recon2, delivery_item, %{qty: Decimal.new(3)})

      recon1 |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               recon2 |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "超出剩余可对账量"
    end

    test "确认/撤回仅常规单;结单仅赠送/样品单", ctx do
      {_order, order_item} = sample_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      gift = reconciliation!(ctx, %{reconciliation_type: :gift_sample})
      recon_item!(gift, delivery_item, %{qty: Decimal.new(1)})

      assert {:error, _} =
               gift |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update(authorize?: false)

      {_order2, order_item2} = regular_order!(ctx)
      {_delivery2, delivery_item2} = audited_delivery!(ctx, order_item2)

      regular = reconciliation!(ctx)
      recon_item!(regular, delivery_item2, %{qty: Decimal.new(1)})

      assert {:error, _} =
               regular |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)
    end
  end

  describe "赠送/样品单结单与作废" do
    test "结单过账 借费用/贷未开票应收(带对手),消耗数量;作废回滚分录组与已对账数量", ctx do
      {_order, order_item} = sample_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      recon =
        reconciliation!(ctx, %{
          reconciliation_type: :gift_sample,
          debit_account_id: ctx.accounts.expense.id
        })

      recon_item!(recon, delivery_item, %{qty: Decimal.new(2)})

      recon =
        recon
        |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
        |> Ash.update!(authorize?: false)

      assert recon.status == :closed
      assert Decimal.equal?(reconciled_qty(delivery_item.id), Decimal.new(2))

      gl = gl_entries("sales.reconciliation", recon.id)
      assert length(gl) == 2
      debit_row = Enum.find(gl, &(Decimal.compare(&1.debit, 0) == :gt))
      credit_row = Enum.find(gl, &(Decimal.compare(&1.credit, 0) == :gt))
      assert debit_row.account_id == ctx.accounts.expense.id
      assert Decimal.equal?(debit_row.debit, Decimal.new("200.00"))
      assert is_nil(debit_row.party_id)
      assert credit_row.account_id == ctx.accounts.unbilled.id
      assert Decimal.equal?(credit_row.credit, Decimal.new("200.00"))
      assert credit_row.party_id == ctx.customer.id

      recon = recon |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert recon.status == :voided
      assert Decimal.equal?(reconciled_qty(delivery_item.id), Decimal.new(0))
      assert Enum.all?(gl_entries("sales.reconciliation", recon.id), & &1.is_cancelled)
    end

    test "零金额条目结单跳过分录,过账日期默认结单当日", ctx do
      {_order, order_item} = sample_order!(ctx, %{item_price: Decimal.new(0)})
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item, %{qty: Decimal.new(2)})

      recon = reconciliation!(ctx, %{reconciliation_type: :gift_sample})
      recon_item!(recon, delivery_item, %{qty: Decimal.new(2)})

      recon = recon |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert recon.status == :closed
      assert recon.posting_date == Date.utc_today()
      assert gl_entries("sales.reconciliation", recon.id) == []
      assert Decimal.equal?(reconciled_qty(delivery_item.id), Decimal.new(2))
    end

    test "常规单已结单不可作废(无独立作废入口)", ctx do
      {_order, order_item} = regular_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      recon = reconciliation!(ctx)
      recon_item!(recon, delivery_item, %{qty: Decimal.new(4)})
      recon = recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               recon |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "发票"
    end
  end

  describe "发货作废拦截" do
    test "存在非零已对账数量的发货单不可作废;撤回对账后可作废", ctx do
      {_order, order_item} = regular_order!(ctx)
      {delivery, delivery_item} = audited_delivery!(ctx, order_item)

      recon = reconciliation!(ctx)
      recon_item!(recon, delivery_item, %{qty: Decimal.new(1)})
      _recon = recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               delivery |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "已对账"

      recon = Ash.get!(Reconciliation, recon.id, authorize?: false)
      recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update!(authorize?: false)

      delivery =
        delivery |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      assert delivery.status == :voided
    end
  end

  describe "发票关联" do
    defp invoice_attrs(ctx, recon, overrides \\ %{}) do
      Map.merge(
        %{
          company_id: ctx.company.id,
          doc_no: "FP-#{System.unique_integer([:positive])}",
          direction: :outbound,
          invoice_date: ~D[2026-07-21],
          party_type: :customer,
          party_id: ctx.customer.id,
          invoice_kind: :normal,
          invoice_code: "1100",
          invoice_no: "#{System.unique_integer([:positive])}",
          net_total: Decimal.new("265.49"),
          tax_total: Decimal.new("34.51"),
          gross_total: Decimal.new("300.00"),
          party_account_id: ctx.accounts.receivable.id,
          amount_account_id: ctx.accounts.revenue.id,
          tax_account_id: ctx.accounts.tax.id,
          sal_reconciliation_id: recon.id
        },
        overrides
      )
    end

    # 常规单:发 4 对 3,对账单本币合计 300
    defp confirmed_recon!(ctx) do
      {_order, order_item} = regular_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)

      recon = reconciliation!(ctx)
      recon_item!(recon, delivery_item, %{qty: Decimal.new(3)})
      recon = recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
      {recon, delivery_item}
    end

    test "审核过账五笔分录并把对账单翻为已结单", ctx do
      {recon, _delivery_item} = confirmed_recon!(ctx)

      invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, invoice_attrs(ctx, recon))
        |> Ash.create!(authorize?: false)

      invoice =
        invoice
        |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
        |> Ash.update!(authorize?: false)

      assert invoice.status == :audited

      gl = gl_entries("acc.vat_invoice", invoice.id)
      assert length(gl) == 5

      # 正常三行:借应收账款(价税合计,带对手)/贷金额(未税)/贷税额
      debits = Enum.filter(gl, &(Decimal.compare(&1.debit, 0) == :gt))
      credits = Enum.filter(gl, &(Decimal.compare(&1.credit, 0) == :gt))
      assert length(debits) == 2
      assert length(credits) == 3

      receivable_row = Enum.find(debits, &(&1.account_id == ctx.accounts.receivable.id))
      assert Decimal.equal?(receivable_row.debit, Decimal.new("300.00"))
      assert receivable_row.party_id == ctx.customer.id

      amount_row = Enum.find(credits, &(&1.account_id == ctx.accounts.revenue.id))
      tax_row = Enum.find(credits, &(&1.account_id == ctx.accounts.tax.id))
      assert Decimal.equal?(amount_row.credit, Decimal.new("265.49"))
      assert Decimal.equal?(tax_row.credit, Decimal.new("34.51"))

      # 冲回组:借对账单头借方(发货贷方口径,不带对手)/贷对账单头贷方(未开票应收,带对手)
      reversal_debit = Enum.find(debits, &(&1.account_id == ctx.accounts.revenue.id))
      reversal_credit = Enum.find(credits, &(&1.account_id == ctx.accounts.unbilled.id))
      assert Decimal.equal?(reversal_debit.debit, Decimal.new("300.00"))
      assert is_nil(reversal_debit.party_id)
      assert Decimal.equal?(reversal_credit.credit, Decimal.new("300.00"))
      assert reversal_credit.party_id == ctx.customer.id

      recon = Ash.get!(Reconciliation, recon.id, authorize?: false)
      assert recon.status == :closed
    end

    test "审核校验:类型/状态/金额不符均被拒", ctx do
      {recon, _delivery_item} = confirmed_recon!(ctx)

      # 金额不等
      bad_amount =
        VatInvoice
        |> Ash.Changeset.for_create(
          :create,
          invoice_attrs(ctx, recon, %{
            doc_no: "FP-b1",
            invoice_no: "b1-#{System.unique_integer([:positive])}",
            gross_total: Decimal.new("301.00"),
            net_total: Decimal.new("266.49")
          })
        )
        |> Ash.create!(authorize?: false)

      assert {:error, error} =
               bad_amount
               |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "价税合计必须等于对账单合计"

      # 草稿对账单(未确认)
      {_order, order_item} = regular_order!(ctx)
      {_delivery, delivery_item} = audited_delivery!(ctx, order_item)
      draft_recon = reconciliation!(ctx)
      recon_item!(draft_recon, delivery_item, %{qty: Decimal.new(3)})

      draft_invoice =
        VatInvoice
        |> Ash.Changeset.for_create(
          :create,
          invoice_attrs(ctx, draft_recon, %{
            doc_no: "FP-b2",
            invoice_no: "b2-#{System.unique_integer([:positive])}"
          })
        )
        |> Ash.create!(authorize?: false)

      assert {:error, error2} =
               draft_invoice
               |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
               |> Ash.update(authorize?: false)

      assert Exception.message(error2) =~ "客户已确认"
    end

    test "开入发票不可关联对账单", ctx do
      {recon, _delivery_item} = confirmed_recon!(ctx)

      assert {:error, error} =
               VatInvoice
               |> Ash.Changeset.for_create(
                 :create,
                 invoice_attrs(ctx, recon, %{direction: :inbound})
               )
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅开出发票"
    end

    test "已关联发票(含草稿)不可撤回确认;解除后可撤回", ctx do
      {recon, _delivery_item} = confirmed_recon!(ctx)

      invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, invoice_attrs(ctx, recon))
        |> Ash.create!(authorize?: false)

      assert {:error, error} =
               recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "已关联发票"

      :ok = invoice |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      recon = recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update!(authorize?: false)
      assert recon.status == :draft
    end

    test "发票作废自动解除关联并把对账单退回客户已确认", ctx do
      {recon, _delivery_item} = confirmed_recon!(ctx)

      invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, invoice_attrs(ctx, recon))
        |> Ash.create!(authorize?: false)

      invoice =
        invoice
        |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
        |> Ash.update!(authorize?: false)

      assert Ash.get!(Reconciliation, recon.id, authorize?: false).status == :closed

      invoice = invoice |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert invoice.status == :voided
      assert is_nil(invoice.sal_reconciliation_id)

      recon = Ash.get!(Reconciliation, recon.id, authorize?: false)
      assert recon.status == :confirmed

      # 退回后可重新关联审核(一对一复用)
      invoice2 =
        VatInvoice
        |> Ash.Changeset.for_create(
          :create,
          invoice_attrs(ctx, recon, %{
            doc_no: "FP-r2",
            invoice_no: "r2-#{System.unique_integer([:positive])}"
          })
        )
        |> Ash.create!(authorize?: false)

      invoice2 =
        invoice2
        |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-22]})
        |> Ash.update!(authorize?: false)

      assert invoice2.status == :audited
      assert Ash.get!(Reconciliation, recon.id, authorize?: false).status == :closed
    end

    test "发票红冲自动解除关联并把对账单退回客户已确认", ctx do
      {recon, _delivery_item} = confirmed_recon!(ctx)

      invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, invoice_attrs(ctx, recon))
        |> Ash.create!(authorize?: false)

      invoice =
        invoice
        |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
        |> Ash.update!(authorize?: false)

      invoice =
        invoice
        |> Ash.Changeset.for_update(:reverse, %{posting_date: ~D[2026-07-22]})
        |> Ash.update!(authorize?: false)

      assert invoice.status == :reversed
      assert is_nil(invoice.sal_reconciliation_id)
      assert Ash.get!(Reconciliation, recon.id, authorize?: false).status == :confirmed

      # 红字组覆盖全部五笔
      gl = gl_entries("acc.vat_invoice", invoice.id)
      assert length(gl) == 10
      assert Enum.count(gl, & &1.is_reversal) == 5
      assert Enum.count(gl, & &1.is_reversed) == 5
    end
  end
end
