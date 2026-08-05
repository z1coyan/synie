import { decimal } from '@synie/shared'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { daysAgo, type MasterData, type SeedCtx } from './helpers.ts'
import { permitFor } from './permit.ts'
import type { SampleDataDeps } from './types.ts'

export async function seedOpeningStock(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
): Promise<number> {
  await createStockDoc(
    deps,
    actor,
    sc,
    'IN',
    sc.warehouses.default,
    85,
    '期初建账入库(材料与通用件)',
    [
      { key: 'box_shell', qty: 100 },
      { key: 'busbar', qty: 100 },
      { key: 'mount_plate', qty: 80 },
      { key: 'terminal_assy', qty: 80 },
      { key: 'terminal_block', qty: 2000 },
      { key: 'copper_terminal', qty: 3000 },
      { key: 'rail', qty: 300 },
      { key: 'copper_bar', qty: 300 },
      { key: 'screw', qty: 8000 },
      { key: 'insul_sleeve', qty: 600 },
      { key: 'carton', qty: 1000 },
      { key: 'stretch_film', qty: 100 },
    ],
    md,
  )
  await createStockDoc(
    deps,
    actor,
    sc,
    'IN',
    sc.warehouses.finished,
    80,
    '期初建账入库(成品)',
    [
      { key: 'box_shell', qty: 60 },
      { key: 'busbar', qty: 60 },
      { key: 'mount_plate', qty: 40 },
      { key: 'terminal_assy', qty: 40 },
    ],
    md,
  )
  return 2
}

export async function seedInventoryDocuments(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
): Promise<{ stockDocs: number }> {
  await createStockDoc(
    deps,
    actor,
    sc,
    'OUT',
    sc.warehouses.default,
    20,
    '生产领料出库',
    [
      { key: 'copper_rod', qty: 120 },
      { key: 'steel_sheet', qty: 60 },
      { key: 'copper_bar', qty: 40 },
      { key: 'screw', qty: 1500 },
    ],
    md,
  )
  await seedTransfer(deps, actor, sc, md)
  await seedStockCount(deps, actor, sc, md)
  return { stockDocs: 1 }
}

async function createStockDoc(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  direction: 'IN' | 'OUT',
  warehouseId: string,
  dateAgoN: number,
  summary: string,
  items: Array<{ key: string; qty: number }>,
  md: MasterData,
): Promise<string> {
  const doc = await deps.stockDocs.create(permitFor(deps, actor, 'invStockDocs', 'create'), {
    direction,
    docDate: daysAgo(dateAgoN),
    summary,
    remarks: '初始化示例库存单据',
    companyId: sc.company.id,
    warehouseId,
  })
  for (let i = 0; i < items.length; i++) {
    const line = items[i]!
    const mat = md.materials[line.key]
    if (!mat) throw new Error(`示例物料缺失: ${line.key}`)
    await deps.stockDocs.createItem(permitFor(deps, actor, 'invStockDocItems', 'create'), {
      stockDocId: doc.id,
      idx: i + 1,
      qty: String(line.qty),
      materialId: mat.id,
      unitId: mat.defaultUnitId,
    })
  }
  await deps.stockDocs.audit(permitFor(deps, actor, 'invStockDocs', 'audit'), doc.id)
  return doc.id
}

async function seedTransfer(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
): Promise<void> {
  const transfer = await deps.stockTransfers.create(
    permitFor(deps, actor, 'invStockTransfers', 'create'),
    {
      docDate: daysAgo(10),
      summary: '成品转仓调拨',
      remarks: '初始化示例调拨单',
      companyId: sc.company.id,
      fromWarehouseId: sc.warehouses.default,
      toWarehouseId: sc.warehouses.finished,
      transitWarehouseId: sc.warehouses.transit,
    },
  )
  const lines = [
    { key: 'box_shell', qty: 15 },
    { key: 'terminal_block', qty: 400 },
  ]
  const itemIds: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const mat = md.materials[line.key]!
    const item = await deps.stockTransfers.createItem(
      permitFor(deps, actor, 'invStockTransferItems', 'create'),
      {
        stockTransferId: transfer.id,
        idx: i + 1,
        qty: String(line.qty),
        materialId: mat.id,
        unitId: mat.defaultUnitId,
      },
    )
    itemIds.push(item.id)
  }
  await deps.stockTransfers.ship(permitFor(deps, actor, 'invStockTransfers', 'ship'), transfer.id)
  await deps.stockTransfers.receive(
    permitFor(deps, actor, 'invStockTransfers', 'receive'),
    transfer.id,
    {
      receipts: [
        { itemId: itemIds[0]!, qty: '15' },
        { itemId: itemIds[1]!, qty: '250' },
      ],
    },
  )
}

async function seedStockCount(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
): Promise<void> {
  const count = await deps.stockCounts.create(permitFor(deps, actor, 'invStockCounts', 'create'), {
    postingDate: daysAgo(3),
    summary: '月末例行盘点',
    remarks: '初始化示例盘点单',
    companyId: sc.company.id,
    warehouseId: sc.warehouses.default,
    loadAll: true,
  })
  const listed = await deps.stockCounts.queryItems(
    permitFor(deps, actor, 'invStockCountItems', 'read'),
    {
      filter: { countId: { kind: 'fk', values: [count.id], labels: [] } },
      limit: 200,
    },
  )
  const items = listed.results
  if (items.length === 0) {
    throw new ApiError('conflict', '示例数据盘点整仓带出失败:默认仓库无账面余额')
  }
  const screwId = md.materials.screw!.id
  const railId = md.materials.rail!.id
  for (const item of items) {
    const book = decimal(item.bookQuantity)
    let counted = book
    if (item.materialId === screwId) counted = book.sub(50)
    if (item.materialId === railId) counted = book.add(5)
    await deps.stockCounts.updateItem(
      permitFor(deps, actor, 'invStockCountItems', 'update'),
      item.id,
      { countedQuantity: counted.toFixed(), countedQuantityPresent: true },
    )
  }
  await deps.stockCounts.approve(permitFor(deps, actor, 'invStockCounts', 'approve'), count.id)
}
