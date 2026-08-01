import { Decimal, roundAmount, roundBaseQty, scaledInt64ToDecimal } from '@synie/shared'
import { v } from 'convex/values'
import type { Id } from '../_generated/dataModel'
import { authedMutation } from '../lib/auth'
import type { Actor } from '../lib/actor'
import { synieError } from '../lib/errors'
import { asDomainMutationCtx, type DomainMutationCtx } from '../lib/mutationContext'
import { requirePermission } from '../lib/permissions'
import { cancelGlInMutation, postGlInMutation, reverseGlInMutation } from '../engines/gl/engine'
import type { GlLine } from '../engines/gl/model'
import { cancelInventoryInMutation, postInventoryInMutation } from '../engines/inventory/engine'
import type { StockLine } from '../engines/inventory/model'
import { catalogDocument } from './shared/policies'
import {
  childrenFor,
  createDomainRecord,
  domainInternalForMutation,
  hydrateStored,
  patchDomainComputed,
  patchDomainStatus,
  unsafeStoredForMutation,
} from './shared/records'
import { warehouseRevision } from './inventory/revisions'
import { recomputeDemandItem, removeMakeArrangement } from './manufacturing/arrangements'
import { replayBill } from './finance/bills'
import { assertJournalNotBankReconciled, createBankReconciliation } from './finance/banking'
import { voidPriceIndex } from './market/domain'
import {
  closeReconciliationTodo,
  openReconciliationTodo,
} from './todo/domain'

type Wire = Record<string, unknown>
type CommandKey =
  | 'audit' | 'void' | 'close' | 'cancel' | 'ship' | 'receive'
  | 'approve' | 'confirm' | 'unconfirm' | 'reverse'
  | 'activate' | 'deactivate' | 'reconcile' | 'recalc'

type Transition = { from: readonly (string | null)[]; to: string }

const TRANSITIONS: Readonly<Record<string, Readonly<Partial<Record<CommandKey, Transition>>>>> = Object.freeze({
  basMarketPricePoints: { void: { from: [null, 'ACTIVE'], to: 'VOIDED' } },
  invStockDocs: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  invStockTransfers: { ship: { from: ['DRAFT'], to: 'SHIPPED' }, receive: { from: ['SHIPPED'], to: 'RECEIVED' } },
  invStockCounts: { approve: { from: ['DRAFT'], to: 'AUDITED' }, cancel: { from: ['DRAFT', 'AUDITED'], to: 'CANCELLED' } },
  accGlJournals: { audit: { from: ['DRAFT'], to: 'AUDITED' }, cancel: { from: ['DRAFT', 'AUDITED'], to: 'CANCELLED' } },
  salQuotations: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  purQuotations: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  salOrders: { audit: { from: ['DRAFT'], to: 'AUDITED' }, close: { from: ['AUDITED'], to: 'CLOSED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  purOrders: { audit: { from: ['DRAFT'], to: 'AUDITED' }, close: { from: ['AUDITED'], to: 'CLOSED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  salDeliveries: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  purReceipts: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  purOutsourcedIssues: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  purOutsourcedReceipts: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  salReconciliations: {
    confirm: { from: ['DRAFT'], to: 'CONFIRMED' }, unconfirm: { from: ['CONFIRMED'], to: 'DRAFT' },
    audit: { from: ['DRAFT'], to: 'CLOSED' }, void: { from: ['CLOSED'], to: 'VOIDED' },
  },
  purReconciliations: {
    confirm: { from: ['DRAFT'], to: 'CONFIRMED' }, unconfirm: { from: ['CONFIRMED'], to: 'DRAFT' },
    audit: { from: ['DRAFT'], to: 'CLOSED' }, void: { from: ['CLOSED'], to: 'VOIDED' },
  },
  accVatInvoices: {
    audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' },
    reverse: { from: ['AUDITED'], to: 'REVERSED' },
  },
  accExpenseReports: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  accBillTransactions: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['DRAFT', 'AUDITED'], to: 'VOIDED' } },
  mfgBoms: { activate: { from: ['DRAFT', 'INACTIVE'], to: 'ACTIVE' }, deactivate: { from: ['ACTIVE'], to: 'INACTIVE' } },
  mfgDemands: { audit: { from: ['DRAFT'], to: 'CONFIRMED' }, close: { from: ['CONFIRMED'], to: 'CLOSED' }, void: { from: ['CONFIRMED'], to: 'VOIDED' } },
  mfgWorkOrders: { void: { from: ['IN_PROGRESS'], to: 'VOIDED' } },
  mfgOutputs: { audit: { from: ['DRAFT'], to: 'AUDITED' }, void: { from: ['AUDITED'], to: 'VOIDED' } },
})

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw synieError('validation', `${label}不能为空`)
  return value
}

function date(value: unknown): string {
  const result = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date().toISOString().slice(0, 10)
  return result
}

