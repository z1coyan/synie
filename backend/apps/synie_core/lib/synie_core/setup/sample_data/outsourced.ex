defmodule SynieCore.Setup.SampleData.Outsourced do
  @moduledoc """
  示例数据:委外采购全链路(编排在 Mfg 之后、Finance 之前;发票链只读常规
  已确认对账单,不读委外数据)。

  汇流铜排组件第二张 BOM「委外方案」(紫铜排净 1.2 损耗 5%、端子座 8、绝缘护套 0.3,
  副产品废铜边角料 0.06)→ 外协仓「{公司编码} - 外协仓-恒力钣金」(叶子启用,绑 S04)
  → 委外订单 2(零星手填加工费 12.50/件:已审核 80 件 + 草稿 20 件,条目挂委外 BOM,
  发料/副产物清单按 BOM 折算口径写快照:净用量×(1+损耗率)×数量、单位产出量×数量)
  → 委外发料单 1(D-9 已审核,部分发料留余额:紫铜排 60/100.8、端子座 400/640、
  护套 15/24,调出仓=默认仓)→ 委外入库单 1(D-4 已审核,成品入库 30/80 留进行中,
  材料扣减 37.8/240/9 与副产物 1.8 由 DeriveRows 按比例带出,借=1405/贷=2204 显式传)
  → 采购对账 1(草稿,委外入库条目全额 30 进对账池,演示加工费对账)。

  数量账(逐仓逐料非负;既有链路结存口径见 Inventory 模块):
  默认仓 紫铜排 460−60=400、接线端子座 1100−400=700、绝缘护套 600−15=585;
  外协仓 紫铜排 60−37.8=22.2、接线端子座 400−240=160、绝缘护套 15−9=6;
  成品仓 汇流铜排组件 +30、废铜边角料 +1.8。委外入库过总账 借1405/贷2204 375.00。
  """

  alias SynieCore.Inv.Warehouse
  alias SynieCore.Mfg.Bom
  alias SynieCore.Mfg.BomByproduct
  alias SynieCore.Mfg.BomComponent
  alias SynieCore.Purchase.Order
  alias SynieCore.Purchase.OrderItem
  alias SynieCore.Purchase.OrderItemByproduct
  alias SynieCore.Purchase.OrderItemMaterial
  alias SynieCore.Purchase.OutsourcedIssue
  alias SynieCore.Purchase.OutsourcedIssueItem
  alias SynieCore.Purchase.OutsourcedReceipt
  alias SynieCore.Purchase.OutsourcedReceiptItem
  alias SynieCore.Purchase.Reconciliation
  alias SynieCore.Purchase.ReconciliationItem
  alias SynieCore.Setup.SampleData

  @doc "返回 `{ %{boms:, warehouse:, orders:, issues:, receipts:, reconciliations:}, notifications }`。"
  def seed!(ctx, master, actor) do
    mats = master.materials
    s04 = master.suppliers["S04"]

    {bom, n1} = seed_outsourced_bom!(mats)
    {warehouse, n2} = seed_outsourced_warehouse!(ctx, s04)

    # 委外订单:零星(手填加工费 12.50/件,免报价),条目挂委外 BOM;
    # 发料/副产物清单按 BOM 折算口径手工写快照(与前端代入同口径,写后即脱钩)
    {order1, n3} =
      outsourced_order!(ctx, s04, 15, "初始化示例委外订单(已审核)", actor,
        item: {:busbar, 80, "12.50", bom},
        materials: [{:copper_bar, "100.8"}, {:terminal_block, "640"}, {:insul_sleeve, "24"}],
        byproducts: [{:scrap_copper, "4.8"}],
        audit?: true,
        mats: mats
      )

    {order2, n4} =
      outsourced_order!(ctx, s04, 2, "初始化示例委外订单(草稿,可改后审核)", actor,
        item: {:busbar, 20, "12.50", bom},
        materials: [{:copper_bar, "25.2"}, {:terminal_block, "160"}],
        byproducts: [{:scrap_copper, "1.2"}],
        audit?: false,
        mats: mats
      )

    {issue, n5} = issue!(ctx, s04, warehouse, order1, actor)
    {receipt, n6} = receipt!(ctx, s04, warehouse, order1, actor)
    {reconciliation, n7} = reconciliation!(ctx, s04, receipt, actor)

    result = %{
      boms: [bom],
      warehouse: warehouse,
      orders: [order1.order, order2.order],
      issues: [issue],
      receipts: [receipt.receipt],
      reconciliations: [reconciliation]
    }

    {result, n1 ++ n2 ++ n3 ++ n4 ++ n5 ++ n6 ++ n7}
  end

  # ---------------------------------------------------------------------------
  # 内部
  # ---------------------------------------------------------------------------

  # 委外方案 BOM:汇流铜排组件第二张(一物料多张),配料损耗与副产品按委外工艺配置
  defp seed_outsourced_bom!(mats) do
    {bom, n1} =
      SampleData.create!(
        Bom,
        %{material_id: mats[:busbar].id, plan_name: "委外方案", note: "委外加工配方(示例)"},
        nil
      )

    n2 =
      [
        {:copper_bar, "1.2", "0.05"},
        {:terminal_block, "8", nil},
        {:insul_sleeve, "0.3", nil}
      ]
      |> Enum.flat_map(fn {key, qty, loss} ->
        material = mats[key]

        attrs = %{
          bom_id: bom.id,
          material_id: material.id,
          unit_id: material.default_unit_id,
          quantity: Decimal.new(qty)
        }

        attrs = if loss, do: Map.put(attrs, :loss_rate, Decimal.new(loss)), else: attrs

        {_component, notifications} = SampleData.create!(BomComponent, attrs, nil)
        notifications
      end)

    {_byproduct, n3} =
      SampleData.create!(
        BomByproduct,
        %{
          bom_id: bom.id,
          material_id: mats[:scrap_copper].id,
          unit_id: mats[:scrap_copper].default_unit_id,
          quantity: Decimal.new("0.06"),
          note: "委外下料边角料"
        },
        nil
      )

    {bom, n1 ++ n2 ++ n3}
  end

  # 外协仓:叶子启用,一仓绑一方(S04 恒力钣金),与默认仓/成品仓平级挂根仓下
  defp seed_outsourced_warehouse!(ctx, supplier) do
    root = SampleData.warehouse_by_suffix!(ctx.company.id, "所有仓库")

    SampleData.create!(
      Warehouse,
      %{
        name: "#{ctx.company.code} - 外协仓-#{supplier.short_name}",
        is_leaf: true,
        is_outsourced: true,
        party_type: :supplier,
        party_id: supplier.id,
        company_id: ctx.company.id,
        parent_id: root.id
      },
      nil
    )
  end

  # item: {物料 key, 数量, 加工费单价, 委外 BOM};清单数量已按 BOM 折算口径算好(快照)
  defp outsourced_order!(ctx, supplier, date_ago, remarks, actor, opts) do
    mats = Keyword.fetch!(opts, :mats)
    {mat_key, qty, price, bom} = Keyword.fetch!(opts, :item)
    audit? = Keyword.fetch!(opts, :audit?)

    {order, n1} =
      SampleData.create!(
        Order,
        %{
          company_id: ctx.company.id,
          order_date: SampleData.days_ago(date_ago),
          order_type: :spot,
          is_outsourced: true,
          party_type: :supplier,
          party_id: supplier.id,
          remarks: remarks
        },
        actor
      )

    material = mats[mat_key]

    {item, n2} =
      SampleData.create!(
        OrderItem,
        %{
          order_id: order.id,
          idx: 1,
          material_id: material.id,
          unit_id: material.default_unit_id,
          qty: Decimal.new(qty),
          price: Decimal.new(price),
          tax_rate: Decimal.new("0.13"),
          bom_id: bom.id
        },
        actor
      )

    {material_lines, n3} =
      opts
      |> Keyword.fetch!(:materials)
      |> Enum.map_reduce([], fn {key, line_qty}, acc ->
        line_material = mats[key]

        {line, notifications} =
          SampleData.create!(
            OrderItemMaterial,
            %{
              order_item_id: item.id,
              material_id: line_material.id,
              unit_id: line_material.default_unit_id,
              quantity: Decimal.new(line_qty)
            },
            actor
          )

        {line, acc ++ notifications}
      end)

    n4 =
      opts
      |> Keyword.fetch!(:byproducts)
      |> Enum.flat_map(fn {key, line_qty} ->
        line_material = mats[key]

        {_line, notifications} =
          SampleData.create!(
            OrderItemByproduct,
            %{
              order_item_id: item.id,
              material_id: line_material.id,
              unit_id: line_material.default_unit_id,
              quantity: Decimal.new(line_qty)
            },
            actor
          )

        notifications
      end)

    result = %{order: order, item: item, material_lines: material_lines}
    notifications = n1 ++ n2 ++ n3 ++ n4

    if audit? do
      {audited, n5} = SampleData.run_action!(order, :audit, %{}, actor)
      {%{result | order: audited}, notifications ++ n5}
    else
      {result, notifications}
    end
  end

  # 部分发料(留余额展示已发料量/剩余量):清单行创建序即 紫铜排/端子座/护套,
  # 对应发 60/400/15;调出仓=默认仓,外协仓=本模块建的外协仓
  defp issue!(ctx, supplier, warehouse, order, actor) do
    {issue, n1} =
      SampleData.create!(
        OutsourcedIssue,
        %{
          company_id: ctx.company.id,
          issue_date: SampleData.days_ago(9),
          party_type: :supplier,
          party_id: supplier.id,
          from_warehouse_id: ctx.warehouses.default.id,
          outsourced_warehouse_id: warehouse.id,
          remarks: "初始化示例委外发料"
        },
        actor
      )

    n2 =
      order.material_lines
      |> Enum.zip([60, 400, 15])
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {{line, qty}, idx} ->
        {_item, notifications} =
          SampleData.create!(
            OutsourcedIssueItem,
            %{
              issue_id: issue.id,
              idx: idx,
              order_item_material_id: line.id,
              qty: Decimal.new(qty),
              from_warehouse_id: ctx.warehouses.default.id,
              outsourced_warehouse_id: warehouse.id
            },
            actor
          )

        notifications
      end)

    {audited, n3} = SampleData.run_action!(issue, :audit, %{}, actor)
    {audited, n1 ++ n2 ++ n3}
  end

  # 部分入库 30/80 留进行中:材料扣减行(外协仓)与副产物行(成品仓)由 DeriveRows
  # 按 30/80 比例随条目 create 带出(仓由头默认仓预填,无需手改);
  # 借贷科目照采购入库先例显式传(借=1405 库存商品/贷=2204 未开票应付)
  defp receipt!(ctx, supplier, warehouse, order, actor) do
    date = SampleData.days_ago(4)

    {receipt, n1} =
      SampleData.create!(
        OutsourcedReceipt,
        %{
          company_id: ctx.company.id,
          receipt_date: date,
          posting_date: date,
          party_type: :supplier,
          party_id: supplier.id,
          warehouse_id: ctx.warehouses.finished.id,
          outsourced_warehouse_id: warehouse.id,
          debit_account_id: ctx.accounts.inventory.id,
          credit_account_id: ctx.accounts.unbilled_ap.id,
          remarks: "初始化示例委外入库"
        },
        actor
      )

    {item, n2} =
      SampleData.create!(
        OutsourcedReceiptItem,
        %{
          receipt_id: receipt.id,
          idx: 1,
          order_item_id: order.item.id,
          qty: Decimal.new(30),
          warehouse_id: ctx.warehouses.finished.id
        },
        actor
      )

    {audited, n3} = SampleData.run_action!(receipt, :audit, %{}, actor)
    {%{receipt: audited, item: item}, n1 ++ n2 ++ n3}
  end

  # 草稿对账:委外入库条目全额 30 进对账池(加工费 30×12.50=375.00;
  # 草稿不消耗可对账量,留演示确认动作)
  defp reconciliation!(ctx, supplier, receipt, actor) do
    {reconciliation, n1} =
      SampleData.create!(
        Reconciliation,
        %{
          company_id: ctx.company.id,
          reconciliation_type: :regular,
          party_type: :supplier,
          party_id: supplier.id,
          remarks: "初始化示例委外加工费对账(草稿)"
        },
        actor
      )

    {_item, n2} =
      SampleData.create!(
        ReconciliationItem,
        %{
          reconciliation_id: reconciliation.id,
          idx: 1,
          outsourced_receipt_item_id: receipt.item.id,
          qty: Decimal.new(30)
        },
        actor
      )

    {reconciliation, n1 ++ n2}
  end
end
