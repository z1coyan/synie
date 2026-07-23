defmodule SynieCore.Setup.SampleData.Purchase do
  @moduledoc """
  示例数据:采购链(报价→订单→入库→对账)。

  报价 5(4 审核 1 草稿)→ 订单 4(3 审核 1 草稿,常规行挂已审核报价条目,
  订单日期落在报价 [报价日期, 有效期] 内)→ 入库单 3(全部审核,显式传
  借=1405 库存商品/贷=2204 未开票应付,行仓=默认仓库;PR3 缠绕膜部分收货留进行中)→
  对账单 2(PCR1 供应商已确认,交财务发票结单;PCR2 草稿)。
  """

  alias SynieCore.Purchase.Order
  alias SynieCore.Purchase.OrderItem
  alias SynieCore.Purchase.Quotation
  alias SynieCore.Purchase.QuotationItem
  alias SynieCore.Purchase.Receipt
  alias SynieCore.Purchase.ReceiptItem
  alias SynieCore.Purchase.Reconciliation
  alias SynieCore.Purchase.ReconciliationItem
  alias SynieCore.Setup.SampleData

  @doc "返回 `{ %{quotations:, orders:, receipts:, reconciliations:}, notifications }`。"
  def seed!(ctx, master, actor) do
    mats = master.materials
    sups = master.suppliers

    # 报价(报价日期/有效期按天数回溯;审核 4 张、草稿 1 张)
    {pq1, n1} =
      quotation!(ctx, sups["S01"], 88, 90, "到厂价含税,运费另计", actor,
        items: [{:copper_rod, "52.00"}, {:copper_bar, "36.80"}],
        audit?: true,
        materials: mats
      )

    {pq2, n2} =
      quotation!(ctx, sups["S04"], 72, 90, "含运费到厂", actor,
        items: [{:steel_sheet, "85.00"}, {:stamped_part, "6.50"}],
        audit?: true,
        materials: mats
      )

    {pq3, n3} =
      quotation!(ctx, sups["S05"], 50, 60, "含税,款到发货", actor,
        items: [{:abs_pellet, "14.20"}, {:stretch_film, "28.00"}],
        audit?: true,
        materials: mats
      )

    {pq4, n4} =
      quotation!(ctx, sups["S02"], 30, 45, "含税,月结 30 天", actor,
        items: [{:screw, "0.045"}],
        audit?: true,
        materials: mats
      )

    {pq5, n5} =
      quotation!(ctx, sups["S06"], 6, 30, nil, actor,
        items: [{:carton, "3.80"}],
        audit?: false,
        materials: mats
      )

    # 订单(常规行挂报价条目派生物料/单位/单价;PO4 留草稿)
    {po1, n6} =
      order!(ctx, sups["S01"], 75, "初始化示例采购订单(已审核)", actor,
        items: [{pq1.items[:copper_rod], 500}, {pq1.items[:copper_bar], 200}],
        audit?: true
      )

    {po2, n7} =
      order!(ctx, sups["S04"], 60, "初始化示例采购订单(已审核)", actor,
        items: [{pq2.items[:steel_sheet], 400}, {pq2.items[:stamped_part], 600}],
        audit?: true
      )

    {po3, n8} =
      order!(ctx, sups["S05"], 35, "初始化示例采购订单(已审核)", actor,
        items: [{pq3.items[:abs_pellet], 800}, {pq3.items[:stretch_film], 200}],
        audit?: true
      )

    {po4, n9} =
      order!(ctx, sups["S02"], 8, "初始化示例采购订单(草稿,可改后审核)", actor,
        items: [{pq4.items[:screw], 5000}],
        audit?: false
      )

    # 入库单(审核即增库存;PR3 缠绕膜只收 150/200,留进行中)
    wh = ctx.warehouses.default

    {pr1, n10} =
      receipt!(ctx, sups["S01"], 70, actor,
        items: [{po1.items[0], 500}, {po1.items[1], 200}],
        warehouse: wh,
        accounts: ctx.accounts
      )

    {pr2, n11} =
      receipt!(ctx, sups["S04"], 45, actor,
        items: [{po2.items[0], 400}, {po2.items[1], 600}],
        warehouse: wh,
        accounts: ctx.accounts
      )

    {pr3, n12} =
      receipt!(ctx, sups["S05"], 25, actor,
        items: [{po3.items[0], 800}, {po3.items[1], 150}],
        warehouse: wh,
        accounts: ctx.accounts
      )

    # 对账单(借=2204/贷=1405 由公司默认过账科目自动代入;PCR1 确认交发票结单)
    {pcr1, n13} =
      reconciliation!(ctx, sups["S01"], "初始化示例采购对账(已确认)", actor,
        items: [{pr1.items[0], 500}, {pr1.items[1], 200}],
        confirm?: true
      )

    {pcr2, n14} =
      reconciliation!(ctx, sups["S04"], "初始化示例采购对账(草稿)", actor,
        items: [{pr2.items[0], 400}, {pr2.items[1], 300}],
        confirm?: false
      )

    result = %{
      quotations: [pq1.quotation, pq2.quotation, pq3.quotation, pq4.quotation, pq5.quotation],
      orders: [po1.order, po2.order, po3.order, po4.order],
      receipts: [pr1.receipt, pr2.receipt, pr3.receipt],
      reconciliations: [pcr1.reconciliation, pcr2.reconciliation],
      confirmed_reconciliation: pcr1.reconciliation
    }

    {result, n1 ++ n2 ++ n3 ++ n4 ++ n5 ++ n6 ++ n7 ++ n8 ++ n9 ++ n10 ++ n11 ++ n12 ++ n13 ++ n14}
  end

  # ---------------------------------------------------------------------------
  # 内部
  # ---------------------------------------------------------------------------

  defp quotation!(ctx, supplier, date_ago, valid_days, terms, actor, opts) do
    mats = Keyword.fetch!(opts, :materials)
    items = Keyword.fetch!(opts, :items)
    audit? = Keyword.fetch!(opts, :audit?)
    date = SampleData.days_ago(date_ago)

    {quotation, n1} =
      SampleData.create!(
        Quotation,
        %{
          company_id: ctx.company.id,
          quotation_date: date,
          valid_until: Date.add(date, valid_days),
          party_type: :supplier,
          party_id: supplier.id,
          terms: terms,
          remarks: "初始化示例采购报价(#{if audit?, do: "已审核", else: "草稿"})"
        },
        actor
      )

    {items_by_key, n2} =
      items
      |> Enum.with_index(1)
      |> Enum.map_reduce([], fn {{key, price}, idx}, acc ->
        material = mats[key]

        {item, notifications} =
          SampleData.create!(
            QuotationItem,
            %{
              quotation_id: quotation.id,
              idx: idx,
              material_id: material.id,
              unit_id: material.default_unit_id,
              pricing_mode: :fixed,
              price: Decimal.new(price),
              tax_rate: Decimal.new("0.13")
            },
            actor
          )

        {{key, item}, acc ++ notifications}
      end)

    if audit? do
      {audited, n3} = SampleData.run_action!(quotation, :audit, %{}, actor)
      {%{quotation: audited, items: Map.new(items_by_key)}, n1 ++ n2 ++ n3}
    else
      {%{quotation: quotation, items: Map.new(items_by_key)}, n1 ++ n2}
    end
  end

  # items: [{报价条目, 数量}];常规订单行仅传报价条目与数量,物料/单位/单价由报价派生
  defp order!(ctx, supplier, date_ago, remarks, actor, opts) do
    items = Keyword.fetch!(opts, :items)
    audit? = Keyword.fetch!(opts, :audit?)

    {order, n1} =
      SampleData.create!(
        Order,
        %{
          company_id: ctx.company.id,
          order_date: SampleData.days_ago(date_ago),
          party_type: :supplier,
          party_id: supplier.id,
          remarks: remarks
        },
        actor
      )

    {order_items, n2} =
      items
      |> Enum.with_index(1)
      |> Enum.map_reduce([], fn {{quotation_item, qty}, idx}, acc ->
        {item, notifications} =
          SampleData.create!(
            OrderItem,
            %{
              order_id: order.id,
              idx: idx,
              quotation_item_id: quotation_item.id,
              qty: Decimal.new(qty)
            },
            actor
          )

        {item, acc ++ notifications}
      end)

    if audit? do
      {audited, n3} = SampleData.run_action!(order, :audit, %{}, actor)
      {%{order: audited, items: SampleData.index_items(order_items)}, n1 ++ n2 ++ n3}
    else
      {%{order: order, items: SampleData.index_items(order_items)}, n1 ++ n2}
    end
  end

  # items: [{采购订单条目, 本次入库数量}];借/贷科目显式传(不依赖默认代入)
  defp receipt!(ctx, supplier, date_ago, actor, opts) do
    items = Keyword.fetch!(opts, :items)
    warehouse = Keyword.fetch!(opts, :warehouse)
    accounts = Keyword.fetch!(opts, :accounts)
    date = SampleData.days_ago(date_ago)

    {receipt, n1} =
      SampleData.create!(
        Receipt,
        %{
          company_id: ctx.company.id,
          receipt_date: date,
          posting_date: date,
          party_type: :supplier,
          party_id: supplier.id,
          warehouse_id: warehouse.id,
          debit_account_id: accounts.inventory.id,
          credit_account_id: accounts.unbilled_ap.id,
          remarks: "初始化示例采购入库"
        },
        actor
      )

    {receipt_items, n2} =
      items
      |> Enum.with_index(1)
      |> Enum.map_reduce([], fn {{order_item, qty}, idx}, acc ->
        {item, notifications} =
          SampleData.create!(
            ReceiptItem,
            %{
              receipt_id: receipt.id,
              idx: idx,
              order_item_id: order_item.id,
              qty: Decimal.new(qty),
              warehouse_id: warehouse.id
            },
            actor
          )

        {item, acc ++ notifications}
      end)

    {audited, n3} = SampleData.run_action!(receipt, :audit, %{}, actor)
    {%{receipt: audited, items: SampleData.index_items(receipt_items)}, n1 ++ n2 ++ n3}
  end

  # items: [{入库条目, 对账数量}];借贷科目由公司默认过账科目自动代入
  defp reconciliation!(ctx, supplier, remarks, actor, opts) do
    items = Keyword.fetch!(opts, :items)
    confirm? = Keyword.fetch!(opts, :confirm?)

    {reconciliation, n1} =
      SampleData.create!(
        Reconciliation,
        %{
          company_id: ctx.company.id,
          reconciliation_type: :regular,
          party_type: :supplier,
          party_id: supplier.id,
          remarks: remarks
        },
        actor
      )

    n2 =
      items
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {{receipt_item, qty}, idx} ->
        {_item, notifications} =
          SampleData.create!(
            ReconciliationItem,
            %{
              reconciliation_id: reconciliation.id,
              idx: idx,
              receipt_item_id: receipt_item.id,
              qty: Decimal.new(qty)
            },
            actor
          )

        notifications
      end)

    if confirm? do
      {confirmed, n3} = SampleData.run_action!(reconciliation, :confirm, %{}, actor)
      {%{reconciliation: confirmed}, n1 ++ n2 ++ n3}
    else
      {%{reconciliation: reconciliation}, n1 ++ n2}
    end
  end
end
