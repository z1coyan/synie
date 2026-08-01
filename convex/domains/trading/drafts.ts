import { Decimal, roundAmount, roundBasePrice, roundBaseQty, scaledInt64ToDecimal } from '@synie/shared'
import { v } from 'convex/values'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel, Id } from '../../_generated/dataModel'
import { authedMutation, authedQuery } from '../../lib/auth'
import type { Actor } from '../../lib/actor'
import { synieError, validationError } from '../../lib/errors'
import { requirePermission } from '../../lib/permissions'
import { catalogDocument } from '../shared/policies'
import {
  childrenFor,
  createDomainRecord,
  getDomainRecord,
  hydrateStored,
  removeDomainRecord,
  unsafeStoredForMutation,
  updateDomainRecord,
} from '../shared/records'
import { currencySnapshot } from '../shared/snapshots'
import {
  removePurchaseArrangement,
  upsertPurchaseArrangement,
} from '../manufacturing/arrangements'

type QueryCtx = GenericQueryCtx<DataModel>
type MutationCtx = GenericMutationCtx<DataModel>
type DraftRecord = Record<string, unknown>

const HEADS = [
  'purOrders', 'purQuotations', 'purReceipts',
  'salDeliveries', 'salOrders', 'salQuotations',
] as const
type HeadResource = (typeof HEADS)[number]

function headResource(value: string): HeadResource {
  if (!(HEADS as readonly string[]).includes(value)) {
    throw synieError('validation', `资源 ${value} 不是聚合草稿表头`)
  }
  return value as HeadResource
}

function object(value: unknown, path: string): DraftRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw synieError('validation', `聚合草稿 ${path} 必须是对象`)
  }
  return value as DraftRecord
}

function array(parent: DraftRecord, field: string, path = field): DraftRecord[] {
  const value = parent[field]
  if (!Array.isArray(value)) throw synieError('validation', `聚合草稿 ${path} 必须显式提交数组`)
  return value.map((item, index) => object(item, `${path}[${index}]`))
}

function without(input: DraftRecord, fields: readonly string[]): DraftRecord {
  const result = { ...input }
  for (const field of fields) delete result[field]
  return result
}

function declaredDerived(resource: string, input: DraftRecord): DraftRecord {
  const fields = new Set(catalogDocument(resource).fields.map((field) => field.name))
  return Object.fromEntries(
    Object.entries(input).filter(([field, value]) => fields.has(field) && value !== undefined),
  )
}

function positiveDecimal(value: unknown, path: string): string {
  if (typeof value !== 'string') throw validationError('聚合草稿不合法', { [path]: ['必须是十进制字符串'] })
  let decimal: Decimal
  try { decimal = new Decimal(value) } catch { throw validationError('聚合草稿不合法', { [path]: ['必须是十进制字符串'] }) }
  if (!decimal.isFinite() || decimal.lte(0)) throw validationError('聚合草稿不合法', { [path]: ['必须大于零'] })
  return value
}

function sorted(rows: DraftRecord[]): DraftRecord[] {
  return [...rows].sort((left, right) =>
    Number(left.idx ?? left.seq ?? 0) - Number(right.idx ?? right.seq ?? 0) ||
    String(left.id).localeCompare(String(right.id)),
  )
}

