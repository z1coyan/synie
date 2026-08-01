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
import { childrenFor, hydrateStored, patchDomainComputed, unsafeStoredForMutation } from '../shared/records'

type MutationCtx = Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0]

export type ReconciliationRuleHead = {
  side: 'sales' | 'purchase'
  reconciliationType: unknown
  companyId: unknown
  partyType: unknown
  partyId: unknown
}

export type ReconciliationRuleLine = {
  requestedQty: unknown
  sourceQty: unknown
  sourceBaseQty: unknown
  reconciledQty: unknown
  fulfillmentStatus: unknown
  companyId: unknown
  partyType: unknown
  partyId: unknown
  currencyCode: unknown
  orderPrice: unknown
  orderType: unknown
}

export type ReconciliationSourceSelection = {
  sourceResource: 'salDeliveryItems' | 'purReceiptItems' | 'purOutsourcedReceiptItems'
  sourceId: string
  trustedDerived: AggregateRecord
}

function optionalSourceId(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw synieError('validation', '对账来源条目必须是有效 ID')
  return value
}

/** Strict one-of source contract, evaluated before any source read or item write. */
export function assertReconciliationSourceSelection(
  side: 'sales' | 'purchase',
  input: AggregateRecord,
): ReconciliationSourceSelection {
  const deliveryItemId = optionalSourceId(input.deliveryItemId)
  const receiptItemId = optionalSourceId(input.receiptItemId)
  const outsourcedReceiptItemId = optionalSourceId(input.outsourcedReceiptItemId)
  if (side === 'sales') {
    if (receiptItemId || outsourcedReceiptItemId) {
      throw synieError('validation', '销售对账只允许发货条目来源')
    }
    if (!deliveryItemId) throw synieError('validation', '销售对账必须选择一个发货条目来源')
    return {
      sourceResource: 'salDeliveryItems',
      sourceId: deliveryItemId,
      trustedDerived: { deliveryItemId },
    }
  }
  if (deliveryItemId) throw synieError('validation', '采购对账不允许发货条目来源')
  if (Number(Boolean(receiptItemId)) + Number(Boolean(outsourcedReceiptItemId)) !== 1) {
    throw synieError('validation', '标准入库条目与委外入库条目必须恰选一个')
  }
  if (outsourcedReceiptItemId) {
    return {
      sourceResource: 'purOutsourcedReceiptItems',
      sourceId: outsourcedReceiptItemId,
      trustedDerived: { receiptItemId: null, outsourcedReceiptItemId },
    }
  }
  return {
    sourceResource: 'purReceiptItems',
    sourceId: receiptItemId!,
    trustedDerived: { receiptItemId, outsourcedReceiptItemId: null },
  }
}

function requiredDecimal(value: unknown, message: string): Decimal {
  try {
    const result = new Decimal(String(value))
    if (result.isFinite()) return result
  } catch {
    // Normalize malformed numeric values to one domain-facing error.
  }
  throw synieError('validation', message)
}

/** Shared by draft save and activation so stale source facts fail closed. */
export function assertReconciliationRules(
  head: ReconciliationRuleHead,
  lines: readonly ReconciliationRuleLine[],
): void {
  const currencies = new Set<string>()
  const kind = String(head.reconciliationType ?? '').toUpperCase()
  if (kind !== 'REGULAR' && kind !== 'GIFT_SAMPLE') {
    throw synieError('validation', '对账类型必须为常规或赠送/样品')
  }
  const regular = kind === 'REGULAR'
  for (const line of lines) {
    if (String(line.fulfillmentStatus ?? '').toUpperCase() !== 'AUDITED') {
      throw synieError('conflict', '仅已审核履约条目可对账')
    }
    if (
      String(line.companyId ?? '') !== String(head.companyId ?? '') ||
      String(line.partyType ?? '').toUpperCase() !== String(head.partyType ?? '').toUpperCase() ||
      String(line.partyId ?? '') !== String(head.partyId ?? '')
    ) {
      throw synieError('conflict', '对账单公司或对手与履约单不一致')
    }

    const requestedQty = requiredDecimal(line.requestedQty, '对账数量不合法')
    const sourceQty = requiredDecimal(line.sourceQty, '履约条目数量不合法')
    const sourceBaseQty = requiredDecimal(line.sourceBaseQty, '履约条目折算数量不合法')
    const reconciledQty = requiredDecimal(line.reconciledQty ?? '0', '已对账数量不合法')
    if (requestedQty.lte(0) || sourceQty.lte(0) || sourceBaseQty.lt(0) || reconciledQty.lt(0)) {
      throw synieError('validation', '对账数量必须大于零')
    }
    const requestedBaseQty = new Decimal(roundBaseQty(
      requestedQty.mul(sourceBaseQty).div(sourceQty),
    ))
    if (requestedBaseQty.gt(sourceBaseQty.sub(reconciledQty))) {
      throw synieError('conflict', '超过来源条目剩余可对账数量')
    }

    const currency = String(line.currencyCode ?? '')
    if (currency) currencies.add(currency)
    if (regular) {
      const price = requiredDecimal(line.orderPrice ?? '0', '来源订单价格不合法')
      if (!price.gt(0)) throw synieError('validation', '常规对账单不能选择零金额条目')
      if (head.side === 'sales' && String(line.orderType ?? '').toUpperCase() === 'SAMPLE') {
        throw synieError('validation', '常规销售对账单不能选择样品订单来源')
      }
    }
  }
  if (currencies.size > 1) {
    throw synieError('validation', '同一对账单的来源订单币种必须一致')
  }
}