function decimal(value: unknown, fallback = '0'): Decimal {
  try { return new Decimal(typeof value === 'string' ? value : fallback) } catch { return new Decimal(fallback) }
}

function currentStatus(row: Wire): string | null {
  return typeof row.status === 'string' ? row.status : null
}

async function rowFor(ctx: DomainMutationCtx, resource: string, id: string): Promise<Wire> {
  return hydrateStored(await unsafeStoredForMutation(ctx, resource, id))
}

async function childRows(ctx: DomainMutationCtx, resource: string, parentId: string): Promise<Wire[]> {
  return childrenFor(ctx, resource, parentId)
}

function stockLine(item: Wire, warehouseId: unknown, direction: 'in' | 'out'): StockLine {
  return {
    warehouseId: text(warehouseId, '仓库') as Id<'warehouses'>,
    materialId: text(item.materialId, '物料') as Id<'materials'>,
    quantity: text(item.baseQty ?? item.qty ?? item.convertedCounted ?? item.countedQuantity, '数量'),
    direction,
  }
}

async function stockPosting(
  ctx: DomainMutationCtx,
  resource: string,
  id: string,
  row: Wire,
  command: CommandKey,
): Promise<{ type: string; lines: StockLine[] } | null> {
  if (resource === 'invStockDocs' && command === 'audit') {
    const direction = String(row.direction).toUpperCase() === 'OUT' ? 'out' : 'in'
    return { type: catalogDocument(resource).permissionPrefix, lines: (await childRows(ctx, 'invStockDocItems', id)).map((item) => stockLine(item, row.warehouseId, direction)) }
  }
  if (resource === 'invStockTransfers' && (command === 'ship' || command === 'receive')) {
    const items = await childRows(ctx, 'invStockTransferItems', id)
    const lines: StockLine[] = []
    if (command === 'ship') {
      for (const item of items) {
        lines.push(stockLine(item, row.fromWarehouseId, 'out'))
        if (row.transitWarehouseId) lines.push(stockLine(item, row.transitWarehouseId, 'in'))
      }
    } else {
      for (const item of items) {
        if (row.transitWarehouseId) lines.push(stockLine(item, row.transitWarehouseId, 'out'))
        lines.push(stockLine(item, row.toWarehouseId, 'in'))
      }
    }
    return { type: `${catalogDocument(resource).permissionPrefix}.${command}`, lines }
  }
  if (resource === 'invStockCounts' && command === 'approve') {
    const lines: StockLine[] = []
    for (const item of await childRows(ctx, 'invStockCountItems', id)) {
      const delta = decimal(item.convertedCounted ?? item.countedQuantity).sub(decimal(item.bookQuantity))
      if (delta.isZero()) continue
      lines.push({
        warehouseId: text(row.warehouseId, '仓库') as Id<'warehouses'>,
        materialId: text(item.materialId, '物料') as Id<'materials'>,
        quantity: roundBaseQty(delta.abs()),
        direction: delta.isNegative() ? 'out' : 'in',
      })
    }
    return lines.length ? { type: catalogDocument(resource).permissionPrefix, lines } : null
  }
  if (resource === 'purOutsourcedIssues' && command === 'audit') {
    const lines: StockLine[] = []
    for (const item of await childRows(ctx, 'purOutsourcedIssueItems', id)) {
      lines.push(
        stockLine(item, item.fromWarehouseId ?? row.fromWarehouseId, 'out'),
        stockLine(item, item.outsourcedWarehouseId ?? row.outsourcedWarehouseId, 'in'),
      )
    }
    return { type: catalogDocument(resource).permissionPrefix, lines }
  }
  if (resource === 'purOutsourcedReceipts' && command === 'audit') {
    const lines: StockLine[] = []
    for (const item of await childRows(ctx, 'purOutsourcedReceiptItems', id)) {
      lines.push(stockLine(item, item.warehouseId ?? row.warehouseId, 'in'))
      for (const material of await childRows(ctx, 'purOutsourcedReceiptItemMaterials', String(item.id))) {
        lines.push(stockLine(material, material.outsourcedWarehouseId ?? row.outsourcedWarehouseId, 'out'))
      }
      for (const byproduct of await childRows(ctx, 'purOutsourcedReceiptItemByproducts', String(item.id))) {
        lines.push(stockLine(byproduct, byproduct.warehouseId ?? row.warehouseId, 'in'))
      }
    }
    return { type: catalogDocument(resource).permissionPrefix, lines }
  }
  const fulfillment: Record<string, { child: string; direction: 'in' | 'out'; warehouse: string }> = {
    salDeliveries: { child: 'salDeliveryItems', direction: 'out', warehouse: 'warehouseId' },
    purReceipts: { child: 'purReceiptItems', direction: 'in', warehouse: 'warehouseId' },
    mfgOutputs: { child: 'mfgOutputItems', direction: 'in', warehouse: 'warehouseId' },
  }
  const spec = fulfillment[resource]
  if (spec && command === 'audit') {
    return {
      type: catalogDocument(resource).permissionPrefix,
      lines: (await childRows(ctx, spec.child, id)).map((item) => stockLine(item, item.warehouseId ?? row[spec.warehouse], spec.direction)),
    }
  }
  return null
}

