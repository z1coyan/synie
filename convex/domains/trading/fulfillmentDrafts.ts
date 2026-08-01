import { Decimal, roundBaseQty } from '@synie/shared'
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
import {
  childrenFor,
  hydrateStored,
  unsafeStoredForMutation,
} from '../shared/records'
import { materialUnitSnapshot } from '../shared/snapshots'

type MutationCtx = Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0]

export type WarehouseRuleRecord = {
  companyId: unknown
  active: unknown
  isLeaf: unknown
  isOutsourced: unknown
  partyType: unknown
  partyId: unknown
}

type OutsourcedHead = Record<string, unknown>

export function assertWarehouseRule(
  kind: 'ordinary' | 'outsourced',
  warehouse: WarehouseRuleRecord | null,
  head: OutsourcedHead,
): void {
  if (!warehouse) throw synieError('conflict', '仓库不存在')
  if (String(warehouse.companyId) !== String(head.companyId)) {
    throw synieError('conflict', '仓库不属于本公司')
  }
  if (warehouse.active !== true) throw synieError('conflict', '仓库已停用')
  if (warehouse.isLeaf !== true) throw synieError('conflict', '仅可使用叶子仓')
  if (kind === 'outsourced') {
    if (warehouse.isOutsourced !== true) throw synieError('conflict', '仓库不是外协仓')
    if (
      String(warehouse.partyType ?? '').toUpperCase() !== String(head.partyType ?? '').toUpperCase() ||
      String(warehouse.partyId ?? '') !== String(head.partyId ?? '')
    ) {
      throw synieError('conflict', '外协仓未绑定当前对手')
    }
  }
}

export function assertIssueWarehousePair(fromWarehouseId: unknown, outsourcedWarehouseId: unknown): void {
  if (
    typeof fromWarehouseId !== 'string' || !fromWarehouseId ||
    typeof outsourcedWarehouseId !== 'string' || !outsourcedWarehouseId
  ) {
    throw synieError('validation', '调出仓与外协仓均为必填')
  }
  if (fromWarehouseId === outsourcedWarehouseId) {
    throw synieError('validation', '调出仓与外协仓不能相同')
  }
}

export function assertOutsourcedReceiptCurrencies(currencies: readonly unknown[]): void {
  const normalized = new Set(currencies.map((value) => String(value ?? '')))
  normalized.delete('')
  if (normalized.size > 1) {
    throw synieError('validation', '同一委外入库单的来源订单币种必须一致')
  }
}

async function warehouseFor(
  ctx: MutationCtx,
  value: unknown,
): Promise<WarehouseRuleRecord | null> {
  if (typeof value !== 'string' || !value) return null
  const id = ctx.db.normalizeId('warehouses', value)
  return id ? await ctx.db.get(id) : null
}

async function assertWarehouseId(
  ctx: MutationCtx,
  kind: 'ordinary' | 'outsourced',
  value: unknown,
  head: OutsourcedHead,
): Promise<void> {
  assertWarehouseRule(kind, await warehouseFor(ctx, value), head)
}

async function assertOptionalWarehouseId(
  ctx: MutationCtx,
  kind: 'ordinary' | 'outsourced',
  value: unknown,
  head: OutsourcedHead,
): Promise<void> {
  if (value == null || value === '') return
  await assertWarehouseId(ctx, kind, value, head)
}

async function source(ctx: MutationCtx, resource: string, value: unknown) {
  if (typeof value !== 'string') throw synieError('validation', '来源条目不能为空')
  return hydrateStored(await unsafeStoredForMutation(ctx, resource, value))
}

async function purchaseOrderFor(ctx: MutationCtx, item: AggregateRecord) {
  const orderId = item.orderId
  if (typeof orderId !== 'string') throw synieError('validation', '来源采购订单不存在')
  return source(ctx, 'purOrders', orderId)
}

function assertOrder(head: AggregateRecord, order: AggregateRecord): void {
  if (order.status !== 'AUDITED' || order.isOutsourced !== true) {
    throw synieError('conflict', '仅已审核委外采购订单可用于委外履约')
  }
  if (order.companyId !== head.companyId || order.partyType !== head.partyType || order.partyId !== head.partyId) {
    throw synieError('conflict', '委外履约公司或对手与采购订单不一致')
  }
}

async function issueSourceFor(
  ctx: MutationCtx,
  head: AggregateRecord,
  input: AggregateRecord,
): Promise<{ materialLine: AggregateRecord; orderItem: AggregateRecord; order: AggregateRecord }> {
  const materialLine = await source(ctx, 'purOrderItemMaterials', input.orderItemMaterialId)
  const orderItem = await source(ctx, 'purOrderItems', materialLine.orderItemId)
  const order = await purchaseOrderFor(ctx, orderItem)
  assertOrder(head, order)
  return { materialLine, orderItem, order }
}