async function materialSnapshot(
  ctx: QueryCtx | MutationCtx,
  materialId: unknown,
  unitId: unknown,
  quantity?: unknown,
): Promise<DraftRecord> {
  if (typeof materialId !== 'string' || typeof unitId !== 'string') {
    throw synieError('validation', '物料和单位不能为空')
  }
  const materialKey = ctx.db.normalizeId('materials', materialId)
  const unitKey = ctx.db.normalizeId('units', unitId)
  const [material, unit] = await Promise.all([
    materialKey ? ctx.db.get(materialKey) : null,
    unitKey ? ctx.db.get(unitKey) : null,
  ])
  if (!material?.active) throw synieError('validation', '物料不存在或已停用')
  if (!unit) throw synieError('validation', '单位不存在')
  let factor = '1'
  if (material.defaultUnitId !== unit._id) {
    const conversion = await ctx.db.query('materialUnits').withIndex('by_material_unit', (q) =>
      q.eq('materialId', material._id).eq('unitId', unit._id),
    ).unique()
    if (!conversion) throw synieError('validation', '物料没有该单位换算关系')
    factor = scaledInt64ToDecimal(conversion.factorScaled, 6)
  }
  const result: DraftRecord = {
    materialId: material._id,
    unitId: unit._id,
    materialCode: material.code,
    materialName: material.name,
    materialSpec: material.spec,
    customerPartNo: material.customerPartNo,
    unitName: unit.name,
  }
  if (quantity !== undefined) {
    const qty = positiveDecimal(quantity, 'qty')
    result.baseQty = roundBaseQty(new Decimal(qty).mul(factor))
  }
  return result
}

async function orderItemSnapshot(
  ctx: MutationCtx,
  resource: 'salOrderItems' | 'purOrderItems',
  id: unknown,
): Promise<DraftRecord> {
  if (typeof id !== 'string') throw synieError('validation', '订单条目不能为空')
  return hydrateStored(await unsafeStoredForMutation(ctx, resource, id))
}

async function enrichItem(
  ctx: MutationCtx,
  head: DraftRecord,
  childResource: string,
  input: DraftRecord,
): Promise<DraftRecord> {
  let materialId = input.materialId
  let unitId = input.unitId
  let sourceOrderItem: DraftRecord | null = null
  if (childResource === 'salDeliveryItems') {
    sourceOrderItem = await orderItemSnapshot(ctx, 'salOrderItems', input.orderItemId)
  } else if (childResource === 'purReceiptItems') {
    sourceOrderItem = await orderItemSnapshot(ctx, 'purOrderItems', input.orderItemId)
  }
  if (sourceOrderItem) {
    if (sourceOrderItem.companyId !== head.companyId || sourceOrderItem.partyId !== head.partyId) {
      throw synieError('validation', '订单条目与单据公司或对手不一致')
    }
    materialId = sourceOrderItem.materialId
    unitId = input.unitId ?? sourceOrderItem.unitId
  }
  const snapshot = await materialSnapshot(ctx, materialId, unitId, input.qty ?? input.quantity)
  const derived: DraftRecord = {
    ...snapshot,
    companyId: head.companyId,
    partyType: head.partyType,
    partyId: head.partyId,
  }
  if (sourceOrderItem) {
    Object.assign(derived, {
      orderItemId: sourceOrderItem.id,
      orderQty: sourceOrderItem.qty,
      orderBaseQty: sourceOrderItem.baseQty,
      orderPrice: sourceOrderItem.price,
      orderAmount: sourceOrderItem.amount,
      orderBasePrice: sourceOrderItem.basePrice,
      orderBaseAmount: sourceOrderItem.baseAmount,
      orderTaxRate: sourceOrderItem.taxRate,
      orderCurrencyCode: sourceOrderItem.currencyCode ?? null,
      materialId: sourceOrderItem.materialId,
      warehouseId: input.warehouseId ?? head.warehouseId,
      reconciledQty: '0',
      remainingReconcilableQty: input.qty,
    })
    const orderId = sourceOrderItem.orderId
    if (typeof orderId === 'string') {
      const orderResource = childResource === 'salDeliveryItems' ? 'salOrders' : 'purOrders'
      const order = hydrateStored(await unsafeStoredForMutation(ctx, orderResource, orderId))
      derived.orderNo = order.orderNo
    }
  }
  if (childResource === 'salQuotationItems' || childResource === 'purQuotationItems') {
    Object.assign(derived, await currencySnapshot(ctx, head.currencyId))
    derived.quotationDate = head.quotationDate
    derived.validUntil = head.validUntil
    derived.quotationStatus = head.status
  }
  if (childResource.endsWith('OrderItems')) {
    const qty = positiveDecimal(input.qty, 'qty')
    const price = typeof input.price === 'string' ? input.price : '0'
    const exchangeRate = typeof head.exchangeRate === 'string' ? head.exchangeRate : '1'
    derived.amount = roundAmount(new Decimal(qty).mul(price))
    derived.basePrice = roundBasePrice(new Decimal(price).mul(exchangeRate))
    derived.baseAmount = roundAmount(new Decimal(String(derived.amount)).mul(exchangeRate))
    if (childResource === 'salOrderItems') derived.shippedQty = '0'
    if (childResource === 'purOrderItems') derived.receivedQty = '0'
    derived.remainingBaseQty = derived.baseQty
    Object.assign(derived, await currencySnapshot(ctx, head.currencyId))
    derived.orderDate = head.orderDate
    derived.orderStatus = head.status
    if (childResource === 'purOrderItems') derived.orderIsOutsourced = head.isOutsourced
  }
  if (childResource === 'purOrderItemMaterials') {
    derived.orderNo = head.orderNo
    derived.orderStatus = head.status
    derived.orderIsOutsourced = head.isOutsourced
    derived.issuedQty = '0'
    derived.remainingIssueQty = input.quantity
  }
  return derived
}

