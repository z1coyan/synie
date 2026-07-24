defmodule SynieCore.Setup.SampleData.Sales do
  @moduledoc """
  示例数据:销售链(报价→订单→发货→对账)。

  报价 5(4 审核 1 草稿)→ 订单 4(3 审核 1 草稿,常规行挂已审核报价条目,
  订单日期落在报价 [报价日期, 有效期] 内)→ 发货单 3(全部审核,显式传
  借=1124 未开票应收/贷=5001 主营业务收入,行仓=默认仓库;发货量逐料 ≤ 账面库存,
  销售链编排于期初入库与采购入库之后)→ 对账单 2(SR1 客户已确认,交财务发票结单;
  SR2 草稿)。
  """

  alias SynieCore.Sales.Delivery
  alias SynieCore.Sales.DeliveryItem
  alias SynieCore.Sales.Order
  alias SynieCore.Sales.OrderItem
  alias SynieCore.Sales.Quotation
  alias SynieCore.Sales.QuotationItem
  alias SynieCore.Sales.Reconciliation
  alias SynieCore.Sales.ReconciliationItem
  alias SynieCore.Setup.SampleData

  @doc "返回 `{ %{quotations:, orders:, deliveries:, reconciliations:}, notifications }`。"
  def seed!(ctx, master, actor) do
    mats = master.materials
    custs = master.customers

    # 报价(SQ5 留草稿;SQ1 海纳客户料 + 通用端子)
    {sq1, n1} =
      quotation!(ctx, custs["C01"], 88, 90, "示例:含税交货,账期月结 30 天", actor,
        items: [{:box_shell, "128.00"}, {:busbar, "86.50"}, {:terminal_block, "2.35"}],
        audit?: true,
        materials: mats
      )

    {sq2, n2} =
      quotation!(ctx, custs["C02"], 75, 90, "含税交货,款到发货", actor,
        items: [{:mount_plate, "45.00"}, {:terminal_block, "2.40"}, {:copper_terminal, "1.20"}],
        audit?: true,
        materials: mats
      )

    {sq3, n3} =
      quotation!(ctx, custs["C03"], 40, 60, "含税交货", actor,
        items: [{:terminal_assy, "32.00"}, {:insul_sleeve, "18.50"}],
        audit?: true,
        materials: mats
      )

    {sq4, n4} =
      quotation!(ctx, custs["C05"], 15, 45, "含税交货", actor,
        items: [{:terminal_block, "2.50"}, {:copper_terminal, "1.30"}],
        audit?: true,
        materials: mats
      )

    {sq5, n5} =
      quotation!(ctx, custs["C04"], 5, 25, nil, actor,
        items: [{:rail, "22.00"}, {:copper_terminal, "1.25"}],
        audit?: false,
        materials: mats
      )

    # 订单(SO1 海纳分两单发货;SO4 留草稿)
    {so1, n6} =
      order!(ctx, custs["C01"], 70, "初始化示例销售订单(已审核,两单发完)", actor,
        items: [{sq1.items[:box_shell], 50}, {sq1.items[:busbar], 20}],
        audit?: true
      )

    {so2, n7} =
      order!(ctx, custs["C02"], 55, "初始化示例销售订单(已审核)", actor,
        items: [
          {sq2.items[:mount_plate], 25},
          {sq2.items[:terminal_block], 500},
          {sq2.items[:copper_terminal], 800}
        ],
        audit?: true
      )

    {so3, n8} =
      order!(ctx, custs["C03"], 20, "初始化示例销售订单(已审核,待发货)", actor,
        items: [{sq3.items[:terminal_assy], 40}],
        audit?: true
      )

    {so4, n9} =
      order!(ctx, custs["C01"], 3, "初始化示例销售订单(草稿,可改后审核)", actor,
        items: [{sq1.items[:busbar], 10}],
        audit?: false
      )

    # 发货单(审核即减库存并过账 借1124/贷5001;行仓=默认仓库)
    wh = ctx.warehouses.default

    {sd1, n10} =
      delivery!(ctx, custs["C01"], 60, actor,
        items: [{so1.items[0], 30}, {so1.items[1], 20}],
        warehouse: wh,
        accounts: ctx.accounts
      )

    {sd2, n11} =
      delivery!(ctx, custs["C01"], 30, actor,
        items: [{so1.items[0], 20}],
        warehouse: wh,
        accounts: ctx.accounts
      )

    {sd3, n12} =
      delivery!(ctx, custs["C02"], 12, actor,
        items: [{so2.items[0], 25}, {so2.items[1], 500}, {so2.items[2], 800}],
        warehouse: wh,
        accounts: ctx.accounts
      )

    # 对账单(借=5001/贷=1124 由公司默认过账科目自动代入;SR1 确认交发票结单)
    {sr1, n13} =
      reconciliation!(ctx, custs["C01"], "初始化示例销售对账(已确认)", actor,
        items: [{sd1.items[0], 30}, {sd1.items[1], 20}, {sd2.items[0], 20}],
        confirm?: true
      )

    {sr2, n14} =
      reconciliation!(ctx, custs["C02"], "初始化示例销售对账(草稿)", actor,
        items: [{sd3.items[0], 25}, {sd3.items[1], 300}, {sd3.items[2], 800}],
        confirm?: false
      )

    result = %{
      quotations: [sq1.quotation, sq2.quotation, sq3.quotation, sq4.quotation, sq5.quotation],
      orders: [so1.order, so2.order, so3.order, so4.order],
      deliveries: [sd1.delivery, sd2.delivery, sd3.delivery],
      reconciliations: [sr1.reconciliation, sr2.reconciliation],
      confirmed_reconciliation: sr1.reconciliation
    }

    {result,
     n1 ++ n2 ++ n3 ++ n4 ++ n5 ++ n6 ++ n7 ++ n8 ++ n9 ++ n10 ++ n11 ++ n12 ++ n13 ++ n14}
  end

  # ---------------------------------------------------------------------------
  # 内部
  # ---------------------------------------------------------------------------

  defp quotation!(ctx, customer, date_ago, valid_days, terms, actor, opts) do
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
          party_type: :customer,
          party_id: customer.id,
          terms: terms,
          remarks: "初始化示例销售报价(#{if audit?, do: "已审核", else: "草稿"})"
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
  defp order!(ctx, customer, date_ago, remarks, actor, opts) do
    items = Keyword.fetch!(opts, :items)
    audit? = Keyword.fetch!(opts, :audit?)

    {order, n1} =
      SampleData.create!(
        Order,
        %{
          company_id: ctx.company.id,
          order_date: SampleData.days_ago(date_ago),
          party_type: :customer,
          party_id: customer.id,
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

  # items: [{销售订单条目, 本次发货数量}];借/贷科目显式传(不依赖默认代入)
  defp delivery!(ctx, customer, date_ago, actor, opts) do
    items = Keyword.fetch!(opts, :items)
    warehouse = Keyword.fetch!(opts, :warehouse)
    accounts = Keyword.fetch!(opts, :accounts)
    date = SampleData.days_ago(date_ago)

    {delivery, n1} =
      SampleData.create!(
        Delivery,
        %{
          company_id: ctx.company.id,
          delivery_date: date,
          posting_date: date,
          party_type: :customer,
          party_id: customer.id,
          warehouse_id: warehouse.id,
          debit_account_id: accounts.unbilled_ar.id,
          credit_account_id: accounts.revenue.id,
          remarks: "初始化示例销售发货"
        },
        actor
      )

    {delivery_items, n2} =
      items
      |> Enum.with_index(1)
      |> Enum.map_reduce([], fn {{order_item, qty}, idx}, acc ->
        {item, notifications} =
          SampleData.create!(
            DeliveryItem,
            %{
              delivery_id: delivery.id,
              idx: idx,
              order_item_id: order_item.id,
              qty: Decimal.new(qty),
              warehouse_id: warehouse.id
            },
            actor
          )

        {item, acc ++ notifications}
      end)

    {audited, n3} = SampleData.run_action!(delivery, :audit, %{}, actor)
    {%{delivery: audited, items: SampleData.index_items(delivery_items)}, n1 ++ n2 ++ n3}
  end

  # items: [{发货条目, 对账数量}];借贷科目由公司默认过账科目自动代入
  defp reconciliation!(ctx, customer, remarks, actor, opts) do
    items = Keyword.fetch!(opts, :items)
    confirm? = Keyword.fetch!(opts, :confirm?)

    {reconciliation, n1} =
      SampleData.create!(
        Reconciliation,
        %{
          company_id: ctx.company.id,
          reconciliation_type: :regular,
          party_type: :customer,
          party_id: customer.id,
          remarks: remarks
        },
        actor
      )

    n2 =
      items
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {{delivery_item, qty}, idx} ->
        {_item, notifications} =
          SampleData.create!(
            ReconciliationItem,
            %{
              reconciliation_id: reconciliation.id,
              idx: idx,
              delivery_item_id: delivery_item.id,
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
