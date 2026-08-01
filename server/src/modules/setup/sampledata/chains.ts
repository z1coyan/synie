/**
 * 销/采链共用：报价 → 订单 → 履约 → 对账
 */
import type { TradingSide } from '~/modules/trading/common.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { daysAgo, type MasterData, type SeedCtx } from './helpers.ts'
import type { ReconLine, SampleDataDeps } from './types.ts'

export interface PricedLine {
  key: string
  price: string
}

export interface OrderLine {
  key: string
  quotationItemId: string
  qty: number
}

export interface FulfillLine {
  orderItemId: string
  qty: number
}

export async function createSideQuotation(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
  side: TradingSide,
  partyId: string,
  dateAgo: number,
  validDays: number,
  terms: string | null,
  audit: boolean,
  items: PricedLine[],
): Promise<{ byKey: Record<string, string>; id: string }> {
  const date = daysAgo(dateAgo)
  const qDate = new Date(`${date}T00:00:00Z`)
  qDate.setUTCDate(qDate.getUTCDate() + validDays)
  const validUntilStr = qDate.toISOString().slice(0, 10)

  const partyType = side === 'purchase' ? 'supplier' : 'customer'
  const label = side === 'purchase' ? '采购' : '销售'
  const statusLabel = audit ? '已审核' : '草稿'

  const head = await deps.trading.quotations.createHead(actor, side, {
    companyId: sc.company.id,
    quotationDate: date,
    validUntil: validUntilStr,
    partyType,
    partyId,
    terms,
    remarks: `初始化示例${label}报价(${statusLabel})`,
  })

  const byKey: Record<string, string> = {}
  for (let i = 0; i < items.length; i++) {
    const line = items[i]!
    const mat = md.materials[line.key]
    if (!mat) throw new Error(`示例物料缺失: ${line.key}`)
    const item = await deps.trading.quotations.createItem(actor, side, {
      quotationId: head.id,
      idx: i + 1,
      materialId: mat.id,
      unitId: mat.defaultUnitId,
      pricingMode: 'FIXED',
      price: line.price,
      taxRate: '0.13',
    })
    byKey[line.key] = item.id
  }
  if (audit) {
    await deps.trading.quotations.auditHead(actor, side, head.id)
  }
  return { byKey, id: head.id }
}

export async function createSideOrder(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
  side: TradingSide,
  partyId: string,
  dateAgoN: number,
  remarks: string,
  audit: boolean,
  items: OrderLine[],
): Promise<{ byIdx: Record<number, string>; id: string }> {
  const date = daysAgo(dateAgoN)
  const partyType = side === 'purchase' ? 'supplier' : 'customer'
  const head = await deps.trading.orders.createHead(actor, side, {
    companyId: sc.company.id,
    orderDate: date,
    orderType: 'REGULAR',
    partyType,
    partyId,
    remarks,
  })
  const byIdx: Record<number, string> = {}
  for (let i = 0; i < items.length; i++) {
    const line = items[i]!
    const mat = md.materials[line.key]
    if (!mat) throw new Error(`示例物料缺失: ${line.key}`)
    const item = await deps.trading.orders.createItem(actor, side, {
      orderId: head.id,
      idx: i + 1,
      qty: String(line.qty),
      materialId: mat.id,
      unitId: mat.defaultUnitId,
      quotationItemId: line.quotationItemId,
    })
    byIdx[i] = item.id
  }
  if (audit) {
    await deps.trading.orders.audit(actor, side, head.id)
  }
  return { byIdx, id: head.id }
}

export async function createSideFulfillment(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  side: TradingSide,
  partyId: string,
  dateAgoN: number,
  debit: string,
  credit: string,
  items: FulfillLine[],
): Promise<{ byIdx: Record<number, string>; id: string }> {
  const date = daysAgo(dateAgoN)
  const wh = sc.warehouses.default
  const partyType = side === 'purchase' ? 'supplier' : 'customer'
  const remarks = side === 'purchase' ? '初始化示例采购入库' : '初始化示例销售发货'
  if (side === 'sales') {
    const draft = await deps.trading.fulfillment.createSalesDraft(actor, {
      companyId: sc.company.id,
      documentDate: date,
      postingDate: date,
      partyType,
      partyId,
      warehouseId: wh,
      debitAccountId: debit,
      creditAccountId: credit,
      remarks,
      items: items.map((line, index) => ({
        idx: index + 1,
        qty: String(line.qty),
        orderItemId: line.orderItemId,
        warehouseId: wh,
      })),
      packBoxes: [],
    })
    const byIdx: Record<number, string> = {}
    draft.items.forEach((item, index) => {
      byIdx[index] = item.id
    })
    await deps.trading.fulfillment.auditHead(actor, side, draft.id)
    return { byIdx, id: draft.id }
  }
  const head = await deps.trading.fulfillment.createPurchaseHead(actor, {
    companyId: sc.company.id,
    documentDate: date,
    postingDate: date,
    partyType,
    partyId,
    warehouseId: wh,
    debitAccountId: debit,
    creditAccountId: credit,
    remarks,
  })
  const byIdx: Record<number, string> = {}
  for (let i = 0; i < items.length; i++) {
    const line = items[i]!
    const item = await deps.trading.fulfillment.createPurchaseItem(actor, {
      receiptId: head.id,
      idx: i + 1,
      qty: String(line.qty),
      orderItemId: line.orderItemId,
      warehouseId: wh,
    })
    byIdx[i] = String(item.id)
  }
  await deps.trading.fulfillment.auditHead(actor, side, head.id)
  return { byIdx, id: head.id }
}

export async function createSideReconciliation(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  side: TradingSide,
  partyId: string,
  remarks: string,
  confirm: boolean,
  items: ReconLine[],
): Promise<{ id: string; baseGrossTotal: string }> {
  const partyType = side === 'purchase' ? 'supplier' : 'customer'
  const head = await deps.trading.reconciliations.createHead(actor, side, {
    companyId: sc.company.id,
    kind: 'REGULAR',
    partyType,
    partyId,
    remarks,
  })
  for (let i = 0; i < items.length; i++) {
    const line = items[i]!
    const input: {
      reconciliationId: string
      idx: number
      qty: string
      deliveryItemId?: string
      receiptItemId?: string
      outsourcedReceiptItemId?: string
    } = {
      reconciliationId: String(head.id),
      idx: i + 1,
      qty: String(line.qty),
    }
    if (line.kind === 'delivery') input.deliveryItemId = line.sourceItemId
    if (line.kind === 'receipt') input.receiptItemId = line.sourceItemId
    if (line.kind === 'outsourced') input.outsourcedReceiptItemId = line.sourceItemId
    await deps.trading.reconciliations.createItem(actor, side, input)
  }
  if (confirm) {
    const confirmed = await deps.trading.reconciliations.confirm(actor, side, String(head.id))
    return {
      id: String(confirmed.id),
      baseGrossTotal: String(confirmed.baseGrossTotal ?? '0.00'),
    }
  }
  const got = await deps.trading.reconciliations.getHead(actor, side, String(head.id))
  return {
    id: String(got.id),
    baseGrossTotal: String(got.baseGrossTotal ?? '0.00'),
  }
}