function permission(actor: Actor, head: string, action: string): void {
  requirePermission(actor, `${catalogDocument(head).permissionPrefix}:${action}`)
}

async function loadFlat(ctx: QueryCtx | MutationCtx, resource: string, parentId: string) {
  return sorted(await childrenFor(ctx, resource, parentId))
}

async function loadAggregate(
  ctx: QueryCtx | MutationCtx,
  actor: Actor,
  headResource: HeadResource,
  id: string,
): Promise<DraftRecord> {
  const head = await getDomainRecord(ctx, actor, headResource, id)
  if (!head) throw synieError('not_found', `${catalogDocument(headResource).label}不存在`)
  if (headResource.endsWith('Quotations')) {
    const itemResource = headResource.startsWith('sal') ? 'salQuotationItems' : 'purQuotationItems'
    const tierResource = headResource.startsWith('sal') ? 'salQuotationTiers' : 'purQuotationTiers'
    const items = await loadFlat(ctx, itemResource, id)
    return {
      ...head,
      items: await Promise.all(items.map(async (item) => ({
        ...item,
        tiers: await loadFlat(ctx, tierResource, String(item.id)),
      }))),
    }
  }
  if (headResource.endsWith('Orders')) {
    const sales = headResource.startsWith('sal')
    const itemResource = sales ? 'salOrderItems' : 'purOrderItems'
    const items = await loadFlat(ctx, itemResource, id)
    return {
      ...head,
      items: await Promise.all(items.map(async (item) => ({
        ...item,
        issueLines: sales ? [] : await loadFlat(ctx, 'purOrderItemMaterials', String(item.id)),
        byproductLines: sales ? [] : await loadFlat(ctx, 'purOrderItemByproducts', String(item.id)),
      }))),
    }
  }
  if (headResource === 'salDeliveries') {
    const boxes = await loadFlat(ctx, 'salDeliveryPackBoxes', id)
    return {
      ...head,
      items: await loadFlat(ctx, 'salDeliveryItems', id),
      packBoxes: await Promise.all(boxes.map(async (box) => ({
        ...box,
        lines: await loadFlat(ctx, 'salDeliveryPackLines', String(box.id)),
      }))),
    }
  }
  return { ...head, items: await loadFlat(ctx, 'purReceiptItems', id) }
}

type UpsertResult = { saved: DraftRecord[]; missing: DraftRecord[] }

