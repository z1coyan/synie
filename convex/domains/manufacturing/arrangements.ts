import { Decimal, decimalToScaledInt64, roundBaseQty, scaledInt64ToDecimal } from '@synie/shared'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../../_generated/dataModel'
import type { Actor } from '../../lib/actor'
import { canAccessCompany } from '../../lib/companyScope'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError } from '../../lib/errors'
import {
  companyScopedStoredForMutation,
  getDomainRecord,
  hydrateStored,
  patchDomainComputed,
  unsafeStoredForMutation,
} from '../shared/records'

type MutationCtx = GenericMutationCtx<DataModel>
type QueryCtx = GenericQueryCtx<DataModel>
type ArrangementType = 'MAKE' | 'PURCHASE' | 'OUTSOURCE' | 'STOCK' | 'CLOSE'

function positive(value: string): Decimal {
  let result: Decimal
  try { result = new Decimal(value) } catch { throw synieError('validation', '安排数量必须是十进制字符串') }
  if (!result.isFinite() || result.lte(0)) throw synieError('validation', '安排数量必须大于零')
  return result
}

async function demandItem(ctx: MutationCtx, id: string) {
  return hydrateStored(await unsafeStoredForMutation(ctx, 'mfgDemandItems', id))
}

async function scopedDemandItem(ctx: MutationCtx, actor: Actor, id: string) {
  return hydrateStored(await companyScopedStoredForMutation(ctx, actor, 'mfgDemandItems', id))
}

async function allowedRatio(ctx: MutationCtx): Promise<Decimal> {
  const settings = await ctx.db.query('salesSettings').withIndex('by_key', (q) => q.eq('key', 'singleton')).unique()
  return new Decimal(scaledInt64ToDecimal(settings?.demandOverorderRatioScaled ?? 0n, 6))
}

async function assertCapacity(
  ctx: MutationCtx,
  demandItemId: string,
  nextBaseQty: Decimal,
  replacingBaseQty = new Decimal(0),
  hardCap = false,
): Promise<ReturnType<typeof demandItem>> {
  const item = await demandItem(ctx, demandItemId)
  if (item.status === 'COMPLETED') throw synieError('conflict', '已完成需求行不可再安排')
  const current = new Decimal(String(item.arrangedQty ?? '0')).sub(replacingBaseQty)
  const ratio = hardCap ? new Decimal(0) : await allowedRatio(ctx)
  const cap = new Decimal(String(item.baseQty)).mul(new Decimal(1).add(ratio))
  if (current.add(nextBaseQty).gt(cap)) throw synieError('conflict', hardCap ? '关闭数量不能超过剩余可安排' : '已安排数量超过需求超安排比例允许上限')
  return item
}

export async function recomputeDemandItem(
  ctx: MutationCtx,
  actor: Actor,
  demandItemId: string,
): Promise<void> {
  const item = await demandItem(ctx, demandItemId)
  const arrangements = await ctx.db.query('mfgDemandArrangements').withIndex('by_demand_item', (q) =>
    q.eq('demandItemId', demandItemId),
  ).collect()
  let arranged = 0n
  let ordered = 0n
  let manualCompleted = 0n
  let workCompleted = new Decimal(0)
  for (const row of arrangements) {
    arranged += row.baseQtyScaled
    if (row.arrangementType === 'PURCHASE' || row.arrangementType === 'OUTSOURCE') ordered += row.baseQtyScaled
    if (row.arrangementType === 'STOCK' || row.arrangementType === 'CLOSE') manualCompleted += row.baseQtyScaled
    if (row.workOrderId) {
      try {
        const order = hydrateStored(await unsafeStoredForMutation(ctx, 'mfgWorkOrders', row.workOrderId))
        if (order.status !== 'VOIDED') workCompleted = workCompleted.add(String(order.receivedBaseQty ?? '0'))
      } catch {
        // A missing work order is an invariant violation, but recompute remains deterministic
        // and will leave its arrangement visible for diagnosis instead of scanning another store.
      }
    }
  }
  const base = new Decimal(String(item.baseQty))
  const arrangedValue = new Decimal(scaledInt64ToDecimal(arranged, 6))
  const completed = new Decimal(scaledInt64ToDecimal(manualCompleted, 6))
    .add(workCompleted)
    .add(String(item.receivedQty ?? '0'))
  const ratio = await allowedRatio(ctx)
  const fulfilled = arrangedValue.gte(base.mul(new Decimal(1).add(ratio))) && completed.gte(base)
  const status = fulfilled ? 'COMPLETED' : arrangedValue.gt(0) ? 'SCHEDULED' : 'PENDING'
  await patchDomainComputed(ctx, actor, 'mfgDemandItems', demandItemId, {
    arrangedQty: scaledInt64ToDecimal(arranged, 6),
    orderedQty: scaledInt64ToDecimal(ordered, 6),
    completedQty: roundBaseQty(completed),
    remainingArrangeableQty: roundBaseQty(Decimal.max(base.sub(arrangedValue), 0)),
    remainingOrderableQty: roundBaseQty(Decimal.max(base.sub(new Decimal(scaledInt64ToDecimal(ordered, 6))), 0)),
    status,
  }, 'recomputeArrangement')
}

