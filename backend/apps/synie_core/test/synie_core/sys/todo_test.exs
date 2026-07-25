defmodule SynieCore.Sys.TodoTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{VatInvoice}
  alias SynieCore.Authz
  alias SynieCore.Base.{Account, Unit}
  alias SynieCore.Inv.{Material, MaterialCategory, StockDoc, StockDocItem, Warehouse}

  alias SynieCore.Sales.{
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

  alias SynieCore.Purchase.Order, as: PurOrder
  alias SynieCore.Purchase.OrderItem, as: PurOrderItem
  alias SynieCore.Purchase.Quotation, as: PurQuotation
  alias SynieCore.Purchase.QuotationItem, as: PurQuotationItem
  alias SynieCore.Purchase.Receipt
  alias SynieCore.Purchase.ReceiptItem
  alias SynieCore.Purchase.Reconciliation, as: PurReconciliation
  alias SynieCore.Purchase.ReconciliationItem, as: PurReconciliationItem
  alias SynieCore.Purchase.Supplier

  alias SynieCore.Sys.Todo

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

    supplier =
      Supplier
      |> Ash.Changeset.for_create(:create, %{
        code: "S-#{System.unique_integer([:positive])}",
        name: "测试供应商"
      })
      |> Ash.create!(authorize?: false)

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-td#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "T#{System.unique_integer([:positive])}",
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
      |> Ash.Changeset.for_create(:create, %{name: "待办仓", company_id: company.id})
      |> Ash.create!(authorize?: false)

    stock_in!(warehouse, material, kg, Decimal.new(1000))

    accounts = %{
      unbilled: account!(company, "1122U", "未开票应收", :unbilled_receivable),
      revenue: account!(company, "6001", "主营业务收入", nil),
      receivable: account!(company, "1122", "应收账款", :receivable),
      tax: account!(company, "222101", "应交增值税(销项)", nil),
      unbilled_ap: account!(company, "2202U", "未开票应付", :unbilled_payable),
      payable: account!(company, "2202", "应付账款", :payable),
      expense: account!(company, "1405", "原材料", nil),
      tax_in: account!(company, "222102", "应交增值税(进项)", nil)
    }

    %{
      company: company,
      customer: customer,
      supplier: supplier,
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

  defp sal_recon!(ctx, attrs \\ %{}) do
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

  defp sal_item!(recon, delivery_item, attrs) do
    attrs =
      %{idx: 1, qty: Decimal.new(3)}
      |> Map.merge(attrs)
      |> Map.put(:reconciliation_id, recon.id)
      |> Map.put(:delivery_item_id, delivery_item.id)

    ReconciliationItem
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp confirmed_sal!(ctx) do
    {_order, order_item} = regular_order!(ctx)
    {_delivery, delivery_item} = audited_delivery!(ctx, order_item)
    recon = sal_recon!(ctx)
    sal_item!(recon, delivery_item, %{qty: Decimal.new(3)})
    recon = recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
    {recon, delivery_item}
  end

  defp outbound_invoice_attrs(ctx, recon, overrides \\ %{}) do
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

  defp active_todos!(source_type, source_id) do
    Todo
    |> Ash.Query.filter(
      source_type == ^source_type and source_id == ^source_id and status == :active
    )
    |> Ash.read!(authorize?: false)
  end

  defp all_todos!(source_type, source_id) do
    Todo
    |> Ash.Query.filter(source_type == ^source_type and source_id == ^source_id)
    |> Ash.Query.sort(inserted_at: :asc)
    |> Ash.read!(authorize?: false)
  end

  defp actor_with!(user, perms, company) do
    role = role!()
    Enum.each(perms, &grant!(role, &1))
    assign!(user, role)
    grant_company!(user, company)
    Authz.build_actor(Ash.get!(SynieCore.Accounts.User, user.id, authorize?: false))
  end

  # ── 销项生产者 ──────────────────────────────────────────────────────────

  describe "销项开票待办" do
    test "常规对账单确认产生开票待办", ctx do
      {recon, _} = confirmed_sal!(ctx)
      [todo] = active_todos!("sales.reconciliation", recon.id)

      assert todo.type == :issue_invoice
      assert todo.status == :active
      assert todo.source_no == recon.reconciliation_no
      assert todo.company_id == ctx.company.id
      assert todo.party_id == ctx.customer.id
      assert Decimal.equal?(todo.amount, Decimal.new("300.00"))
    end

    test "赠送/样品单审核不产生待办", ctx do
      {_order, order_item} =
        Order
        |> Ash.Changeset.for_create(:create, %{
          order_no: "SO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-17],
          order_type: :sample,
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })
        |> Ash.create!(authorize?: false)
        |> then(fn order ->
          item =
            OrderItem
            |> Ash.Changeset.for_create(:create, %{
              order_id: order.id,
              idx: 1,
              material_id: ctx.material.id,
              unit_id: ctx.kg.id,
              qty: Decimal.new(2),
              price: Decimal.new("10.00"),
              tax_rate: Decimal.new("0.13")
            })
            |> Ash.create!(authorize?: false)

          order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
          {order, item}
        end)

      {_delivery, delivery_item} = audited_delivery!(ctx, order_item, %{qty: Decimal.new(2)})

      recon = sal_recon!(ctx, %{reconciliation_type: :gift_sample})
      sal_item!(recon, delivery_item, %{qty: Decimal.new(2)})
      recon = recon |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert recon.status == :closed
      assert active_todos!("sales.reconciliation", recon.id) == []
    end

    test "撤回确认关闭待办", ctx do
      {recon, _} = confirmed_sal!(ctx)
      assert length(active_todos!("sales.reconciliation", recon.id)) == 1

      recon = recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update!(authorize?: false)
      assert recon.status == :draft
      assert active_todos!("sales.reconciliation", recon.id) == []

      [closed] = all_todos!("sales.reconciliation", recon.id)
      assert closed.status == :closed
      assert closed.closed_reason == :unconfirm
    end

    test "发票审核结单关闭待办;草稿关联不关闭且徽标可见", ctx do
      {recon, _} = confirmed_sal!(ctx)
      [todo] = active_todos!("sales.reconciliation", recon.id)

      invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, outbound_invoice_attrs(ctx, recon))
        |> Ash.create!(authorize?: false)

      # 草稿关联:待办仍活跃,草稿关联中=true
      assert length(active_todos!("sales.reconciliation", recon.id)) == 1

      todo =
        Todo
        |> Ash.get!(todo.id, authorize?: false)
        |> Ash.load!([:draft_invoice_linked], authorize?: false)

      assert todo.draft_invoice_linked == true

      invoice
      |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
      |> Ash.update!(authorize?: false)

      assert active_todos!("sales.reconciliation", recon.id) == []
      [closed] = all_todos!("sales.reconciliation", recon.id)
      assert closed.closed_reason == :invoice_audit
    end

    test "发票作废复活新待办,原记录留历史", ctx do
      {recon, _} = confirmed_sal!(ctx)

      invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, outbound_invoice_attrs(ctx, recon))
        |> Ash.create!(authorize?: false)

      invoice =
        invoice
        |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
        |> Ash.update!(authorize?: false)

      assert active_todos!("sales.reconciliation", recon.id) == []

      invoice |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      todos = all_todos!("sales.reconciliation", recon.id)
      assert length(todos) == 2
      assert Enum.count(todos, &(&1.status == :closed)) == 1
      assert Enum.count(todos, &(&1.status == :active)) == 1
    end

    test "发票红冲复活新待办", ctx do
      {recon, _} = confirmed_sal!(ctx)

      invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, outbound_invoice_attrs(ctx, recon))
        |> Ash.create!(authorize?: false)

      invoice =
        invoice
        |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
        |> Ash.update!(authorize?: false)

      invoice
      |> Ash.Changeset.for_update(:reverse, %{posting_date: ~D[2026-07-22]})
      |> Ash.update!(authorize?: false)

      todos = all_todos!("sales.reconciliation", recon.id)
      assert Enum.count(todos, &(&1.status == :active)) == 1
      assert Enum.count(todos, &(&1.status == :closed)) == 1
    end
  end

  # ── 进项生产者 ──────────────────────────────────────────────────────────

  describe "进项收票待办" do
    defp pur_regular_order!(ctx) do
      quotation =
        PurQuotation
        |> Ash.Changeset.for_create(:create, %{
          quotation_no: "PQ-#{System.unique_integer([:positive])}",
          quotation_date: ~D[2026-07-17],
          valid_until: ~D[2026-08-17],
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id
        })
        |> Ash.create!(authorize?: false)

      qitem =
        PurQuotationItem
        |> Ash.Changeset.for_create(:create, %{
          quotation_id: quotation.id,
          idx: 1,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          pricing_mode: :fixed,
          price: Decimal.new("100.00"),
          tax_rate: Decimal.new("0.13")
        })
        |> Ash.create!(authorize?: false)

      quotation |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      order =
        PurOrder
        |> Ash.Changeset.for_create(:create, %{
          order_no: "PO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-17],
          order_type: :regular,
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id
        })
        |> Ash.create!(authorize?: false)

      item =
        PurOrderItem
        |> Ash.Changeset.for_create(:create, %{
          order_id: order.id,
          idx: 1,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          qty: Decimal.new(10),
          price: Decimal.new("100.00"),
          tax_rate: Decimal.new("0.13"),
          quotation_item_id: qitem.id
        })
        |> Ash.create!(authorize?: false)

      order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      {order, item}
    end

    defp audited_receipt!(ctx, order_item) do
      receipt =
        Receipt
        |> Ash.Changeset.for_create(:create, %{
          receipt_no: "PR-#{System.unique_integer([:positive])}",
          receipt_date: ~D[2026-07-20],
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          debit_account_id: ctx.accounts.expense.id,
          credit_account_id: ctx.accounts.unbilled_ap.id
        })
        |> Ash.create!(authorize?: false)

      item =
        ReceiptItem
        |> Ash.Changeset.for_create(:create, %{
          receipt_id: receipt.id,
          idx: 1,
          order_item_id: order_item.id,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          warehouse_id: ctx.warehouse.id,
          qty: Decimal.new(4)
        })
        |> Ash.create!(authorize?: false)

      receipt = receipt |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      {receipt, item}
    end

    defp confirmed_pur!(ctx) do
      {_order, order_item} = pur_regular_order!(ctx)
      {_receipt, receipt_item} = audited_receipt!(ctx, order_item)

      recon =
        PurReconciliation
        |> Ash.Changeset.for_create(:create, %{
          reconciliation_no: "PRC-#{System.unique_integer([:positive])}",
          reconciliation_type: :regular,
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          debit_account_id: ctx.accounts.unbilled_ap.id,
          credit_account_id: ctx.accounts.expense.id
        })
        |> Ash.create!(authorize?: false)

      PurReconciliationItem
      |> Ash.Changeset.for_create(:create, %{
        reconciliation_id: recon.id,
        idx: 1,
        receipt_item_id: receipt_item.id,
        qty: Decimal.new(3)
      })
      |> Ash.create!(authorize?: false)

      recon = recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)
      {recon, receipt_item}
    end

    test "常规采购对账单确认产生收票待办", ctx do
      {recon, _} = confirmed_pur!(ctx)
      [todo] = active_todos!("purchase.reconciliation", recon.id)

      assert todo.type == :receive_invoice
      assert todo.status == :active
      assert todo.company_id == ctx.company.id
      assert todo.party_id == ctx.supplier.id
    end

    test "开入发票审核关闭;作废复活", ctx do
      {recon, _} = confirmed_pur!(ctx)
      recon = Ash.load!(recon, [:base_gross_total], authorize?: false)
      gross = recon.base_gross_total
      # 反推未税/税额(校验只卡价税合计=对账单本币合计)
      net = Decimal.round(Decimal.div(gross, Decimal.new("1.13")), 2)
      tax = Decimal.sub(gross, net)

      invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, %{
          company_id: ctx.company.id,
          doc_no: "FP-IN-#{System.unique_integer([:positive])}",
          direction: :inbound,
          invoice_date: ~D[2026-07-21],
          party_type: :supplier,
          party_id: ctx.supplier.id,
          invoice_kind: :normal,
          invoice_code: "1100",
          invoice_no: "#{System.unique_integer([:positive])}",
          net_total: net,
          tax_total: tax,
          gross_total: gross,
          party_account_id: ctx.accounts.payable.id,
          amount_account_id: ctx.accounts.expense.id,
          tax_account_id: ctx.accounts.tax_in.id,
          pur_reconciliation_id: recon.id
        })
        |> Ash.create!(authorize?: false)

      assert length(active_todos!("purchase.reconciliation", recon.id)) == 1

      invoice =
        invoice
        |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-21]})
        |> Ash.update!(authorize?: false)

      assert active_todos!("purchase.reconciliation", recon.id) == []

      invoice |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      assert length(active_todos!("purchase.reconciliation", recon.id)) == 1
    end
  end

  defp run_unread(actor) do
    Todo
    |> Ash.ActionInput.for_action(:unread_count, %{}, actor: actor)
    |> Ash.run_action()
  end

  # ── 查询 / 用户痕迹 / 圈人 ──────────────────────────────────────────────

  describe "查询与用户痕迹" do
    test "空列表按圈人返回空", ctx do
      user = user!()
      actor = actor_with!(user, ["acc.vat_invoice:create"], ctx.company)

      assert {:ok, page} =
               Todo
               |> Ash.Query.for_read(:read, %{tab: "active"}, actor: actor)
               |> Ash.read(actor: actor)

      assert page == []
    end

    test "无发票创建权限看不到待办;有权限可见;无公司授权不可见", ctx do
      {recon, _} = confirmed_sal!(ctx)
      assert length(active_todos!("sales.reconciliation", recon.id)) == 1

      no_invoice = user!()
      no_invoice_actor = actor_with!(no_invoice, ["sales.reconciliation:read"], ctx.company)

      # 无发票创建权:Forbidden 与空列表等价(都是「看不到」)
      assert match?(
               {:error, %Ash.Error.Forbidden{}},
               Todo
               |> Ash.Query.for_read(:read, %{tab: "active"}, actor: no_invoice_actor)
               |> Ash.read(actor: no_invoice_actor)
             )

      other_company = company!()
      wrong_co = user!()
      wrong_actor = actor_with!(wrong_co, ["acc.vat_invoice:create"], other_company)

      # 有发票创建权但无该公司授权:公司 FilterCheck 收成空集
      assert {:ok, []} =
               Todo
               |> Ash.Query.for_read(:read, %{tab: "active"}, actor: wrong_actor)
               |> Ash.read(actor: wrong_actor)

      ok_user = user!()
      ok_actor = actor_with!(ok_user, ["acc.vat_invoice:create"], ctx.company)

      assert {:ok, [todo]} =
               Todo
               |> Ash.Query.for_read(:read, %{tab: "active"}, actor: ok_actor)
               |> Ash.read(actor: ok_actor)

      assert todo.source_id == recon.id
    end

    test "已读/忽略只影响本人;未读计数;复活后忽略复位", ctx do
      {recon, _} = confirmed_sal!(ctx)

      u1 = user!()
      u2 = user!()
      a1 = actor_with!(u1, ["acc.vat_invoice:create"], ctx.company)
      a2 = actor_with!(u2, ["acc.vat_invoice:create"], ctx.company)

      assert {:ok, 1} = run_unread(a1)

      [todo] =
        Todo
        |> Ash.Query.for_read(:read, %{tab: "active"}, actor: a1)
        |> Ash.read!(actor: a1)

      todo
      |> Ash.Changeset.for_update(:mark_read, %{}, actor: a1)
      |> Ash.update!(actor: a1)

      assert {:ok, 0} = run_unread(a1)
      assert {:ok, 1} = run_unread(a2)

      todo
      |> Ash.Changeset.for_update(:dismiss, %{}, actor: a1)
      |> Ash.update!(actor: a1)

      assert {:ok, []} =
               Todo
               |> Ash.Query.for_read(:read, %{tab: "active"}, actor: a1)
               |> Ash.read(actor: a1)

      assert {:ok, [_]} =
               Todo
               |> Ash.Query.for_read(:read, %{tab: "active"}, actor: a2)
               |> Ash.read(actor: a2)

      # 撤回再确认 → 新待办,忽略复位
      recon = Ash.get!(Reconciliation, recon.id, authorize?: false)
      recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update!(authorize?: false)
      recon = Ash.get!(Reconciliation, recon.id, authorize?: false)
      recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      assert {:ok, [_new]} =
               Todo
               |> Ash.Query.for_read(:read, %{tab: "active"}, actor: a1)
               |> Ash.read(actor: a1)

      assert {:ok, 1} = run_unread(a1)
    end

    test "历史 tab 可查 closed 待办", ctx do
      {recon, _} = confirmed_sal!(ctx)
      recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update!(authorize?: false)

      user = user!()
      actor = actor_with!(user, ["acc.vat_invoice:create"], ctx.company)

      assert {:ok, [closed]} =
               Todo
               |> Ash.Query.for_read(:read, %{tab: "history"}, actor: actor)
               |> Ash.read(actor: actor)

      assert closed.status == :closed
      assert closed.closed_reason == :unconfirm
      assert not is_nil(closed.closed_at)
    end

    test "超管全见", ctx do
      {recon, _} = confirmed_sal!(ctx)
      admin =
        user!()
        |> Ash.Changeset.for_update(:set_super_admin, %{})
        |> Ash.update!(authorize?: false)

      actor = Authz.build_actor(admin)

      assert {:ok, [todo]} =
               Todo
               |> Ash.Query.for_read(:read, %{tab: "active"}, actor: actor)
               |> Ash.read(actor: actor)

      assert todo.source_id == recon.id
    end
  end
end