function balancedPair(debitAccountId: unknown, creditAccountId: unknown, amount: Decimal, row: Wire): GlLine[] | null {
  if (!debitAccountId || !creditAccountId || !amount.isFinite() || amount.lte(0)) return null
  const value = roundAmount(amount)
  return [
    { accountId: String(debitAccountId) as Id<'accounts'>, debit: value, credit: '0', partyType: row.partyType as string | undefined, partyId: row.partyId as string | undefined },
    { accountId: String(creditAccountId) as Id<'accounts'>, debit: '0', credit: value, partyType: row.partyType as string | undefined, partyId: row.partyId as string | undefined },
  ]
}

async function amountFromChildren(ctx: DomainMutationCtx, resource: string, parentId: string): Promise<Decimal> {
  return (await childRows(ctx, resource, parentId)).reduce((sum, item) =>
    sum.add(decimal(item.baseAmount ?? item.amount ?? item.orderBaseAmount).mul(
      item.orderBaseQty && item.baseQty
        ? decimal(item.baseQty).div(decimal(item.orderBaseQty, '1'))
        : 1,
    )), new Decimal(0))
}

async function glPosting(
  ctx: DomainMutationCtx,
  resource: string,
  id: string,
  row: Wire,
  command: CommandKey,
): Promise<GlLine[] | null> {
  if (command !== 'audit' && command !== 'approve') return null
  if (resource === 'accGlJournals') {
    return (await childRows(ctx, 'accGlJournalLines', id)).map((line) => ({
      accountId: text(line.accountId, '科目') as Id<'accounts'>,
      currencyId: typeof line.currencyId === 'string' ? line.currencyId as Id<'currencies'> : null,
      debit: typeof line.debit === 'string' ? line.debit : '0',
      credit: typeof line.credit === 'string' ? line.credit : '0',
      partyType: typeof line.partyType === 'string' ? line.partyType : null,
      partyId: typeof line.partyId === 'string' ? line.partyId : null,
    }))
  }
  if (resource === 'salDeliveries') return balancedPair(row.debitAccountId, row.creditAccountId, await amountFromChildren(ctx, 'salDeliveryItems', id), row)
  if (resource === 'purReceipts') return balancedPair(row.debitAccountId, row.creditAccountId, await amountFromChildren(ctx, 'purReceiptItems', id), row)
  if (resource === 'purOutsourcedReceipts') return balancedPair(row.debitAccountId, row.creditAccountId, await amountFromChildren(ctx, 'purOutsourcedReceiptItems', id), row)
  if (resource === 'accExpenseReports') {
    const items = await childRows(ctx, 'accExpenseReportItems', id)
    const total = items.reduce((sum, item) => sum.add(decimal(item.amount)), new Decimal(0))
    if (!row.paymentAccountId || total.lte(0)) return null
    const lines: GlLine[] = items.map((item) => ({
      accountId: text(item.expenseAccountId, '费用科目') as Id<'accounts'>,
      debit: roundAmount(decimal(item.amount)), credit: '0',
      partyType: 'EMPLOYEE', partyId: String(row.employeeId),
    }))
    lines.push({ accountId: String(row.paymentAccountId) as Id<'accounts'>, debit: '0', credit: roundAmount(total), partyType: 'EMPLOYEE', partyId: String(row.employeeId) })
    return lines
  }
  if (resource === 'accBillTransactions') {
    return balancedPair(row.billAccountId, row.settleAccountId ?? row.bankAccountId, decimal(row.netAmount ?? row.amount), row)
  }
  if (resource === 'accVatInvoices') {
    const gross = decimal(row.grossTotal)
    const net = decimal(row.netTotal)
    const tax = decimal(row.taxTotal)
    if (!row.partyAccountId || !row.amountAccountId || gross.lte(0)) return null
    const output = String(row.direction).toUpperCase() === 'OUTPUT'
    const party: GlLine = {
      accountId: String(row.partyAccountId) as Id<'accounts'>,
      debit: output ? roundAmount(gross) : '0', credit: output ? '0' : roundAmount(gross),
      partyType: row.partyType as string | undefined, partyId: row.partyId as string | undefined,
    }
    const amount: GlLine = { accountId: String(row.amountAccountId) as Id<'accounts'>, debit: output ? '0' : roundAmount(net), credit: output ? roundAmount(net) : '0' }
    const lines = [party, amount]
    if (tax.gt(0) && row.taxAccountId) lines.push({ accountId: String(row.taxAccountId) as Id<'accounts'>, debit: output ? '0' : roundAmount(tax), credit: output ? roundAmount(tax) : '0' })
    return lines
  }
  if (resource === 'salReconciliations') return balancedPair(row.debitAccountId, row.creditAccountId, decimal(row.baseGrossTotal ?? row.grossTotal), row)
  if (resource === 'purReconciliations') return balancedPair(row.debitAccountId, row.creditAccountId, decimal(row.baseGrossTotal ?? row.grossTotal), row)
  return null
}