async function upsertLinked(
  ctx: MutationCtx,
  actor: Actor,
  input: {
    demandItemId: string
    companyId: string
    type: ArrangementType
    qty: string
    baseQty: string
    workOrderId?: string | null
    purchaseOrderItemId?: string | null
    remarks?: string | null
  },
): Promise<void> {
  const existing = input.workOrderId
    ? await ctx.db.query('mfgDemandArrangements').withIndex('by_work_order', (q) => q.eq('workOrderId', input.workOrderId!)).unique()
    : input.purchaseOrderItemId
      ? await ctx.db.query('mfgDemandArrangements').withIndex('by_purchase_order_item', (q) => q.eq('purchaseOrderItemId', input.purchaseOrderItemId!)).unique()
      : null
  const qty = positive(input.qty)
  const base = positive(input.baseQty)
  const previousBase = new Decimal(existing ? scaledInt64ToDecimal(existing.baseQtyScaled, 6) : '0')
  const item = await assertCapacity(ctx, input.demandItemId, base, previousBase)
  if (item.companyId !== input.companyId) throw synieError('conflict', '安排公司与需求行不一致')
  const now = Date.now()
  const values = {
    demandItemId: input.demandItemId,
    companyId: input.companyId,
    arrangementType: input.type,
    qtyScaled: decimalToScaledInt64(qty.toString(), 6),
    baseQtyScaled: decimalToScaledInt64(base.toString(), 6),
    workOrderId: input.workOrderId ?? null,
    purchaseOrderItemId: input.purchaseOrderItemId ?? null,
    remarks: input.remarks ?? null,
    updatedAt: now,
  }
  if (existing) await ctx.db.patch(existing._id, values)
  else await ctx.db.insert('mfgDemandArrangements', { ...values, insertedAt: now })
  await recomputeDemandItem(ctx, actor, input.demandItemId)
}

export async function upsertPurchaseArrangement(
  ctx: MutationCtx,
  actor: Actor,
  input: { demandItemId: string; companyId: string; purchaseOrderItemId: string; outsourced: boolean; qty: string; baseQty: string },
): Promise<void> {
  await upsertLinked(ctx, actor, { ...input, type: input.outsourced ? 'OUTSOURCE' : 'PURCHASE' })
}

export async function removePurchaseArrangement(ctx: MutationCtx, actor: Actor, purchaseOrderItemId: string): Promise<void> {
  const row = await ctx.db.query('mfgDemandArrangements').withIndex('by_purchase_order_item', (q) => q.eq('purchaseOrderItemId', purchaseOrderItemId)).unique()
  if (!row) return
  await ctx.db.delete(row._id)
  await recomputeDemandItem(ctx, actor, row.demandItemId)
}

export async function upsertMakeArrangement(
  ctx: MutationCtx,
  actor: Actor,
  input: { demandItemId: string; companyId: string; workOrderId: string; qty: string; baseQty: string },
): Promise<void> {
  await upsertLinked(ctx, actor, { ...input, type: 'MAKE' })
}