async function upsertChildren(
  ctx: MutationCtx,
  actor: Actor,
  headResource: HeadResource,
  childResource: string,
  parentField: string,
  parentId: string,
  companyId: unknown,
  inputs: DraftRecord[],
  derive: (input: DraftRecord, index: number) => DraftRecord | Promise<DraftRecord> = async () => ({}),
): Promise<UpsertResult> {
  const existing = await childrenFor(ctx, childResource, parentId)
  const byId = new Map(existing.map((row) => [String(row.id), row]))
  const seen = new Set<string>()
  const saved: DraftRecord[] = []
  const hasNew = inputs.some((item) => typeof item.id !== 'string')
  const hasExisting = inputs.some((item) => typeof item.id === 'string')
  if (hasNew) permission(actor, headResource, 'create')
  if (hasExisting) permission(actor, headResource, 'update')
  for (const [index, input] of inputs.entries()) {
    const id = typeof input.id === 'string' ? input.id : null
    if (id && (seen.has(id) || !byId.has(id))) {
      throw synieError('validation', `${childResource} 子记录不属于当前聚合或重复`)
    }
    if (id) seen.add(id)
    const trustedDerived = declaredDerived(childResource, {
      ...(await derive(input, index)),
      [parentField]: parentId,
      companyId,
    })
    const clean = without(input, ['id', 'tiers', 'issueLines', 'byproductLines', 'lines'])
    saved.push(id
      ? await updateDomainRecord(ctx, actor, childResource, id, clean, { permissionChecked: true, trustedDerived })
      : await createDomainRecord(ctx, actor, childResource, clean, { permissionChecked: true, trustedDerived }))
  }
  const missing = existing.filter((row) => !seen.has(String(row.id)))
  if (missing.length) permission(actor, headResource, 'delete')
  return { saved, missing }
}

async function deleteRows(ctx: MutationCtx, actor: Actor, resource: string, rows: DraftRecord[]): Promise<void> {
  for (const row of rows) await removeDomainRecord(ctx, actor, resource, String(row.id), { permissionChecked: true })
}

async function saveQuotationChildren(
  ctx: MutationCtx,
  actor: Actor,
  headResource: 'salQuotations' | 'purQuotations',
  head: DraftRecord,
  inputs: DraftRecord[],
) {
  const sales = headResource === 'salQuotations'
  const itemResource = sales ? 'salQuotationItems' : 'purQuotationItems'
  const tierResource = sales ? 'salQuotationTiers' : 'purQuotationTiers'
  const top = await upsertChildren(ctx, actor, headResource, itemResource, 'quotationId', String(head.id), head.companyId, inputs,
    (item) => enrichItem(ctx, head, itemResource, item))
  for (const [index, item] of top.saved.entries()) {
    const tiers = array(inputs[index]!, 'tiers', `items[${index}].tiers`)
    if (String(inputs[index]!.pricingMode) === 'QTY_TIERED' && tiers.length === 0) {
      throw synieError('validation', '梯度定价条目至少需要一个价格档')
    }
    const nested = await upsertChildren(ctx, actor, headResource, tierResource, 'itemId', String(item.id), head.companyId, tiers)
    await deleteRows(ctx, actor, tierResource, nested.missing)
  }
  for (const item of top.missing) {
    await deleteRows(ctx, actor, tierResource, await childrenFor(ctx, tierResource, String(item.id)))
  }
  await deleteRows(ctx, actor, itemResource, top.missing)
}

