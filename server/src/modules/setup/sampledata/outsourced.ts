import {
  ORDER_BYPRODUCT_RESOURCE,
  ORDER_MATERIAL_RESOURCE,
} from '~/modules/trading/order/outsourced-config.ts'
import { orderSpec } from '~/modules/trading/order/spec.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createSideReconciliation } from './chains.ts'
import { daysAgo, type MasterData, type SeedCtx } from './helpers.ts'
import { createBOMComponent } from './mfg.ts'
import { permitFor } from './permit.ts'
import type { OutsourcedResult, SampleDataDeps } from './types.ts'

export async function seedOutsourced(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
): Promise<OutsourcedResult> {
  const s04 = md.suppliers.S04!

  const bom = await deps.manufacturingMaster.createBom(permitFor(deps, actor, 'mfgBoms', 'create'), {
    materialId: md.materials.busbar!.id,
    planName: '委外方案',
    note: '委外加工配方(示例)',
  })
  for (const row of [
    { key: 'copper_bar', qty: '1.2', loss: '0.05' as string | null },
    { key: 'terminal_block', qty: '8', loss: null },
    { key: 'insul_sleeve', qty: '0.3', loss: null },
  ]) {
    await createBOMComponent(deps, actor, bom.id, md, row.key, row.qty, row.loss, null)
  }
  const scrap = md.materials.scrap_copper!
  await deps.manufacturingMaster.createByproduct(permitFor(deps, actor, 'mfgBomByproducts', 'update'), {
    bomId: bom.id,
    quantity: '0.06',
    note: '委外下料边角料',
    materialId: scrap.id,
    unitId: scrap.defaultUnitId,
  })

  const partyLabel = s04.shortName || s04.name
  const wh = await deps.warehouses.create(
    permitFor(deps, actor, 'invWarehouses', 'create'),
    {
      name: `${sc.company.code} - 外协仓-${partyLabel}`,
      isLeaf: true,
      isOutsourced: true,
      partyType: 'supplier',
      partyId: s04.id,
      companyId: sc.company.id,
      parentId: sc.warehouses.root,
    },
  )

  const order1 = await createOutsourcedOrder(
    deps,
    actor,
    sc,
    md,
    s04.id,
    15,
    '初始化示例委外订单(已审核)',
    true,
    bom.id,
    80,
    [
      { key: 'copper_bar', qty: '100.8' },
      { key: 'terminal_block', qty: '640' },
      { key: 'insul_sleeve', qty: '24' },
    ],
    [{ key: 'scrap_copper', qty: '4.8' }],
  )
  const order2 = await createOutsourcedOrder(
    deps,
    actor,
    sc,
    md,
    s04.id,
    2,
    '初始化示例委外订单(草稿,可改后审核)',
    false,
    bom.id,
    20,
    [
      { key: 'copper_bar', qty: '25.2' },
      { key: 'terminal_block', qty: '160' },
    ],
    [{ key: 'scrap_copper', qty: '1.2' }],
  )

  const issueID = await createOutsourcedIssue(
    deps,
    actor,
    sc,
    s04.id,
    wh.id,
    order1.matLineIDs,
  )
  const { itemId: receiptItemID, receiptId } = await createOutsourcedReceipt(
    deps,
    actor,
    sc,
    s04.id,
    wh.id,
    order1.itemID,
  )

  const recon = await createSideReconciliation(
    deps,
    actor,
    sc,
    'purchase',
    s04.id,
    '初始化示例委外加工费对账(草稿)',
    false,
    [{ sourceItemId: receiptItemID, qty: 30, kind: 'outsourced' }],
  )

  return {
    boms: [bom.id],
    orders: [order1.orderID, order2.orderID],
    issues: [issueID],
    receipts: [receiptId],
    reconciliations: [recon.id],
  }
}

