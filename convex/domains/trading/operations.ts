import { Decimal } from '@synie/shared'
import { v } from 'convex/values'
import type { GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../../_generated/dataModel'
import type { Actor } from '../../lib/actor'
import { permissionedQuery } from '../../lib/auth'
import { synieError, validationError } from '../../lib/errors'
import { childrenFor, getDomainRecord, listDomainRecords } from '../shared/records'

function positive(value: string): Decimal {
  try {
    const result = new Decimal(value)
    if (result.isFinite() && result.gt(0)) return result
  } catch {
    // Normalized validation below.
  }
  throw validationError('BOM 展开参数不合法', { quantity: ['必须大于 0'] })
}

export const purchaseDemandLines = permissionedQuery('purchase.order:read')({
  args: { companyId: v.string(), isOutsourced: v.boolean(), search: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const demands = await listDomainRecords(ctx, ctx.actor, 'mfgDemands', {
      numItems: 200,
      cursor: null,
      args: { companyId: args.companyId, status: 'CONFIRMED' },
    })
    const needle = args.search?.trim().toLocaleLowerCase() ?? ''
    const results = []
    for (const demand of demands.results) {
      for (const item of await childrenFor(ctx, 'mfgDemandItems', String(demand.id))) {
        if (item.status === 'COMPLETED') continue
        const remaining = new Decimal(String(item.remainingArrangeableQty ?? '0'))
        if (remaining.lte(0)) continue
        const searchable = `${demand.demandNo ?? ''} ${item.materialCode ?? ''} ${item.materialName ?? ''}`.toLocaleLowerCase()
        if (needle && !searchable.includes(needle)) continue
        results.push({
          id: item.id,
          demandId: demand.id,
          demandNo: demand.demandNo,
          idx: item.idx,
          needDate: item.needDate ?? null,
          companyId: demand.companyId,
          materialId: item.materialId,
          unitId: item.unitId,
          materialCode: item.materialCode,
          materialName: item.materialName,
          materialSpec: item.materialSpec ?? null,
          unitName: item.unitName,
          baseQty: item.baseQty,
          orderedQty: item.orderedQty ?? '0',
          arrangedQty: item.arrangedQty ?? '0',
          remainingBaseQty: remaining.toString(),
          suggestedQty: remaining.toString(),
          isOutsourced: args.isOutsourced,
        })
      }
    }
    return results.slice(0, 200)
  },
})

export const expandPurchaseBom = permissionedQuery('purchase.order:read')({
  args: { bomId: v.string(), quantity: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const quantity = positive(args.quantity)
    const bom = await getDomainRecord(ctx, ctx.actor, 'mfgBoms', args.bomId)
    if (!bom || bom.status !== 'ACTIVE') {
      throw validationError('BOM 展开参数不合法', { bomId: ['BOM 不存在或未启用'] })
    }
    const mapLine = async (line: Record<string, unknown>, includeLoss: boolean) => {
      const materialId = ctx.db.normalizeId('materials', String(line.materialId ?? ''))
      const unitId = ctx.db.normalizeId('units', String(line.unitId ?? ''))
      const [material, unit] = await Promise.all([
        materialId ? ctx.db.get(materialId) : null,
        unitId ? ctx.db.get(unitId) : null,
      ])
      if (!material || !unit) throw synieError('internal', 'BOM 行引用的物料或单位不存在')
      const base = new Decimal(String(line.quantity ?? '0'))
      const expanded = includeLoss
        ? base.mul(new Decimal(1).add(String(line.lossRate ?? '0'))).mul(quantity)
        : base.mul(quantity)
      return {
        materialId: material._id,
        materialCode: material.code,
        materialName: material.name,
        unitId: unit._id,
        unitName: unit.name,
        quantity: expanded.toString(),
        remarks: line.note == null ? null : String(line.note),
      }
    }
    const materials = await Promise.all(
      (await childrenFor(ctx, 'mfgBomComponents', args.bomId)).map((line) => mapLine(line, true)),
    )
    const byproducts = await Promise.all(
      (await childrenFor(ctx, 'mfgBomByproducts', args.bomId)).map((line) => mapLine(line, false)),
    )
    return { materials, byproducts }
  },
})

async function history(
  ctx: GenericQueryCtx<DataModel>,
  actor: Actor,
  side: 'sales' | 'purchase',
  orderId: string,
) {
  const orderResource = side === 'sales' ? 'salOrders' : 'purOrders'
  const orderItemResource = side === 'sales' ? 'salOrderItems' : 'purOrderItems'
  const flowItemResource = side === 'sales' ? 'salDeliveryItems' : 'purReceiptItems'
  const flowResource = side === 'sales' ? 'salDeliveries' : 'purReceipts'
  const parentField = side === 'sales' ? 'deliveryId' : 'receiptId'
  const head = await getDomainRecord(ctx, actor, orderResource, orderId)
  if (!head) throw synieError('not_found', '订单不存在')
  const results = []
  for (const orderItem of await childrenFor(ctx, orderItemResource, orderId)) {
    const references = await ctx.db.query('domainReferences').withIndex('by_target', (q) =>
      q.eq('targetResource', orderItemResource).eq('targetRecordId', String(orderItem.id)),
    ).collect()
    for (const reference of references) {
      if (reference.sourceResource !== flowItemResource) continue
      const item = await getDomainRecord(ctx, actor, flowItemResource, reference.sourceRecordId)
      if (!item || typeof item[parentField] !== 'string') continue
      const document = await getDomainRecord(ctx, actor, flowResource, item[parentField] as string)
      if (!document) continue
      results.push({
        flowType: side === 'sales' ? 'sales.delivery' : 'purchase.receipt',
        documentNo: String(side === 'sales' ? document.deliveryNo ?? '' : document.receiptNo ?? ''),
        documentDate: String(side === 'sales' ? document.deliveryDate ?? '' : document.receiptDate ?? ''),
        status: String(document.status ?? ''),
        companyId: String(document.companyId ?? ''),
        orderId,
        orderItemId: String(orderItem.id),
        materialCode: item.materialCode == null ? null : String(item.materialCode),
        materialName: item.materialName == null ? null : String(item.materialName),
        materialSpec: item.materialSpec == null ? null : String(item.materialSpec),
        customerPartNo: item.customerPartNo == null ? null : String(item.customerPartNo),
        unitName: item.unitName == null ? null : String(item.unitName),
        quantity: String(item.qty ?? '0'),
      })
    }
  }
  results.sort((left, right) => String(right.documentDate).localeCompare(String(left.documentDate)))
  return results
}

export const salesOrderHistory = permissionedQuery('sales.order:read')({
  args: { orderId: v.string() }, returns: v.any(),
  handler: (ctx, args) => history(ctx, ctx.actor, 'sales', args.orderId),
})
export const purchaseOrderHistory = permissionedQuery('purchase.order:read')({
  args: { orderId: v.string() }, returns: v.any(),
  handler: (ctx, args) => history(ctx, ctx.actor, 'purchase', args.orderId),
})