export async function removeMakeArrangement(ctx: MutationCtx, actor: Actor, workOrderId: string): Promise<void> {
  const row = await ctx.db.query('mfgDemandArrangements').withIndex('by_work_order', (q) => q.eq('workOrderId', workOrderId)).unique()
  if (!row) return
  await ctx.db.delete(row._id)
  await recomputeDemandItem(ctx, actor, row.demandItemId)
}

export async function createManualArrangement(
  ctx: MutationCtx,
  actor: Actor,
  input: { demandItemId: string; type: 'STOCK' | 'CLOSE'; qty: string; remarks?: string | null },
) {
  const item = await scopedDemandItem(ctx, actor, input.demandItemId)
  const parent = await demandItemParent(ctx, actor, item)
  if (parent.status !== 'CONFIRMED') throw synieError('conflict', '仅已确认未关闭需求单上的行可手工安排')
  const qty = positive(input.qty)
  const factor = new Decimal(String(item.baseQty)).div(String(item.qty))
  const base = qty.mul(factor)
  await assertCapacity(ctx, input.demandItemId, base, new Decimal(0), input.type === 'CLOSE')
  const now = Date.now()
  const id = await ctx.db.insert('mfgDemandArrangements', {
    demandItemId: input.demandItemId,
    companyId: String(item.companyId),
    arrangementType: input.type,
    qtyScaled: decimalToScaledInt64(qty.toString(), 6),
    baseQtyScaled: decimalToScaledInt64(base.toString(), 6),
    workOrderId: null,
    purchaseOrderItemId: null,
    remarks: input.remarks ?? null,
    insertedAt: now,
    updatedAt: now,
  })
  await recomputeDemandItem(ctx, actor, input.demandItemId)
  return { id, baseQty: roundBaseQty(base) }
}

async function demandItemParent(ctx: MutationCtx, actor: Actor, item: Record<string, unknown>) {
  if (typeof item.demandId !== 'string') throw synieError('internal', '需求行缺少需求单锚点')
  return hydrateStored(await companyScopedStoredForMutation(ctx, actor, 'mfgDemands', item.demandId))
}

export async function removeManualArrangement(ctx: MutationCtx, actor: Actor, id: string): Promise<void> {
  const normalized = ctx.db.normalizeId('mfgDemandArrangements', id)
  const row = normalized ? await ctx.db.get(normalized) : null
  if (!row) throw synieError('not_found', '安排不存在')
  if (!canAccessCompany(actor, row.companyId)) throw synieError('not_found', '安排不存在')
  const item = await scopedDemandItem(ctx, actor, row.demandItemId)
  if (item.companyId !== row.companyId) throw synieError('internal', '安排与需求行公司不一致')
  if (row.arrangementType !== 'STOCK' && row.arrangementType !== 'CLOSE') throw synieError('conflict', '仅库存/关闭安排可手工删除')
  await ctx.db.delete(row._id)
  await recomputeDemandItem(ctx, actor, row.demandItemId)
}

export async function listArrangements(ctx: QueryCtx, actor: Actor, demandItemId: string) {
  const item = await getDomainRecord(ctx, actor, 'mfgDemandItems', demandItemId)
  if (!item) throw synieError('not_found', '需求行不存在')
  const rows = await ctx.db.query('mfgDemandArrangements').withIndex('by_demand_item', (q) => q.eq('demandItemId', demandItemId)).collect()
  return rows.map((row) => ({
    id: row._id,
    demandItemId: row.demandItemId,
    companyId: row.companyId,
    arrangementType: row.arrangementType,
    qty: scaledInt64ToDecimal(row.qtyScaled, 6),
    baseQty: scaledInt64ToDecimal(row.baseQtyScaled, 6),
    workOrderId: row.workOrderId,
    purchaseOrderItemId: row.purchaseOrderItemId,
    remarks: row.remarks,
    insertedAt: row.insertedAt,
    updatedAt: row.updatedAt,
  }))
}