async function applyFulfillmentProjection(
  ctx: DomainMutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  sign: 1 | -1,
) {
  const config: Record<string, { child: string; target: string; targetField: string; sourceId: string; remainingField: string; ratio: 'delivery' | 'receipt' | 'none' }> = {
    salDeliveries: { child: 'salDeliveryItems', target: 'salOrderItems', targetField: 'shippedQty', sourceId: 'orderItemId', remainingField: 'remainingBaseQty', ratio: 'delivery' },
    purReceipts: { child: 'purReceiptItems', target: 'purOrderItems', targetField: 'receivedQty', sourceId: 'orderItemId', remainingField: 'remainingBaseQty', ratio: 'receipt' },
    purOutsourcedReceipts: { child: 'purOutsourcedReceiptItems', target: 'purOrderItems', targetField: 'receivedQty', sourceId: 'orderItemId', remainingField: 'remainingBaseQty', ratio: 'receipt' },
    purOutsourcedIssues: { child: 'purOutsourcedIssueItems', target: 'purOrderItemMaterials', targetField: 'issuedQty', sourceId: 'orderItemMaterialId', remainingField: 'remainingIssueQty', ratio: 'none' },
  }
  const spec = config[resource]
  if (!spec) return
  const settings = spec.ratio === 'none'
    ? null
    : await ctx.db.query('salesSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
  const ratio = spec.ratio === 'delivery'
    ? scaledInt64ToDecimal(settings?.deliveryOvershipRatioScaled ?? 0n, 6)
    : spec.ratio === 'receipt'
      ? scaledInt64ToDecimal(settings?.receiptOverreceiveRatioScaled ?? 0n, 6)
      : '0'
  for (const item of await childRows(ctx, spec.child, id)) {
    const targetId = text(item[spec.sourceId], '来源条目')
    const target = await rowFor(ctx, spec.target, targetId)
    const current = decimal(target[spec.targetField])
    const delta = decimal(item.baseQty ?? item.qty).mul(sign)
    const next = current.add(delta)
    if (next.isNegative()) throw synieError('conflict', '受控数量投影不能为负数')
    const total = decimal(target.baseQty ?? target.quantity)
    if (sign > 0 && spec.ratio !== 'none' && next.gt(total.mul(new Decimal(1).add(ratio)))) {
      throw synieError('conflict', '超出订单条目可履约数量')
    }
    await patchDomainComputed(ctx, actor, spec.target, targetId, {
      [spec.targetField]: roundBaseQty(next),
      [spec.remainingField]: roundBaseQty(total.sub(next)),
    }, sign > 0 ? 'fulfill' : 'unfulfill')
    if (spec.target === 'purOrderItems' && typeof target.demandLineId === 'string') {
      const demandItem = await rowFor(ctx, 'mfgDemandItems', target.demandLineId)
      const received = decimal(demandItem.receivedQty).add(delta)
      if (received.isNegative()) throw synieError('conflict', '需求已收数量不能为负数')
      await patchDomainComputed(ctx, actor, 'mfgDemandItems', target.demandLineId, {
        receivedQty: roundBaseQty(received),
      }, sign > 0 ? 'receiveFromPurchase' : 'unreceiveFromPurchase')
      await recomputeDemandItem(ctx, actor, target.demandLineId)
    }
  }
}

async function applyReconciliationProjection(
  ctx: DomainMutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  sign: 1 | -1,
) {
  const sales = resource === 'salReconciliations'
  const childResource = sales ? 'salReconciliationItems' : 'purReconciliationItems'
  for (const item of await childRows(ctx, childResource, id)) {
    const targetResource = sales ? 'salDeliveryItems' : item.outsourcedReceiptItemId ? 'purOutsourcedReceiptItems' : 'purReceiptItems'
    const targetId = String(sales ? item.deliveryItemId : item.outsourcedReceiptItemId ?? item.receiptItemId)
    const target = await rowFor(ctx, targetResource, targetId)
    const next = decimal(target.reconciledQty).add(decimal(item.baseQty ?? item.qty).mul(sign))
    if (next.isNegative()) throw synieError('conflict', '对账消费数量不能为负数')
    const total = decimal(target.baseQty ?? target.qty)
    if (next.gt(total)) throw synieError('conflict', '对账数量超过可对账数量')
    await patchDomainComputed(ctx, actor, targetResource, targetId, {
      reconciledQty: roundBaseQty(next),
      remainingReconcilableQty: roundBaseQty(total.sub(next)),
    }, sign > 0 ? 'reconcile' : 'unreconcile')
  }
}

async function applyOutputProjection(ctx: DomainMutationCtx, actor: Actor, id: string, sign: 1 | -1) {
  const settings = await ctx.db.query('manufacturingSettings').withIndex('by_key', (q) =>
    q.eq('key', 'singleton'),
  ).unique()
  const ratio = new Decimal(scaledInt64ToDecimal(settings?.outputOverreceiveRatioScaled ?? 0n, 6))
  for (const item of await childRows(ctx, 'mfgOutputItems', id)) {
    const workOrderId = text(item.workOrderId, '工单')
    const order = await rowFor(ctx, 'mfgWorkOrders', workOrderId)
    if (order.status === 'VOIDED') throw synieError('conflict', '生产工单已作废,不可入库')
    const next = decimal(order.receivedBaseQty).add(decimal(item.baseQty ?? item.qty).mul(sign))
    const required = decimal(order.baseQty ?? order.qty)
    const maximum = required.mul(new Decimal(1).add(ratio))
    if (next.isNegative() || next.gt(maximum)) throw synieError('conflict', '生产入库数量超出工单容差范围')
    await patchDomainComputed(ctx, actor, 'mfgWorkOrders', workOrderId, {
      receivedBaseQty: roundBaseQty(next),
      remainingBaseQty: roundBaseQty(required.sub(next)),
      status: next.gte(required) ? 'COMPLETED' : 'IN_PROGRESS',
    }, sign > 0 ? 'complete' : 'uncomplete')
    if (typeof order.demandItemId === 'string') await recomputeDemandItem(ctx, actor, order.demandItemId)
  }
}

async function assertDemandCanAudit(ctx: DomainMutationCtx, id: string, demand: Wire): Promise<void> {
  const items = await childRows(ctx, 'mfgDemandItems', id)
  if (!items.length) throw synieError('conflict', '确认前必须至少填写一行需求行')
  const additions = new Map<string, Decimal>()
  for (const item of items) {
    if (typeof item.salesOrderItemId !== 'string') continue
    additions.set(
      item.salesOrderItemId,
      (additions.get(item.salesOrderItemId) ?? new Decimal(0)).add(String(item.baseQty)),
    )
  }
  for (const salesOrderItemId of [...additions.keys()].sort()) {
    const salesItem = await rowFor(ctx, 'salOrderItems', salesOrderItemId)
    if (salesItem.companyId !== demand.companyId) throw synieError('conflict', '销售订单条目不属于本公司')
    if (typeof salesItem.orderId !== 'string') throw synieError('internal', '销售订单条目缺少订单锚点')
    const order = await rowFor(ctx, 'salOrders', salesItem.orderId)
    if (order.status !== 'AUDITED') throw synieError('conflict', '仅已审核未关闭的销售订单条目可纳入')
    let occupied = new Decimal(0)
    const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
      q.eq('targetResource', 'salOrderItems').eq('targetRecordId', salesOrderItemId),
    ).collect()
    for (const reference of references) {
      if (reference.sourceResource !== 'mfgDemandItems') continue
      const linkedItem = await rowFor(ctx, 'mfgDemandItems', reference.sourceRecordId)
      if (linkedItem.demandId === id || typeof linkedItem.demandId !== 'string') continue
      const linkedDemand = await rowFor(ctx, 'mfgDemands', linkedItem.demandId)
      if (linkedDemand.status === 'CONFIRMED') occupied = occupied.add(String(linkedItem.baseQty))
    }
    if (occupied.add(additions.get(salesOrderItemId)!).gt(String(salesItem.baseQty))) {
      throw synieError('conflict', '超出销售订单条目可占用数量')
    }
  }
}