async function source(ctx: MutationCtx, resource: string, value: unknown): Promise<AggregateRecord> {
  if (typeof value !== 'string') throw synieError('validation', '履约来源条目不能为空')
  return hydrateStored(await unsafeStoredForMutation(ctx, resource, value))
}

type LoadedReconciliationLine = {
  line: AggregateRecord
  fulfillment: AggregateRecord
  rule: ReconciliationRuleLine
  selection: ReconciliationSourceSelection
}

async function loadReconciliationLine(
  ctx: MutationCtx,
  side: 'sales' | 'purchase',
  input: AggregateRecord,
): Promise<LoadedReconciliationLine> {
  const selection = assertReconciliationSourceSelection(side, input)
  const line = await source(ctx, selection.sourceResource, selection.sourceId)
  const fulfillmentResource = side === 'sales'
    ? 'salDeliveries'
    : selection.sourceResource === 'purOutsourcedReceiptItems' ? 'purOutsourcedReceipts' : 'purReceipts'
  const fulfillment = await source(
    ctx,
    fulfillmentResource,
    line[side === 'sales' ? 'deliveryId' : 'receiptId'],
  )
  const orderItem = await source(
    ctx,
    side === 'sales' ? 'salOrderItems' : 'purOrderItems',
    line.orderItemId,
  )
  const order = await source(
    ctx,
    side === 'sales' ? 'salOrders' : 'purOrders',
    orderItem.orderId,
  )
  return {
    line,
    fulfillment,
    selection,
    rule: {
      requestedQty: input.qty,
      sourceQty: line.qty,
      sourceBaseQty: line.baseQty,
      reconciledQty: line.reconciledQty ?? '0',
      fulfillmentStatus: fulfillment.status,
      companyId: fulfillment.companyId,
      partyType: fulfillment.partyType,
      partyId: fulfillment.partyId,
      currencyCode: line.orderCurrencyCode ?? orderItem.currencyCode,
      orderPrice: line.orderPrice ?? orderItem.price,
      orderType: order.orderType,
    },
  }
}

async function assertReconciliationInput(
  ctx: MutationCtx,
  side: 'sales' | 'purchase',
  head: AggregateRecord,
  items: readonly AggregateRecord[],
): Promise<void> {
  const loaded = await Promise.all(items.map((item) => loadReconciliationLine(ctx, side, item)))
  assertReconciliationRules({
    side,
    reconciliationType: head.reconciliationType,
    companyId: head.companyId,
    partyType: head.partyType,
    partyId: head.partyId,
  }, loaded.map((item) => item.rule))
}

export async function assertReconciliationDraftCanActivate(
  ctx: MutationCtx,
  resource: 'salReconciliations' | 'purReconciliations',
  head: AggregateRecord,
  items?: readonly AggregateRecord[],
): Promise<void> {
  const side = resource === 'salReconciliations' ? 'sales' : 'purchase'
  const itemResource = side === 'sales' ? 'salReconciliationItems' : 'purReconciliationItems'
  await assertReconciliationInput(
    ctx,
    side,
    head,
    items ?? await childrenFor(ctx, itemResource, String(head.id)),
  )
}

async function deriveItem(
  ctx: MutationCtx,
  side: 'sales' | 'purchase',
  head: AggregateRecord,
  input: AggregateRecord,
): Promise<AggregateRecord> {
  const { line, fulfillment, rule, selection } = await loadReconciliationLine(ctx, side, input)
  assertReconciliationRules({
    side,
    reconciliationType: head.reconciliationType,
    companyId: head.companyId,
    partyType: head.partyType,
    partyId: head.partyId,
  }, [rule])
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
    ...selection.trustedDerived,
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
    deriveHead: async (ctx, _actor, input, previous) => {
      const head = { ...(previous ?? {}), ...input }
      if (
        previous &&
        input.reconciliationType !== undefined &&
        input.reconciliationType !== previous.reconciliationType
      ) {
        throw synieError('conflict', '对账类型不可变更')
      }
      await assertReconciliationInput(
        ctx,
        side,
        head,
        Array.isArray(input.items) ? input.items as AggregateRecord[] : [],
      )
      return previous ? { reconciliationType: previous.reconciliationType } : {}
    },
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