async function receiptSourceFor(
  ctx: MutationCtx,
  head: AggregateRecord,
  input: AggregateRecord,
): Promise<{ orderItem: AggregateRecord; order: AggregateRecord }> {
  const orderItem = await source(ctx, 'purOrderItems', input.orderItemId)
  const order = await purchaseOrderFor(ctx, orderItem)
  assertOrder(head, order)
  return { orderItem, order }
}

async function assertHeadWarehouseDefaults(
  ctx: MutationCtx,
  head: AggregateRecord,
  ordinaryField: 'fromWarehouseId' | 'warehouseId',
): Promise<void> {
  await assertOptionalWarehouseId(ctx, 'ordinary', head[ordinaryField], head)
  await assertOptionalWarehouseId(ctx, 'outsourced', head.outsourcedWarehouseId, head)
}

function decimalOrNull(value: unknown): Decimal | null {
  try {
    const result = new Decimal(String(value))
    return result.isFinite() ? result : null
  } catch {
    return null
  }
}

export function controlledReceiptQuantities(
  baseQty: unknown,
  existingReconciledQty: unknown,
): { reconciledQty: string; remainingReconcilableQty: string } {
  const base = decimalOrNull(baseQty)
  const reconciled = decimalOrNull(existingReconciledQty ?? '0')
  if (!base || !reconciled || reconciled.lt(0)) {
    throw synieError('validation', '委外入库已对账数量不合法')
  }
  return {
    reconciledQty: roundBaseQty(reconciled),
    remainingReconcilableQty: roundBaseQty(base.sub(reconciled)),
  }
}

type CarryKind = 'material' | 'byproduct'

export function shouldCarryReceiptChildren(
  existing: AggregateRecord | null,
  lines: unknown,
): lines is AggregateRecord[] {
  return existing == null && Array.isArray(lines) && lines.length === 0
}

export function proportionalReceiptLines(
  kind: CarryKind,
  sources: AggregateRecord[],
  baseQty: unknown,
  orderBaseQty: unknown,
  warehouseId: unknown,
): AggregateRecord[] {
  const denominator = decimalOrNull(orderBaseQty)
  const numerator = decimalOrNull(baseQty)
  if (!denominator || !numerator || denominator.lte(0)) return []
  const ratio = numerator.div(denominator)
  let idx = 0
  return sources.flatMap((line) => {
    const sourceQty = decimalOrNull(line.quantity ?? '0')
    if (!sourceQty) return []
    const qty = sourceQty.mul(ratio)
    if (qty.lte(0)) return []
    const result: AggregateRecord = {
      idx: idx++,
      qty: roundBaseQty(qty),
      remarks: null,
      ...(kind === 'material'
        ? {
            orderItemMaterialId: line.id,
            outsourcedWarehouseId: warehouseId ?? null,
          }
        : {
            orderItemByproductId: line.id,
            warehouseId: warehouseId ?? null,
          }),
    }
    return [result]
  })
}

const issue: AggregatePolicy = {
  headResource: 'purOutsourcedIssues',
  deriveHead: async (ctx, _actor, input, previous) => {
    const head = { ...(previous ?? {}), ...input }
    await assertHeadWarehouseDefaults(ctx, head, 'fromWarehouseId')
    return {}
  },
  nodes: [{
    resource: 'purOutsourcedIssueItems', collection: 'items', parentField: 'issueId',
    derive: async (ctx, { head, input }) => {
      const { materialLine, order } = await issueSourceFor(ctx, head, input)
      const fromWarehouseId = input.fromWarehouseId ?? head.fromWarehouseId
      const outsourcedWarehouseId = input.outsourcedWarehouseId ?? head.outsourcedWarehouseId
      assertIssueWarehousePair(fromWarehouseId, outsourcedWarehouseId)
      await Promise.all([
        assertWarehouseId(ctx, 'ordinary', fromWarehouseId, head),
        assertWarehouseId(ctx, 'outsourced', outsourcedWarehouseId, head),
      ])
      return {
        ...(await materialUnitSnapshot(ctx, materialLine.materialId, materialLine.unitId, { field: 'qty', value: input.qty })),
        orderNo: order.orderNo,
        fromWarehouseId,
        outsourcedWarehouseId,
        issueNo: head.issueNo,
        issueDate: head.issueDate,
        issueStatus: head.status,
        partyType: head.partyType,
        partyId: head.partyId,
      }
    },
  }],
}