async function assertDemandCanVoid(ctx: DomainMutationCtx, id: string): Promise<void> {
  for (const item of await childRows(ctx, 'mfgDemandItems', id)) {
    const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
      q.eq('targetResource', 'mfgDemandItems').eq('targetRecordId', String(item.id)),
    ).collect()
    for (const reference of references) {
      if (reference.sourceResource === 'mfgWorkOrders') {
        const workOrder = await rowFor(ctx, 'mfgWorkOrders', reference.sourceRecordId)
        if (workOrder.status !== 'VOIDED') throw synieError('conflict', '存在未作废生产工单,不可作废需求单')
      }
      if (reference.sourceResource === 'purOrderItems') {
        const purchaseItem = await rowFor(ctx, 'purOrderItems', reference.sourceRecordId)
        if (typeof purchaseItem.orderId !== 'string') continue
        const purchaseOrder = await rowFor(ctx, 'purOrders', purchaseItem.orderId)
        if (purchaseOrder.status === 'AUDITED' || purchaseOrder.status === 'CLOSED') {
          throw synieError('conflict', '存在已审核未作废采购/委外订单,不可作废需求单')
        }
      }
    }
  }
}

async function assertWorkOrderHasNoAuditedOutput(ctx: DomainMutationCtx, id: string): Promise<void> {
  const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
    q.eq('targetResource', 'mfgWorkOrders').eq('targetRecordId', id),
  ).collect()
  for (const reference of references) {
    if (reference.sourceResource !== 'mfgOutputItems') continue
    const outputItem = await rowFor(ctx, 'mfgOutputItems', reference.sourceRecordId)
    if (typeof outputItem.outputId !== 'string') continue
    const output = await rowFor(ctx, 'mfgOutputs', outputItem.outputId)
    if (output.status === 'AUDITED') throw synieError('conflict', '存在已审核生产入库,不可作废工单')
  }
}