async function createOutsourcedOrder(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
  supplierId: string,
  dateAgoN: number,
  remarks: string,
  audit: boolean,
  bomId: string,
  qty: number,
  materials: Array<{ key: string; qty: string }>,
  byproducts: Array<{ key: string; qty: string }>,
): Promise<{ orderID: string; itemID: string; matLineIDs: string[] }> {
  const date = daysAgo(dateAgoN)
  const head = await deps.trading.orders.createHead(
    permitFor(deps, actor, orderSpec('purchase').headResource, 'create'),
    'purchase',
    {
    companyId: sc.company.id,
    orderDate: date,
    orderType: 'SPOT',
    isOutsourced: true,
    partyType: 'supplier',
    partyId: supplierId,
    remarks,
  })
  const mat = md.materials.busbar!
  const item = await deps.trading.orders.createItem(
    permitFor(deps, actor, orderSpec('purchase').itemResource, 'create'),
    'purchase',
    {
    orderId: head.id,
    idx: 1,
    qty: String(qty),
    materialId: mat.id,
    unitId: mat.defaultUnitId,
    price: '12.50',
    taxRate: '0.13',
    bomId,
  })
  const matLineIDs: string[] = []
  for (const line of materials) {
    const m = md.materials[line.key]!
    const created = await deps.trading.outsourcedConfig.createMaterial(
      permitFor(deps, actor, ORDER_MATERIAL_RESOURCE, 'create'),
      {
      orderItemId: item.id,
      materialId: m.id,
      unitId: m.defaultUnitId,
      quantity: line.qty,
    })
    matLineIDs.push(String(created.id))
  }
  for (const line of byproducts) {
    const m = md.materials[line.key]!
    await deps.trading.outsourcedConfig.createByproduct(
      permitFor(deps, actor, ORDER_BYPRODUCT_RESOURCE, 'create'),
      {
      orderItemId: item.id,
      materialId: m.id,
      unitId: m.defaultUnitId,
      quantity: line.qty,
    })
  }
  if (audit) {
    await deps.trading.orders.audit(
      permitFor(deps, actor, orderSpec('purchase').headResource, 'audit'),
      'purchase',
      head.id,
    )
  }
  return { orderID: head.id, itemID: item.id, matLineIDs }
}

async function createOutsourcedIssue(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  supplierId: string,
  outsourcedWH: string,
  matLines: string[],
): Promise<string> {
  const date = daysAgo(9)
  const from = sc.warehouses.default
  const issue = await deps.trading.outsourced.createIssue(
    permitFor(deps, actor, 'purOutsourcedIssues', 'create'),
    {
    companyId: sc.company.id,
    issueDate: date,
    partyType: 'supplier',
    partyId: supplierId,
    fromWarehouseId: from,
    outsourcedWarehouseId: outsourcedWH,
    remarks: '初始化示例委外发料',
  })
  const qtys = [60, 400, 15]
  for (let i = 0; i < matLines.length; i++) {
    await deps.trading.outsourced.createIssueItem(
      permitFor(deps, actor, 'purOutsourcedIssueItems', 'create'),
      {
      issueId: issue.id as string,
      idx: i + 1,
      qty: String(qtys[i]!),
      orderItemMaterialId: matLines[i]!,
      fromWarehouseId: from,
      outsourcedWarehouseId: outsourcedWH,
    })
  }
  await deps.trading.outsourced.auditIssue(
    permitFor(deps, actor, 'purOutsourcedIssues', 'audit'),
    issue.id as string,
  )
  return String(issue.id)
}

async function createOutsourcedReceipt(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  supplierId: string,
  outsourcedWH: string,
  orderItemId: string,
): Promise<{ itemId: string; receiptId: string }> {
  const date = daysAgo(4)
  const finished = sc.warehouses.finished
  const receipt = await deps.trading.outsourced.createReceipt(
    permitFor(deps, actor, 'purOutsourcedReceipts', 'create'),
    {
    companyId: sc.company.id,
    receiptDate: date,
    postingDate: date,
    partyType: 'supplier',
    partyId: supplierId,
    warehouseId: finished,
    outsourcedWarehouseId: outsourcedWH,
    debitAccountId: sc.accounts.inventory,
    creditAccountId: sc.accounts.unbilledAP,
    remarks: '初始化示例委外入库',
  })
  const item = await deps.trading.outsourced.createReceiptItem(
    permitFor(deps, actor, 'purOutsourcedReceiptItems', 'create'),
    {
    receiptId: receipt.id as string,
    idx: 1,
    qty: '30',
    orderItemId,
    warehouseId: finished,
  })
  await deps.trading.outsourced.auditReceipt(
    permitFor(deps, actor, 'purOutsourcedReceipts', 'audit'),
    receipt.id as string,
    {},
  )
  return { itemId: String(item.id), receiptId: String(receipt.id) }
}
