import { Decimal, roundAmount, roundBaseQty } from '@synie/shared'
import { v } from 'convex/values'
import { authedMutation, authedQuery } from '../../lib/auth'
import { synieError } from '../../lib/errors'
import {
  createAggregate,
  loadAggregate,
  removeAggregate,
  replaceAggregate,
  type AggregatePolicy,
  type AggregateRecord,
} from '../shared/aggregate'
import { hydrateStored, patchDomainComputed, unsafeStoredForMutation } from '../shared/records'

type MutationCtx = Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0]

async function source(ctx: MutationCtx, resource: string, value: unknown): Promise<AggregateRecord> {
  if (typeof value !== 'string') throw synieError('validation', '履约来源条目不能为空')
  return hydrateStored(await unsafeStoredForMutation(ctx, resource, value))
}

async function deriveItem(
  ctx: MutationCtx,
  side: 'sales' | 'purchase',
  head: AggregateRecord,
  input: AggregateRecord,
): Promise<AggregateRecord> {
  const sourceResource = side === 'sales'
    ? 'salDeliveryItems'
    : input.outsourcedReceiptItemId ? 'purOutsourcedReceiptItems' : 'purReceiptItems'
  const sourceId = side === 'sales' ? input.deliveryItemId : input.outsourcedReceiptItemId ?? input.receiptItemId
  const line = await source(ctx, sourceResource, sourceId)
  const headResource = side === 'sales'
    ? 'salDeliveries'
    : sourceResource === 'purOutsourcedReceiptItems' ? 'purOutsourcedReceipts' : 'purReceipts'
  const parentField = side === 'sales' ? 'deliveryId' : 'receiptId'
  const fulfillment = await source(ctx, headResource, line[parentField])
  if (fulfillment.status !== 'AUDITED') throw synieError('conflict', '仅已审核履约条目可对账')
  if (fulfillment.companyId !== head.companyId || fulfillment.partyType !== head.partyType || fulfillment.partyId !== head.partyId) {
    throw synieError('conflict', '对账单公司或对手与履约单不一致')
  }
  const qty = new Decimal(String(input.qty))
  const sourceQty = new Decimal(String(line.qty))
  const sourceBaseQty = new Decimal(String(line.baseQty))
  if (!qty.isFinite() || qty.lte(0) || sourceQty.lte(0)) throw synieError('validation', '对账数量必须大于零')
  const baseQty = sourceBaseQty.mul(qty).div(sourceQty)
  const orderBaseQty = new Decimal(String(line.orderBaseQty ?? line.baseQty))
  const amount = orderBaseQty.isZero()
    ? new Decimal(0)
    : new Decimal(String(line.orderAmount ?? '0')).mul(baseQty).div(orderBaseQty)
  const baseAmount = orderBaseQty.isZero()
    ? new Decimal(0)
    : new Decimal(String(line.orderBaseAmount ?? '0')).mul(baseQty).div(orderBaseQty)
  return {
    baseQty: roundBaseQty(baseQty),
    amount: roundAmount(amount),
    baseAmount: roundAmount(baseAmount),
    reconciliationNo: head.reconciliationNo,
    reconciliationStatus: head.status,
    ...(side === 'sales'
      ? { deliveryNo: fulfillment.deliveryNo, deliveryDate: fulfillment.deliveryDate }
      : { receiptNo: fulfillment.receiptNo, receiptDate: fulfillment.receiptDate }),
    materialName: line.materialName,
    unitName: line.unitName,
    orderCurrencyCode: line.orderCurrencyCode,
  }
}

function reconciliationPolicy(side: 'sales' | 'purchase'): AggregatePolicy {
  const headResource = side === 'sales' ? 'salReconciliations' : 'purReconciliations'
  const itemResource = side === 'sales' ? 'salReconciliationItems' : 'purReconciliationItems'
  const policy: AggregatePolicy = {
    headResource,
    nodes: [{
      resource: itemResource,
      collection: 'items',
      parentField: 'reconciliationId',
      derive: (ctx, { head, input }) => deriveItem(ctx, side, head, input),
    }],
    afterSave: async (ctx, actor, head) => {
      const draft = await loadAggregate(ctx, actor, policy, String(head.id))
      const items = draft.items as AggregateRecord[]
      const gross = items.reduce((sum, item) => sum.add(String(item.amount ?? '0')), new Decimal(0))
      const baseGross = items.reduce((sum, item) => sum.add(String(item.baseAmount ?? '0')), new Decimal(0))
      await patchDomainComputed(ctx, actor, headResource, String(head.id), {
        grossTotal: roundAmount(gross),
        baseGrossTotal: roundAmount(baseGross),
      }, 'recalculate')
    },
  }
  return policy
}

const policies = {
  salReconciliations: reconciliationPolicy('sales'),
  purReconciliations: reconciliationPolicy('purchase'),
} as const
function policy(resource: string): AggregatePolicy {
  const result = policies[resource as keyof typeof policies]
  if (!result) throw synieError('validation', `资源 ${resource} 不是对账聚合草稿`)
  return result
}

export function createReconciliationDraftInMutation(
  ctx: Parameters<typeof createAggregate>[0],
  actor: Parameters<typeof createAggregate>[1],
  resource: string,
  input: unknown,
) {
  return createAggregate(ctx, actor, policy(resource), input)
}

export const loadDraft = authedQuery({ args: { resource: v.string(), id: v.string() }, returns: v.any(), handler: (ctx, args) => loadAggregate(ctx, ctx.actor, policy(args.resource), args.id) })
export const createDraft = authedMutation({ args: { resource: v.string(), input: v.any() }, returns: v.any(), handler: (ctx, args) => createReconciliationDraftInMutation(ctx, ctx.actor, args.resource, args.input) })
export const replaceDraft = authedMutation({ args: { resource: v.string(), id: v.string(), input: v.any() }, returns: v.any(), handler: (ctx, args) => replaceAggregate(ctx, ctx.actor, policy(args.resource), args.id, args.input) })
export const removeDraft = authedMutation({ args: { resource: v.string(), id: v.string() }, returns: v.null(), handler: async (ctx, args) => { await removeAggregate(ctx, ctx.actor, policy(args.resource), args.id); return null } })