const receipt: AggregatePolicy = {
  headResource: 'purOutsourcedReceipts',
  deriveHead: async (ctx, _actor, input, previous) => {
    const head = { ...(previous ?? {}), ...input }
    await assertHeadWarehouseDefaults(ctx, head, 'warehouseId')
    const currencies: unknown[] = []
    for (const item of Array.isArray(input.items) ? input.items as AggregateRecord[] : []) {
      const { orderItem } = await receiptSourceFor(ctx, head, item)
      currencies.push(orderItem.currencyCode)
    }
    assertOutsourcedReceiptCurrencies(currencies)
    return {}
  },
  nodes: [{
    resource: 'purOutsourcedReceiptItems', collection: 'items', parentField: 'receiptId',
    derive: async (ctx, { head, input, existing }) => {
      const { orderItem, order } = await receiptSourceFor(ctx, head, input)
      const warehouseId = input.warehouseId ?? head.warehouseId
      await assertWarehouseId(ctx, 'ordinary', warehouseId, head)
      const snapshot = await materialUnitSnapshot(
        ctx,
        orderItem.materialId,
        input.unitId ?? orderItem.unitId,
        { field: 'qty', value: input.qty },
      )
      const controlled = controlledReceiptQuantities(
        snapshot.baseQty,
        existing?.reconciledQty,
      )

      // 迁移前语义：新成品行首次保存时按清单快照比例一次性带出；后续改数量不重算。
      // Aggregate 输入仍须显式带数组；调用方已提交子行时尊重调用方，不重复代入。
      if (existing == null) {
        if (shouldCarryReceiptChildren(existing, input.materialLines)) {
          input.materialLines = proportionalReceiptLines(
            'material',
            await childrenFor(ctx, 'purOrderItemMaterials', String(orderItem.id)),
            snapshot.baseQty,
            orderItem.baseQty,
            head.outsourcedWarehouseId,
          )
        }
        if (shouldCarryReceiptChildren(existing, input.byproductLines)) {
          input.byproductLines = proportionalReceiptLines(
            'byproduct',
            await childrenFor(ctx, 'purOrderItemByproducts', String(orderItem.id)),
            snapshot.baseQty,
            orderItem.baseQty,
            head.warehouseId,
          )
        }
      }
      return {
        ...snapshot,
        orderNo: order.orderNo,
        orderQty: orderItem.qty,
        orderBaseQty: orderItem.baseQty,
        orderUnitName: orderItem.unitName,
        orderPrice: orderItem.price,
        orderAmount: orderItem.amount,
        orderBasePrice: orderItem.basePrice,
        orderBaseAmount: orderItem.baseAmount,
        orderTaxRate: orderItem.taxRate,
        orderCurrencyCode: orderItem.currencyCode,
        ...controlled,
        warehouseId,
        receiptNo: head.receiptNo,
        receiptDate: head.receiptDate,
        receiptStatus: head.status,
        partyType: head.partyType,
        partyId: head.partyId,
      }
    },
    children: [
      {
        resource: 'purOutsourcedReceiptItemMaterials', collection: 'materialLines', parentField: 'receiptItemId',
        derive: async (ctx, { head, parent, input }) => {
          const line = await source(ctx, 'purOrderItemMaterials', input.orderItemMaterialId)
          const parentOrderItem = await source(ctx, 'purOrderItems', parent.orderItemId)
          if (line.orderItemId !== parentOrderItem.id) throw synieError('conflict', '材料扣减行不属于成品订单条目')
          const outsourcedWarehouseId = input.outsourcedWarehouseId ?? head.outsourcedWarehouseId
          await assertOptionalWarehouseId(ctx, 'outsourced', outsourcedWarehouseId, head)
          return {
            ...(await materialUnitSnapshot(ctx, line.materialId, line.unitId, { field: 'qty', value: input.qty })),
            orderNo: parent.orderNo,
            outsourcedWarehouseId,
            receiptNo: head.receiptNo,
          }
        },
      },
      {
        resource: 'purOutsourcedReceiptItemByproducts', collection: 'byproductLines', parentField: 'receiptItemId',
        derive: async (ctx, { head, parent, input }) => {
          const line = await source(ctx, 'purOrderItemByproducts', input.orderItemByproductId)
          const parentOrderItem = await source(ctx, 'purOrderItems', parent.orderItemId)
          if (line.orderItemId !== parentOrderItem.id) throw synieError('conflict', '副产物行不属于成品订单条目')
          const warehouseId = input.warehouseId ?? head.warehouseId
          await assertOptionalWarehouseId(ctx, 'ordinary', warehouseId, head)
          return {
            ...(await materialUnitSnapshot(ctx, line.materialId, line.unitId, { field: 'qty', value: input.qty })),
            orderNo: parent.orderNo,
            warehouseId,
            receiptNo: head.receiptNo,
          }
        },
      },
    ],
  }],
}

