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
import { hydrateStored, unsafeStoredForMutation } from '../shared/records'
import { materialUnitSnapshot } from '../shared/snapshots'

async function source(ctx: Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0], resource: string, value: unknown) {
  if (typeof value !== 'string') throw synieError('validation', '来源条目不能为空')
  return hydrateStored(await unsafeStoredForMutation(ctx, resource, value))
}

async function purchaseOrderFor(ctx: Parameters<NonNullable<AggregatePolicy['nodes'][number]['derive']>>[0], item: AggregateRecord) {
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

const issue: AggregatePolicy = {
  headResource: 'purOutsourcedIssues',
  nodes: [{
    resource: 'purOutsourcedIssueItems', collection: 'items', parentField: 'issueId',
    derive: async (ctx, { head, input }) => {
      const materialLine = await source(ctx, 'purOrderItemMaterials', input.orderItemMaterialId)
      const orderItem = await source(ctx, 'purOrderItems', materialLine.orderItemId)
      const order = await purchaseOrderFor(ctx, orderItem)
      assertOrder(head, order)
      const fromWarehouseId = input.fromWarehouseId ?? head.fromWarehouseId
      const outsourcedWarehouseId = input.outsourcedWarehouseId ?? head.outsourcedWarehouseId
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
  nodes: [{
    resource: 'purOutsourcedReceiptItems', collection: 'items', parentField: 'receiptId',
    derive: async (ctx, { head, input }) => {
      const orderItem = await source(ctx, 'purOrderItems', input.orderItemId)
      const order = await purchaseOrderFor(ctx, orderItem)
      assertOrder(head, order)
      return {
        ...(await materialUnitSnapshot(ctx, orderItem.materialId, input.unitId ?? orderItem.unitId, { field: 'qty', value: input.qty })),
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
        reconciledQty: input.reconciledQty ?? '0',
        remainingReconcilableQty: input.qty,
        warehouseId: input.warehouseId ?? head.warehouseId,
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
          return {
            ...(await materialUnitSnapshot(ctx, line.materialId, line.unitId, { field: 'qty', value: input.qty })),
            orderNo: parent.orderNo,
            outsourcedWarehouseId: input.outsourcedWarehouseId ?? head.outsourcedWarehouseId,
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
          return {
            ...(await materialUnitSnapshot(ctx, line.materialId, line.unitId, { field: 'qty', value: input.qty })),
            orderNo: parent.orderNo,
            warehouseId: input.warehouseId ?? head.warehouseId,
            receiptNo: head.receiptNo,
          }
        },
      },
    ],
  }],
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