async function assertReconciliationCommand(
  ctx: DomainMutationCtx,
  resource: 'salReconciliations' | 'purReconciliations',
  id: string,
  row: Wire,
  key: CommandKey,
): Promise<void> {
  const kind = String(row.reconciliationType ?? '').toUpperCase()
  if ((key === 'confirm' || key === 'unconfirm') && kind !== 'REGULAR') {
    throw synieError('conflict', '仅常规对账单可确认或撤回确认')
  }
  if ((key === 'audit' || key === 'void') && kind !== 'GIFT_SAMPLE') {
    throw synieError('conflict', '仅赠送/样品对账单可结单或作废')
  }
  if ((key === 'confirm' || key === 'audit')) {
    const child = resource === 'salReconciliations' ? 'salReconciliationItems' : 'purReconciliationItems'
    if (!(await childRows(ctx, child, id)).length) throw synieError('conflict', '对账单至少需要一行')
  }
  if (key === 'unconfirm') {
    const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
      q.eq('targetResource', resource).eq('targetRecordId', id),
    ).collect()
    if (references.some((reference) => reference.sourceResource === 'accVatInvoices')) {
      throw synieError('conflict', '已关联发票，不可撤回确认')
    }
  }
}

async function postEffects(
  ctx: DomainMutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  row: Wire,
  key: CommandKey,
) {
  const stock = await stockPosting(ctx, resource, id, row, key)
  if (stock?.lines.length) {
    await postInventoryInMutation(ctx, {
      type: stock.type, id, no: String(row.docNo ?? row.deliveryNo ?? row.receiptNo ?? row.issueNo ?? row.outputNo ?? id),
      companyId: text(row.companyId, '公司'), postingDate: date(row.postingDate ?? row.docDate ?? row.deliveryDate ?? row.receiptDate ?? row.issueDate ?? row.outputDate),
    }, stock.lines)
  }
  const gl = await glPosting(ctx, resource, id, row, key)
  if (gl?.length) {
    await postGlInMutation(ctx, {
      type: catalogDocument(resource).permissionPrefix, id,
      no: String(row.voucherNo ?? row.docNo ?? row.deliveryNo ?? row.receiptNo ?? row.reconciliationNo ?? id),
      companyId: text(row.companyId, '公司'), postingDate: date(row.postingDate ?? row.date ?? row.invoiceDate ?? row.expenseDate ?? row.receiptDate ?? row.deliveryDate),
    }, gl)
  }
  if (['salDeliveries', 'purReceipts', 'purOutsourcedReceipts', 'purOutsourcedIssues'].includes(resource)) {
    await applyFulfillmentProjection(ctx, actor, resource, id, 1)
  }
  if ((resource === 'salReconciliations' || resource === 'purReconciliations') && (key === 'confirm' || key === 'audit')) {
    await applyReconciliationProjection(ctx, actor, resource, id, 1)
    if (key === 'confirm') await openReconciliationTodo(ctx, actor, resource, id, row, true)
  }
  if (resource === 'mfgOutputs') await applyOutputProjection(ctx, actor, id, 1)
  if (resource === 'invStockTransfers' && key === 'receive') {
    for (const item of await childRows(ctx, 'invStockTransferItems', id)) {
      await patchDomainComputed(ctx, actor, 'invStockTransferItems', String(item.id), {
        receivedQty: String(item.baseQty ?? '0'),
      }, 'receive')
    }
  }
  if (resource === 'accBillTransactions' && key === 'audit') {
    await replayBill(ctx, actor, text(row.billId, '票据'), { id, status: 'AUDITED' })
  }
  if (resource === 'accVatInvoices' && key === 'audit') {
    const links = [
      ['salReconciliations', row.salReconciliationId],
      ['purReconciliations', row.purReconciliationId],
    ] as const
    if (links.filter(([, targetId]) => typeof targetId === 'string').length > 1) {
      throw synieError('validation', '发票不能同时关联销售和采购对账单')
    }
    for (const [targetResource, targetId] of links) {
      if (typeof targetId !== 'string') continue
      const target = await rowFor(ctx, targetResource, targetId)
      if (target.status !== 'CONFIRMED') throw synieError('conflict', '仅已确认对账单可关联发票审核')
      await closeReconciliationTodo(ctx, targetResource, targetId, 'INVOICE_AUDIT')
      await patchDomainStatus(ctx, actor, targetResource, targetId, 'CLOSED', 'closeFromInvoice')
    }
  }
}

