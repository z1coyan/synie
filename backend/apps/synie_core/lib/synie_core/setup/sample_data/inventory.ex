defmodule SynieCore.Setup.SampleData.Inventory do
  @moduledoc """
  示例数据:库存单据。

  期初入库 2 张(D-85 默认仓铺通用料与客户料、D-80 成品仓铺客户料成品,
  客户料无采购来源全靠期初)→ 出库单 1 张(D-20 生产领料)→ 调拨单 1 张
  (D-10 默认仓→成品仓,发货后接线端子座只收 250/400,留 150 在途)→
  盘点单 1 张(D-3 默认仓,整仓带出后螺丝盘亏 50、导轨盘盈 5)。
  数量账按「期初+采购入库 ≥ 销售发货+出库+调拨+盘亏」逐料算平(默认仓,
  采购买卖链路见 Purchase 模块,销售发货见 Sales 模块):
  配电箱壳体 100−30−20−15=35;接线端子座 2000−500−400=1100;
  紫铜棒 500−120=380;冷轧钢板 400−60=340;紫铜排 300+200−40=460;
  螺丝 8000−1500−50=6450;其余只入不出。
  盘点排在所有库存动作最后:create 即取账面快照,之后该仓再有分录则审核被
  stale 拦截,故 create 后立即 approve。
  """

  require Ash.Query

  alias SynieCore.Inv.StockCount
  alias SynieCore.Inv.StockCountItem
  alias SynieCore.Inv.StockDoc
  alias SynieCore.Inv.StockDocItem
  alias SynieCore.Inv.StockTransfer
  alias SynieCore.Inv.StockTransferItem
  alias SynieCore.Setup.SampleData

  @doc "期初入库 2 张(先于采购/销售链执行,为销售发货铺库存)。"
  def seed_opening!(ctx, master, actor) do
    mats = master.materials

    {doc1, n1} =
      stock_doc!(ctx, :in, ctx.warehouses.default, 85, "期初建账入库(材料与通用件)", actor,
        items: [
          {:box_shell, 100},
          {:busbar, 100},
          {:mount_plate, 80},
          {:terminal_assy, 80},
          {:terminal_block, 2000},
          {:copper_terminal, 3000},
          {:rail, 300},
          {:copper_bar, 300},
          {:screw, 8000},
          {:insul_sleeve, 600},
          {:carton, 1000},
          {:stretch_film, 100}
        ],
        materials: mats
      )

    {doc2, n2} =
      stock_doc!(ctx, :in, ctx.warehouses.finished, 80, "期初建账入库(成品)", actor,
        items: [
          {:box_shell, 60},
          {:busbar, 60},
          {:mount_plate, 40},
          {:terminal_assy, 40}
        ],
        materials: mats
      )

    {%{stock_docs: [doc1, doc2]}, n1 ++ n2}
  end

  @doc "出库/调拨/盘点(排在销售链之后;盘点永远最后)。返回 `{ %{stock_docs: [出库单]}, notifications }`。"
  def seed_documents!(ctx, master, actor) do
    mats = master.materials

    {out_doc, n1} =
      stock_doc!(ctx, :out, ctx.warehouses.default, 20, "生产领料出库", actor,
        items: [
          {:copper_rod, 120},
          {:steel_sheet, 60},
          {:copper_bar, 40},
          {:screw, 1500}
        ],
        materials: mats
      )

    n2 = seed_transfer!(ctx, mats, actor)
    n3 = seed_stock_count!(ctx, mats, actor)

    {%{stock_docs: [out_doc]}, n1 ++ n2 ++ n3}
  end

  # ---------------------------------------------------------------------------
  # 内部
  # ---------------------------------------------------------------------------

  # 手工出入库单:create → 建行 → audit(审核按行派生库存分录,入库正/出库负)
  defp stock_doc!(ctx, direction, warehouse, date_ago, summary, actor, opts) do
    mats = Keyword.fetch!(opts, :materials)
    items = Keyword.fetch!(opts, :items)

    {doc, n1} =
      SampleData.create!(
        StockDoc,
        %{
          company_id: ctx.company.id,
          direction: direction,
          warehouse_id: warehouse.id,
          doc_date: SampleData.days_ago(date_ago),
          summary: summary,
          remarks: "初始化示例库存单据"
        },
        actor
      )

    n2 =
      items
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {{key, qty}, idx} ->
        material = mats[key]

        {_item, notifications} =
          SampleData.create!(
            StockDocItem,
            %{
              stock_doc_id: doc.id,
              idx: idx,
              material_id: material.id,
              unit_id: material.default_unit_id,
              qty: Decimal.new(qty)
            },
            actor
          )

        notifications
      end)

    {audited, n3} = SampleData.run_action!(doc, :audit, %{}, actor)
    {audited, n1 ++ n2 ++ n3}
  end

  # 调拨:默认仓→成品仓,在途仓作中转;发货后接线端子座部分收货,留 150 在途
  defp seed_transfer!(ctx, mats, actor) do
    {transfer, n1} =
      SampleData.create!(
        StockTransfer,
        %{
          company_id: ctx.company.id,
          from_warehouse_id: ctx.warehouses.default.id,
          to_warehouse_id: ctx.warehouses.finished.id,
          transit_warehouse_id: ctx.warehouses.transit.id,
          doc_date: SampleData.days_ago(10),
          summary: "成品转仓调拨",
          remarks: "初始化示例调拨单"
        },
        actor
      )

    {items, n2} =
      [box_shell: 15, terminal_block: 400]
      |> Enum.with_index(1)
      |> Enum.map_reduce([], fn {{key, qty}, idx}, acc ->
        material = mats[key]

        {item, notifications} =
          SampleData.create!(
            StockTransferItem,
            %{
              stock_transfer_id: transfer.id,
              idx: idx,
              material_id: material.id,
              unit_id: material.default_unit_id,
              qty: Decimal.new(qty)
            },
            actor
          )

        {item, acc ++ notifications}
      end)

    {shipped, n3} = SampleData.run_action!(transfer, :ship, %{}, actor)

    {_received, n4} =
      SampleData.run_action!(
        shipped,
        :receive,
        %{
          receipts: [
            %{item_id: Enum.at(items, 0).id, qty: Decimal.new(15)},
            %{item_id: Enum.at(items, 1).id, qty: Decimal.new(250)}
          ]
        },
        actor
      )

    n1 ++ n2 ++ n3 ++ n4
  end

  # 盘点:默认仓整仓带出(快照=当前账面),螺丝盘亏 50、导轨盘盈 5,其余按账面实盘;
  # create 后立即 approve(快照后该仓再动库存会被 stale 拦截)
  defp seed_stock_count!(ctx, mats, actor) do
    {count, n1} =
      SampleData.create!(
        StockCount,
        %{
          company_id: ctx.company.id,
          warehouse_id: ctx.warehouses.default.id,
          posting_date: SampleData.days_ago(3),
          summary: "月末例行盘点",
          remarks: "初始化示例盘点单",
          # load_all 是 create 的 argument:按该仓账面余额非零的物料整仓建行
          load_all: true
        },
        actor
      )

    items =
      StockCountItem
      |> Ash.Query.filter(count_id == ^count.id)
      |> Ash.read!(authorize?: false)

    # 防御:整仓带出未生效时报错优于静默造空单
    if items == [], do: raise("示例数据盘点整仓带出失败:默认仓库无账面余额")

    # 两行制造差异:螺丝 counted=账面−50(盘亏)、导轨 counted=账面+5(盘盈),其余按账面
    n2 =
      Enum.flat_map(items, fn item ->
        counted =
          cond do
            item.material_id == mats[:screw].id -> Decimal.sub(item.book_quantity, 50)
            item.material_id == mats[:rail].id -> Decimal.add(item.book_quantity, 5)
            true -> item.book_quantity
          end

        {_updated, notifications} =
          SampleData.run_action!(item, :update, %{counted_quantity: counted}, actor)

        notifications
      end)

    {_approved, n3} = SampleData.run_action!(count, :approve, %{}, actor)
    n1 ++ n2 ++ n3
  end
end