/** Re-read mutable order/warehouse facts immediately before audit side effects. */
export async function assertOutsourcedDraftCanActivate(
  ctx: MutationCtx,
  resource: 'purOutsourcedIssues' | 'purOutsourcedReceipts',
  head: AggregateRecord,
): Promise<void> {
  if (resource === 'purOutsourcedIssues') {
    const items = await childrenFor(ctx, 'purOutsourcedIssueItems', String(head.id))
    if (!items.length) throw synieError('conflict', '委外发料单至少需要一条发料行')
    for (const item of items) {
      await issueSourceFor(ctx, head, item)
      assertIssueWarehousePair(item.fromWarehouseId, item.outsourcedWarehouseId)
      await Promise.all([
        assertWarehouseId(ctx, 'ordinary', item.fromWarehouseId, head),
        assertWarehouseId(ctx, 'outsourced', item.outsourcedWarehouseId, head),
      ])
    }
    return
  }

  const items = await childrenFor(ctx, 'purOutsourcedReceiptItems', String(head.id))
  if (!items.length) throw synieError('conflict', '委外入库单至少需要一条成品行')
  const currencies: unknown[] = []
  for (const item of items) {
    const { orderItem } = await receiptSourceFor(ctx, head, item)
    currencies.push(orderItem.currencyCode)
    await assertWarehouseId(ctx, 'ordinary', item.warehouseId, head)
    for (const material of await childrenFor(
      ctx,
      'purOutsourcedReceiptItemMaterials',
      String(item.id),
    )) {
      const sourceLine = await source(ctx, 'purOrderItemMaterials', material.orderItemMaterialId)
      if (sourceLine.orderItemId !== item.orderItemId) {
        throw synieError('conflict', '材料扣减行不属于成品订单条目')
      }
      if (typeof material.outsourcedWarehouseId !== 'string' || !material.outsourcedWarehouseId) {
        throw synieError('conflict', '材料扣减行必须填写外协仓')
      }
      await assertWarehouseId(ctx, 'outsourced', material.outsourcedWarehouseId, head)
    }
    for (const byproduct of await childrenFor(
      ctx,
      'purOutsourcedReceiptItemByproducts',
      String(item.id),
    )) {
      const sourceLine = await source(ctx, 'purOrderItemByproducts', byproduct.orderItemByproductId)
      if (sourceLine.orderItemId !== item.orderItemId) {
        throw synieError('conflict', '副产物行不属于成品订单条目')
      }
      if (typeof byproduct.warehouseId !== 'string' || !byproduct.warehouseId) {
        throw synieError('conflict', '副产物行必须填写入仓')
      }
      await assertWarehouseId(ctx, 'ordinary', byproduct.warehouseId, head)
    }
  }
  assertOutsourcedReceiptCurrencies(currencies)
}

const policies = { purOutsourcedIssues: issue, purOutsourcedReceipts: receipt } as const
function policy(resource: string): AggregatePolicy {
  const result = policies[resource as keyof typeof policies]
  if (!result) throw synieError('validation', `资源 ${resource} 不是委外聚合草稿`)
  return result
}

export function createOutsourcedDraftInMutation(
  ctx: Parameters<typeof createAggregate>[0],
  actor: Parameters<typeof createAggregate>[1],
  resource: string,
  input: unknown,
) {
  return createAggregate(ctx, actor, policy(resource), input)
}

export const loadDraft = authedQuery({ args: { resource: v.string(), id: v.string() }, returns: v.any(), handler: (ctx, args) => loadAggregate(ctx, ctx.actor, policy(args.resource), args.id) })
export const createDraft = authedMutation({ args: { resource: v.string(), input: v.any() }, returns: v.any(), handler: (ctx, args) => createOutsourcedDraftInMutation(ctx, ctx.actor, args.resource, args.input) })
export const replaceDraft = authedMutation({ args: { resource: v.string(), id: v.string(), input: v.any() }, returns: v.any(), handler: (ctx, args) => replaceAggregate(ctx, ctx.actor, policy(args.resource), args.id, args.input) })
export const removeDraft = authedMutation({ args: { resource: v.string(), id: v.string() }, returns: v.null(), handler: async (ctx, args) => { await removeAggregate(ctx, ctx.actor, policy(args.resource), args.id); return null } })