async function saveOrderChildren(
  ctx: MutationCtx,
  actor: Actor,
  headResource: 'salOrders' | 'purOrders',
  head: DraftRecord,
  inputs: DraftRecord[],
) {
  const sales = headResource === 'salOrders'
  const itemResource = sales ? 'salOrderItems' : 'purOrderItems'
  const top = await upsertChildren(ctx, actor, headResource, itemResource, 'orderId', String(head.id), head.companyId, inputs,
    (item) => enrichItem(ctx, head, itemResource, item))
  if (!sales) {
    for (const [index, item] of top.saved.entries()) {
      const issue = array(inputs[index]!, 'issueLines', `items[${index}].issueLines`)
      const byproducts = array(inputs[index]!, 'byproductLines', `items[${index}].byproductLines`)
      const issueResult = await upsertChildren(ctx, actor, headResource, 'purOrderItemMaterials', 'orderItemId', String(item.id), head.companyId, issue,
        (line) => enrichItem(ctx, head, 'purOrderItemMaterials', line))
      const byproductResult = await upsertChildren(ctx, actor, headResource, 'purOrderItemByproducts', 'orderItemId', String(item.id), head.companyId, byproducts,
        (line) => enrichItem(ctx, head, 'purOrderItemByproducts', line))
      await deleteRows(ctx, actor, 'purOrderItemMaterials', issueResult.missing)
      await deleteRows(ctx, actor, 'purOrderItemByproducts', byproductResult.missing)
    }
    for (const item of top.missing) {
      await deleteRows(ctx, actor, 'purOrderItemMaterials', await childrenFor(ctx, 'purOrderItemMaterials', String(item.id)))
      await deleteRows(ctx, actor, 'purOrderItemByproducts', await childrenFor(ctx, 'purOrderItemByproducts', String(item.id)))
    }
    for (const item of top.saved) {
      if (typeof item.demandLineId === 'string') {
        await upsertPurchaseArrangement(ctx, actor, {
          demandItemId: item.demandLineId,
          companyId: String(head.companyId),
          purchaseOrderItemId: String(item.id),
          outsourced: head.isOutsourced === true,
          qty: String(item.qty),
          baseQty: String(item.baseQty),
        })
      } else {
        await removePurchaseArrangement(ctx, actor, String(item.id))
      }
    }
    for (const item of top.missing) await removePurchaseArrangement(ctx, actor, String(item.id))
  }
  await deleteRows(ctx, actor, itemResource, top.missing)
}

async function saveDeliveryChildren(
  ctx: MutationCtx,
  actor: Actor,
  head: DraftRecord,
  input: DraftRecord,
) {
  const items = array(input, 'items')
  const itemResult = await upsertChildren(ctx, actor, 'salDeliveries', 'salDeliveryItems', 'deliveryId', String(head.id), head.companyId, items,
    (item) => enrichItem(ctx, head, 'salDeliveryItems', item))
  await deleteRows(ctx, actor, 'salDeliveryItems', itemResult.missing)

  const boxes = array(input, 'packBoxes')
  const boxResult = await upsertChildren(ctx, actor, 'salDeliveries', 'salDeliveryPackBoxes', 'deliveryId', String(head.id), head.companyId, boxes,
    (_box, index) => ({ boxNo: `${index + 1}` }))
  for (const [index, box] of boxResult.saved.entries()) {
    const lines = array(boxes[index]!, 'lines', `packBoxes[${index}].lines`)
    const lineResult = await upsertChildren(ctx, actor, 'salDeliveries', 'salDeliveryPackLines', 'packBoxId', String(box.id), head.companyId, lines,
      async (line) => ({ ...(await enrichItem(ctx, head, 'salDeliveryPackLines', line)), deliveryId: head.id }))
    await deleteRows(ctx, actor, 'salDeliveryPackLines', lineResult.missing)
  }
  for (const box of boxResult.missing) {
    await deleteRows(ctx, actor, 'salDeliveryPackLines', await childrenFor(ctx, 'salDeliveryPackLines', String(box.id)))
  }
  await deleteRows(ctx, actor, 'salDeliveryPackBoxes', boxResult.missing)
}

async function saveReceiptChildren(
  ctx: MutationCtx,
  actor: Actor,
  head: DraftRecord,
  input: DraftRecord,
) {
  const items = array(input, 'items')
  const result = await upsertChildren(ctx, actor, 'purReceipts', 'purReceiptItems', 'receiptId', String(head.id), head.companyId, items,
    (item) => enrichItem(ctx, head, 'purReceiptItems', item))
  await deleteRows(ctx, actor, 'purReceiptItems', result.missing)
}

async function saveChildren(ctx: MutationCtx, actor: Actor, resource: HeadResource, head: DraftRecord, input: DraftRecord) {
  if (resource === 'salQuotations' || resource === 'purQuotations') {
    return saveQuotationChildren(ctx, actor, resource, head, array(input, 'items'))
  }
  if (resource === 'salOrders' || resource === 'purOrders') {
    return saveOrderChildren(ctx, actor, resource, head, array(input, 'items'))
  }
  if (resource === 'salDeliveries') return saveDeliveryChildren(ctx, actor, head, input)
  return saveReceiptChildren(ctx, actor, head, input)
}