async function assertVatCanEnd(ctx: DomainMutationCtx, invoiceId: string): Promise<void> {
  const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
    q.eq('targetResource', 'accVatInvoices').eq('targetRecordId', invoiceId),
  ).collect()
  for (const reference of references) {
    if (reference.sourceResource !== 'accExpenseReportItems') continue
    const item = await rowFor(ctx, 'accExpenseReportItems', reference.sourceRecordId)
    if (typeof item.reportId !== 'string') continue
    const report = await rowFor(ctx, 'accExpenseReports', item.reportId)
    if (report.status !== 'VOIDED') throw synieError('conflict', '发票已被报销单引用，请先移除该行或作废报销单')
  }
}

async function reverseEffects(
  ctx: DomainMutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  previousStatus: string | null,
  key: CommandKey,
) {
  if (key === 'unconfirm' || (key === 'void' && previousStatus === 'CONFIRMED')) {
    if (resource === 'salReconciliations' || resource === 'purReconciliations') {
      await applyReconciliationProjection(ctx, actor, resource, id, -1)
      if (key === 'unconfirm') await closeReconciliationTodo(ctx, resource, id, 'UNCONFIRM')
    }
  }
  if (key === 'void' && previousStatus === 'CLOSED' &&
      (resource === 'salReconciliations' || resource === 'purReconciliations')) {
    await applyReconciliationProjection(ctx, actor, resource, id, -1)
    await cancelGlInMutation(ctx, catalogDocument(resource).permissionPrefix, id)
    return
  }
  if (!['AUDITED', 'RECEIVED', 'SHIPPED'].includes(previousStatus ?? '')) return
  const prefix = catalogDocument(resource).permissionPrefix
  if (resource === 'invStockTransfers') {
    await cancelInventoryInMutation(ctx, `${prefix}.ship`, id)
    await cancelInventoryInMutation(ctx, `${prefix}.receive`, id)
  } else {
    await cancelInventoryInMutation(ctx, prefix, id)
  }
  await cancelGlInMutation(ctx, prefix, id)
  if (['salDeliveries', 'purReceipts', 'purOutsourcedReceipts', 'purOutsourcedIssues'].includes(resource)) {
    await applyFulfillmentProjection(ctx, actor, resource, id, -1)
  }
  if (resource === 'mfgOutputs') await applyOutputProjection(ctx, actor, id, -1)
  if (resource === 'accBillTransactions') {
    const row = await rowFor(ctx, resource, id)
    await replayBill(ctx, actor, text(row.billId, '票据'), { id, status: 'VOIDED' })
  }
}

async function syncChildStatus(
  ctx: DomainMutationCtx,
  actor: Actor,
  resource: string,
  id: string,
  status: string,
): Promise<void> {
  const mapping: Readonly<Record<string, { child: string; field: string }>> = {
    salOrders: { child: 'salOrderItems', field: 'orderStatus' },
    purOrders: { child: 'purOrderItems', field: 'orderStatus' },
    salDeliveries: { child: 'salDeliveryItems', field: 'deliveryStatus' },
    purReceipts: { child: 'purReceiptItems', field: 'receiptStatus' },
    purOutsourcedIssues: { child: 'purOutsourcedIssueItems', field: 'issueStatus' },
    purOutsourcedReceipts: { child: 'purOutsourcedReceiptItems', field: 'receiptStatus' },
    salReconciliations: { child: 'salReconciliationItems', field: 'reconciliationStatus' },
    purReconciliations: { child: 'purReconciliationItems', field: 'reconciliationStatus' },
    mfgOutputs: { child: 'mfgOutputItems', field: 'outputStatus' },
  }
  const target = mapping[resource]
  if (!target) return
  for (const child of await childRows(ctx, target.child, id)) {
    await patchDomainComputed(ctx, actor, target.child, String(child.id), { [target.field]: status }, 'statusProjection')
  }
}