export const loadDraft = authedQuery({
  args: { resource: v.string(), id: v.string() },
  returns: v.any(),
  handler: (ctx, args) => loadAggregate(ctx, ctx.actor, headResource(args.resource), args.id),
})

export async function createTradingDraftInMutation(
  ctx: MutationCtx,
  actor: Actor,
  resourceName: string,
  rawInput: unknown,
): Promise<DraftRecord> {
  const resource = headResource(resourceName)
  const input = object(rawInput, '根对象')
  // Validate the complete aggregate shape before the first write.
  array(input, 'items')
  if (resource === 'salDeliveries') array(input, 'packBoxes')
  const head = await createDomainRecord(
    ctx,
    actor,
    resource,
    without(input, ['items', 'packBoxes']),
    { allowAggregateHead: true },
  )
  await saveChildren(ctx, actor, resource, head, input)
  return loadAggregate(ctx, actor, resource, String(head.id))
}

export const createDraft = authedMutation({
  args: { resource: v.string(), input: v.any() },
  returns: v.any(),
  handler: (ctx, args) => createTradingDraftInMutation(ctx, ctx.actor, args.resource, args.input),
})

export const replaceDraft = authedMutation({
  args: { resource: v.string(), id: v.string(), input: v.any() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const resource = headResource(args.resource)
    const input = object(args.input, '根对象')
    array(input, 'items')
    if (resource === 'salDeliveries') array(input, 'packBoxes')
    const head = await updateDomainRecord(ctx, ctx.actor, resource, args.id, without(input, ['items', 'packBoxes']), { allowAggregateHead: true })
    await saveChildren(ctx, ctx.actor, resource, head, input)
    return loadAggregate(ctx, ctx.actor, resource, args.id)
  },
})

async function deleteNested(ctx: MutationCtx, actor: Actor, resource: HeadResource, id: string) {
  if (resource.endsWith('Quotations')) {
    const itemResource = resource.startsWith('sal') ? 'salQuotationItems' : 'purQuotationItems'
    const tierResource = resource.startsWith('sal') ? 'salQuotationTiers' : 'purQuotationTiers'
    const items = await childrenFor(ctx, itemResource, id)
    for (const item of items) await deleteRows(ctx, actor, tierResource, await childrenFor(ctx, tierResource, String(item.id)))
    await deleteRows(ctx, actor, itemResource, items)
  } else if (resource.endsWith('Orders')) {
    const itemResource = resource.startsWith('sal') ? 'salOrderItems' : 'purOrderItems'
    const items = await childrenFor(ctx, itemResource, id)
    if (resource === 'purOrders') {
      for (const item of items) {
        await deleteRows(ctx, actor, 'purOrderItemMaterials', await childrenFor(ctx, 'purOrderItemMaterials', String(item.id)))
        await deleteRows(ctx, actor, 'purOrderItemByproducts', await childrenFor(ctx, 'purOrderItemByproducts', String(item.id)))
      }
    }
    await deleteRows(ctx, actor, itemResource, items)
  } else if (resource === 'salDeliveries') {
    await deleteRows(ctx, actor, 'salDeliveryItems', await childrenFor(ctx, 'salDeliveryItems', id))
    const boxes = await childrenFor(ctx, 'salDeliveryPackBoxes', id)
    for (const box of boxes) await deleteRows(ctx, actor, 'salDeliveryPackLines', await childrenFor(ctx, 'salDeliveryPackLines', String(box.id)))
    await deleteRows(ctx, actor, 'salDeliveryPackBoxes', boxes)
  } else {
    await deleteRows(ctx, actor, 'purReceiptItems', await childrenFor(ctx, 'purReceiptItems', id))
  }
}

export const removeDraft = authedMutation({
  args: { resource: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const resource = headResource(args.resource)
    permission(ctx.actor, resource, 'delete')
    await deleteNested(ctx, ctx.actor, resource, args.id)
    await removeDomainRecord(ctx, ctx.actor, resource, args.id, { permissionChecked: true })
    return null
  },
})