export const execute = authedMutation({
  args: { resource: v.string(), id: v.string(), key: v.string(), input: v.optional(v.any()) },
  returns: v.any(),
  handler: async (rawCtx, args) => {
    const ctx = asDomainMutationCtx(rawCtx)
    const document = catalogDocument(args.resource)
    const command = document.commands.find((item) => item.key === args.key)
    if (!command) throw synieError('validation', `${document.label}不支持命令 ${args.key}`)
    requirePermission(rawCtx.actor, `${document.permissionPrefix}:${command.requiredCapability}`)
    const key = args.key as CommandKey
    if (args.resource === 'accBankTransactions' && key === 'reconcile') {
      const input = (args.input ?? {}) as Wire
      return createBankReconciliation(
        ctx,
        rawCtx.actor,
        args.id,
        text(input.journalId, '会计凭证'),
        text(input.amount, '对账金额'),
      )
    }
    if (key === 'recalc') {
      throw synieError('validation', '考勤重算必须经 HR 考勤日闭包入口')
    }
    const transition = TRANSITIONS[args.resource]?.[key]
    if (!transition) throw synieError('validation', `${document.label}命令 ${key} 缺少显式状态机`)
    const row = await rowFor(ctx, args.resource, args.id)
    const before = currentStatus(row)
    if (!transition.from.includes(before)) {
      throw synieError('conflict', `${document.label}当前状态不能执行${args.key}`)
    }
    if (args.resource === 'mfgDemands' && key === 'audit') {
      await assertDemandCanAudit(ctx, args.id, row)
    }
    if ((args.resource === 'salReconciliations' || args.resource === 'purReconciliations') &&
        ['confirm', 'unconfirm', 'audit', 'void'].includes(key)) {
      await assertReconciliationCommand(ctx, args.resource, args.id, row, key)
    }
    if (args.resource === 'mfgDemands' && key === 'void') {
      await assertDemandCanVoid(ctx, args.id)
    }
    if (args.resource === 'mfgWorkOrders' && key === 'void') {
      await assertWorkOrderHasNoAuditedOutput(ctx, args.id)
    }
    if (args.resource === 'mfgOutputs' && key === 'audit' && !(await childRows(ctx, 'mfgOutputItems', args.id)).length) {
      throw synieError('conflict', '审核前必须至少填写一行入库条目')
    }
    if (args.resource === 'accVatInvoices' && (key === 'void' || key === 'reverse')) {
      await assertVatCanEnd(ctx, args.id)
    }
    if (args.resource === 'accGlJournals' && key === 'cancel') {
      await assertJournalNotBankReconciled(ctx, args.id)
    }
    if (args.resource === 'basMarketPricePoints' && key === 'void') {
      await voidPriceIndex(ctx, args.id)
    }
    if (args.resource === 'invStockCounts' && key === 'approve') {
      const internal = await domainInternalForMutation(ctx, args.resource, args.id)
      const snapshotRevision = internal.warehouseRevision
      const currentRevision = await warehouseRevision(ctx, text(row.warehouseId, '仓库'))
      if (typeof snapshotRevision !== 'bigint' || snapshotRevision !== currentRevision) {
        throw synieError('conflict', '盘点快照后仓库已有库存变动，请重新创建盘点快照')
      }
    }
    if (key === 'reverse') {
      const postingDate = text((args.input as Wire | undefined)?.postingDate, '红冲过账日期')
      await reverseGlInMutation(ctx, document.permissionPrefix, args.id, postingDate)
    } else if (key === 'void' || key === 'cancel' || key === 'unconfirm') {
      await reverseEffects(ctx, rawCtx.actor, args.resource, args.id, before, key)
    } else if (key === 'audit' || key === 'approve' || key === 'ship' || key === 'receive' || key === 'confirm') {
      await postEffects(ctx, rawCtx.actor, args.resource, args.id, row, key)
    }
    const statusExtra = args.resource === 'accVatInvoices' && (key === 'void' || key === 'reverse')
      ? {
          salReconciliationId: null,
          purReconciliationId: null,
          ...(key === 'reverse' ? { redInvoiceNo: (args.input as Wire | undefined)?.redInvoiceNo ?? null } : {}),
        }
      : args.resource === 'basMarketPricePoints' && key === 'void'
        ? { isVoided: true }
        : (args.resource === 'salReconciliations' || args.resource === 'purReconciliations') && key === 'audit'
          ? { postingDate: date((args.input as Wire | undefined)?.postingDate) }
          : {}
    if (args.resource === 'accVatInvoices' && (key === 'void' || key === 'reverse')) {
      for (const [targetResource, targetId] of [
        ['salReconciliations', row.salReconciliationId],
        ['purReconciliations', row.purReconciliationId],
      ] as const) {
        if (typeof targetId === 'string') {
          const target = await rowFor(ctx, targetResource, targetId)
          await patchDomainStatus(ctx, rawCtx.actor, targetResource, targetId, 'CONFIRMED', 'reopenFromInvoice')
          await openReconciliationTodo(ctx, rawCtx.actor, targetResource, targetId, target, false)
        }
      }
    }
    const result = await patchDomainStatus(ctx, rawCtx.actor, args.resource, args.id, transition.to, key, statusExtra)
    await syncChildStatus(ctx, rawCtx.actor, args.resource, args.id, transition.to)
    if (args.resource === 'mfgWorkOrders' && key === 'void') {
      await removeMakeArrangement(ctx, rawCtx.actor, args.id)
    }
    return result
  },
})
