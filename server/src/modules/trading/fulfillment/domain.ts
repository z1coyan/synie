/**
 * 履约领域钩子：条目快照派生、头校验、装箱相等、审核装载。
 * 聚合草稿只管持久化；本 module 供标准钩子与审核 effect 复用。
 */
import { decimal } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { validateEnabledLeafWarehouse } from '~/platform/posting/warehouse.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  convertToBaseQty,
  guardMaterialType,
  ident,
  loadMaterialSnap,
  lowerParty,
  partyExists,
  runeLen,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import { fulfillmentSpec, type FulfillmentSideSpec } from './spec.ts'
import type { FulfillmentHead } from './types.ts'

export const ITEM_ALIAS = 'fulfillment_items'
export const ITEM_SELECT = sql`SELECT *`

export const ITEM_DERIVED = [
  'baseQty',
  'materialCode',
  'materialName',
  'materialSpec',
  'customerPartNo',
  'unitName',
  'orderNo',
  'orderQty',
  'orderBaseQty',
  'orderUnitName',
  'orderPrice',
  'orderAmount',
  'orderBasePrice',
  'orderBaseAmount',
  'orderTaxRate',
  'orderCurrencyCode',
] as const

export const PACK_LINE_DERIVED = [
  'baseQty',
  'materialCode',
  'materialName',
  'materialSpec',
  'customerPartNo',
  'unitName',
] as const

export const FULFILLMENT_WRITE_ERRORS = [
  { code: '23505', message: '单号已存在' },
] as const

function buildItemSource(side: TradingSide): RawBuilder<unknown> {
  const spec = fulfillmentSpec(side)
  const statusCol = side === 'sales' ? 'delivery_status' : 'receipt_status'
  const orderTypeSql =
    side === 'sales'
      ? `(SELECT o.order_type FROM sal_order_item oi
          JOIN sal_order o ON o.id=oi.order_id WHERE oi.id=i.order_item_id) AS order_type`
      : `NULL::text AS order_type`
  return sql` FROM (
    SELECT i.*, h.${sql.raw(spec.numberCol)}, h.${sql.raw(spec.dateCol)},
      h.status AS ${sql.raw(statusCol)}, h.party_type, h.party_id,
      (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty,
      ${sql.raw(orderTypeSql)}
    FROM ${ident(spec.itemTable)} i
    JOIN ${ident(spec.headTable)} h ON h.id=i.${sql.raw(spec.parentCol)}
  ) ${sql.raw(ITEM_ALIAS)}`
}

export const ITEM_SOURCE: Record<TradingSide, RawBuilder<unknown>> = {
  sales: buildItemSource('sales'),
  purchase: buildItemSource('purchase'),
}

export function validateSalesHeadWire(
  draft: Record<string, unknown>,
  opts: { requireDeliveryNo: boolean; requireDate: boolean },
): void {
  const fields: Record<string, string[]> = {}
  const label = fulfillmentSpec('sales').label
  if (opts.requireDeliveryNo) {
    const no = String(draft.deliveryNo ?? '').trim()
    if (!no || runeLen(no) > 32) fields.deliveryNo = ['不能为空且最多 32 个字符']
  }
  if (opts.requireDate && !draft.deliveryDate) fields.deliveryDate = ['必填']
  const partyType = draft.partyType != null ? lowerParty(String(draft.partyType)) : ''
  if (!fulfillmentSpec('sales').allowedParty.has(partyType)) {
    fields.partyType = ['对手类型不合法']
  }
  if (!draft.partyId) fields.partyId = ['必填']
  if (draft.companyId !== undefined && !draft.companyId) fields.companyId = ['必填']
  if (partyType === 'company' && draft.partyId && draft.companyId && draft.partyId === draft.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!draft.debitAccountId) fields.debitAccountId = ['必填']
  if (!draft.creditAccountId) fields.creditAccountId = ['必填']
  if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${label}参数不合法`, fields)
  }
}

export function validatePurchaseHeadWire(
  draft: Record<string, unknown>,
  opts: { requireReceiptNo: boolean; requireDate: boolean },
): void {
  const fields: Record<string, string[]> = {}
  const label = fulfillmentSpec('purchase').label
  if (opts.requireReceiptNo) {
    const no = String(draft.receiptNo ?? '').trim()
    if (!no || runeLen(no) > 32) fields.receiptNo = ['不能为空且最多 32 个字符']
  }
  if (opts.requireDate && !draft.receiptDate) fields.receiptDate = ['必填']
  const partyType = draft.partyType != null ? lowerParty(String(draft.partyType)) : ''
  if (!fulfillmentSpec('purchase').allowedParty.has(partyType)) {
    fields.partyType = ['对手类型不合法']
  }
  if (!draft.partyId) fields.partyId = ['必填']
  if (draft.companyId !== undefined && !draft.companyId) fields.companyId = ['必填']
  if (partyType === 'company' && draft.partyId && draft.companyId && draft.partyId === draft.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!draft.debitAccountId) fields.debitAccountId = ['必填']
  if (!draft.creditAccountId) fields.creditAccountId = ['必填']
  if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${label}参数不合法`, fields)
  }
}

export function validateHeadShape(spec: FulfillmentSideSpec, item: FulfillmentHead) {
  const fields: Record<string, string[]> = {}
  if (!item.no.trim() || runeLen(item.no) > 32) fields.number = ['不能为空且最多 32 个字符']
  if (!item.documentDate) fields.documentDate = ['必填']
  if (!spec.allowedParty.has(lowerParty(item.partyType))) fields.partyType = ['对手类型不合法']
  if (!item.partyId) fields.partyId = ['必填']
  if (!item.companyId) fields.companyId = ['必填']
  if (lowerParty(item.partyType) === 'company' && item.partyId === item.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!item.debitAccountId) fields.debitAccountId = ['必填']
  if (!item.creditAccountId) fields.creditAccountId = ['必填']
  if (item.remarks && runeLen(item.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

export async function validateHeadRefs(
  db: DbHandle,
  spec: FulfillmentSideSpec,
  item: FulfillmentHead,
) {
  if (!(await partyExists(db, item.partyType, item.partyId))) {
    throw ApiError.validation(`${spec.label}参数不合法`, { partyId: ['对手不存在'] })
  }
  if (item.warehouseId) await validateWarehouse(db, item.companyId, item.warehouseId)
  for (const [field, accountId] of [
    ['debitAccountId', item.debitAccountId],
    ['creditAccountId', item.creditAccountId],
  ] as const) {
    const acc = await db
      .selectFrom('bas_account')
      .select(['company_id', 'is_group', 'active', 'role'])
      .where('id', '=', accountId)
      .executeTakeFirst()
    if (!acc || acc.company_id !== item.companyId || acc.is_group || !acc.active) {
      throw ApiError.validation(`${spec.label}参数不合法`, {
        [field]: ['科目须属于单据公司、启用且非汇总'],
      })
    }
    if (
      field === `${spec.requiredRoleSide}AccountId` &&
      (!acc.role || acc.role.toLowerCase() !== spec.requiredRole)
    ) {
      throw ApiError.validation(`${spec.label}参数不合法`, {
        [field]: ['科目角色不符合履约要求'],
      })
    }
  }
}

export async function validateWarehouse(db: DbHandle, companyId: string, warehouseId: string) {
  await validateEnabledLeafWarehouse(db, companyId, warehouseId, '履约仓库不合法')
}

export async function assertDeliveryDraft(db: DbHandle, deliveryId: string): Promise<void> {
  const rows = await sql<{ status: string }>`
    SELECT status FROM sal_delivery WHERE id=${deliveryId}::uuid
  `.execute(db)
  if (!rows.rows[0]) throw new ApiError('not_found', '销售发货单不存在')
  if (String(rows.rows[0].status).toLowerCase() !== 'draft') {
    throw new ApiError('conflict', '仅草稿销售发货单可编辑')
  }
}

export async function loadHead(db: DbHandle, spec: FulfillmentSideSpec, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM ${ident(spec.headTable)} WHERE id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

export interface ActionItem {
  id: string
  orderItemId: string
  baseQty: string
  materialId: string
  warehouseId: string | null
  materialType: string
  materialCode: string
  materialName: string
  orderBaseQty: string
  orderBaseAmount: string
  reconciledQty: string
}

export async function loadActionItems(
  db: DbHandle,
  spec: FulfillmentSideSpec,
  headId: string,
): Promise<ActionItem[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT i.id, i.order_item_id, i.base_qty, i.material_id, i.warehouse_id, i.material_code,
      i.material_name, i.order_base_qty, i.order_base_amount, i.reconciled_qty,
      m.material_type
    FROM ${ident(spec.itemTable)} i
    JOIN inv_material m ON m.id=i.material_id
    WHERE i.${sql.raw(spec.parentCol)}=${headId}::uuid
    ORDER BY i.idx, i.id
    FOR UPDATE OF i
  `.execute(db)
  return rows.rows.map((r) => ({
    id: String(r.id),
    orderItemId: String(r.order_item_id),
    baseQty: String(r.base_qty),
    materialId: String(r.material_id),
    warehouseId: r.warehouse_id ? String(r.warehouse_id) : null,
    materialType: String(r.material_type),
    materialCode: String(r.material_code),
    materialName: String(r.material_name),
    orderBaseQty: String(r.order_base_qty),
    orderBaseAmount: String(r.order_base_amount),
    reconciledQty: String(r.reconciled_qty ?? 0),
  }))
}

export async function deriveItem(
  db: DbHandle,
  spec: FulfillmentSideSpec,
  parent: { companyId: string; partyType: string; partyId: string },
  draft: {
    idx: number
    qty: ReturnType<typeof decimal>
    orderItemId: string
    unitId: string | null
    warehouseId: string | null
    remarks: string | null
  },
) {
  if (!draft.qty.gt(0)) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { qty: ['必须大于 0'] })
  }
  if (draft.remarks && runeLen(draft.remarks) > 512) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { remarks: ['最多 512 个字符'] })
  }
  const oi = await sql<Record<string, unknown>>`
    SELECT oi.*, o.order_no, o.status, o.company_id, o.party_type, o.party_id, o.currency_id,
      cur.iso_code AS currency_code
    FROM ${ident(spec.orderItemTable)} oi
    JOIN ${ident(spec.orderTable)} o ON o.id=oi.order_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    WHERE oi.id=${draft.orderItemId}::uuid
    FOR UPDATE OF o, oi
  `.execute(db)
  const orderItem = oi.rows[0]
  if (!orderItem) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { orderItemId: ['订单条目不存在'] })
  }
  if (String(orderItem.status).toLowerCase() !== 'audited') {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { orderItemId: ['订单须已审核'] })
  }
  if (String(orderItem.company_id) !== parent.companyId) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { orderItemId: ['订单公司不一致'] })
  }
  if (
    String(orderItem.party_type) !== lowerParty(parent.partyType) ||
    String(orderItem.party_id) !== parent.partyId
  ) {
    throw ApiError.validation(`${spec.itemLabel}参数不合法`, { orderItemId: ['订单对手不一致'] })
  }
  const unitId = draft.unitId ?? String(orderItem.unit_id)
  const snap = await loadMaterialSnap(db, String(orderItem.material_id), unitId)
  if (spec.side === 'sales') {
    guardMaterialType(snap, ['STOCK', 'VIRTUAL'], spec.itemLabel)
  }
  if (!draft.warehouseId) {
    if (snap.materialType === 'STOCK') {
      throw ApiError.validation(`${spec.itemLabel}参数不合法`, {
        warehouseId: ['库存类物料必须填写行仓'],
      })
    }
  } else {
    await validateWarehouse(db, parent.companyId, draft.warehouseId)
  }
  const baseQty = convertToBaseQty(draft.qty, unitId, snap)
  return {
    idx: draft.idx,
    qty: draft.qty,
    baseQty,
    materialId: String(orderItem.material_id),
    unitId,
    warehouseId: draft.warehouseId,
    materialCode: String(orderItem.material_code),
    materialName: String(orderItem.material_name),
    materialSpec: asOptionalString(orderItem.material_spec),
    customerPartNo: asOptionalString(orderItem.customer_part_no),
    unitName: snap.unitName,
    orderNo: String(orderItem.order_no),
    orderQty: String(orderItem.qty),
    orderBaseQty: String(orderItem.base_qty),
    orderUnitName: String(orderItem.unit_name),
    orderPrice: String(orderItem.price),
    orderAmount: String(orderItem.amount),
    orderBasePrice: String(orderItem.base_price),
    orderBaseAmount: String(orderItem.base_amount),
    orderTaxRate: String(orderItem.tax_rate),
    orderCurrencyCode: String(orderItem.currency_code),
    remarks: draft.remarks,
    orderItemId: draft.orderItemId,
  }
}

export async function validatePackEquality(db: DbHandle, headId: string, items: ActionItem[]) {
  const rows = await sql<{ material_id: string; code: string; name: string; qty: string }>`
    SELECT material_id, min(material_code) AS code, min(material_name) AS name, sum(base_qty)::text AS qty
    FROM sal_delivery_pack_line WHERE delivery_id=${headId}::uuid
    GROUP BY material_id
  `.execute(db)
  if (rows.rows.length === 0) return
  const packed = new Map(
    rows.rows.map((r) => [r.material_id, { label: `${r.code} ${r.name}`, qty: decimal(r.qty) }]),
  )
  const shipped = new Map<string, { label: string; qty: ReturnType<typeof decimal> }>()
  for (const item of items) {
    if (item.materialType !== 'STOCK') continue
    const cur =
      shipped.get(item.materialId) ?? {
        label: `${item.materialCode} ${item.materialName}`,
        qty: decimal(0),
      }
    cur.qty = cur.qty.add(item.baseQty)
    shipped.set(item.materialId, cur)
  }
  const mismatches: string[] = []
  for (const [mid, pack] of packed) {
    const ship = shipped.get(mid)
    if (!ship) {
      mismatches.push(`${pack.label}: 装箱有而发货无 (装箱 ${pack.qty})`)
    } else if (!pack.qty.equals(ship.qty)) {
      mismatches.push(`${ship.label}: 发货 ${ship.qty} ≠ 装箱 ${pack.qty}`)
    }
  }
  for (const [mid, ship] of shipped) {
    if (!packed.has(mid)) {
      mismatches.push(`${ship.label}: 发货有而装箱无 (发货 ${ship.qty})`)
    }
  }
  if (mismatches.length > 0) {
    throw new ApiError('conflict', `装箱清单与发货量不一致: ${mismatches.join('; ')}`)
  }
}

export function mapHead(row: Record<string, unknown>): FulfillmentHead {
  const no = String(row.delivery_no ?? row.receipt_no ?? row.number ?? '')
  const documentDate = asDate(row.delivery_date ?? row.receipt_date ?? row.document_date)
  return {
    id: String(row.id),
    no,
    documentDate,
    postingDate: row.posting_date ? asDate(row.posting_date) : null,
    partyType: String(row.party_type),
    partyId: String(row.party_id),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    auditedAt: asDateTime(row.audited_at),
    insertedAt: asDateTime(row.inserted_at)!,
    updatedAt: asDateTime(row.updated_at)!,
    companyId: String(row.company_id),
    warehouseId: row.warehouse_id ? String(row.warehouse_id) : null,
    debitAccountId: String(row.debit_account_id),
    creditAccountId: String(row.credit_account_id),
    createdById: row.created_by_id ? String(row.created_by_id) : null,
    auditedById: row.audited_by_id ? String(row.audited_by_id) : null,
  }
}

export function headSnap(item: FulfillmentHead): Record<string, unknown> {
  return {
    number: item.no,
    document_date: item.documentDate,
    posting_date: item.postingDate,
    party_type: item.partyType,
    party_id: item.partyId,
    remarks: item.remarks,
    status: item.status,
    audited_at: item.auditedAt,
    company_id: item.companyId,
    warehouse_id: item.warehouseId,
    debit_account_id: item.debitAccountId,
    credit_account_id: item.creditAccountId,
    created_by_id: item.createdById,
    audited_by_id: item.auditedById,
  }
}

export function applyDerivedItem(
  draft: Record<string, unknown>,
  derived: Awaited<ReturnType<typeof deriveItem>>,
): void {
  draft.idx = derived.idx
  draft.qty = wireRequiredDecimal(derived.qty)
  draft.baseQty = wireRequiredDecimal(derived.baseQty)
  draft.materialId = derived.materialId
  draft.unitId = derived.unitId
  draft.warehouseId = derived.warehouseId
  draft.materialCode = derived.materialCode
  draft.materialName = derived.materialName
  draft.materialSpec = derived.materialSpec
  draft.customerPartNo = derived.customerPartNo
  draft.unitName = derived.unitName
  draft.orderNo = derived.orderNo
  draft.orderQty = wireRequiredDecimal(derived.orderQty)
  draft.orderBaseQty = wireRequiredDecimal(derived.orderBaseQty)
  draft.orderUnitName = derived.orderUnitName
  draft.orderPrice = wireRequiredDecimal(derived.orderPrice)
  draft.orderAmount = wireRequiredDecimal(derived.orderAmount)
  draft.orderBasePrice = wireRequiredDecimal(derived.orderBasePrice)
  draft.orderBaseAmount = wireRequiredDecimal(derived.orderBaseAmount)
  draft.orderTaxRate = wireRequiredDecimal(derived.orderTaxRate)
  draft.orderCurrencyCode = derived.orderCurrencyCode
  draft.remarks = derived.remarks
  draft.orderItemId = derived.orderItemId
}

export function headLikeFromDraft(
  draft: Record<string, unknown>,
  before: Record<string, unknown> | undefined,
  keys: { no: string; date: string },
): FulfillmentHead {
  return {
    id: String(before?.id ?? ''),
    no: String(draft[keys.no] ?? before?.[keys.no] ?? 'x'),
    documentDate: String(draft[keys.date] ?? before?.[keys.date] ?? ''),
    postingDate:
      draft.postingDate === undefined
        ? ((before?.postingDate as string | null | undefined) ?? null)
        : (draft.postingDate as string | null),
    partyType: String(draft.partyType ?? before?.partyType ?? ''),
    partyId: String(draft.partyId ?? before?.partyId ?? ''),
    remarks:
      draft.remarks === undefined
        ? ((before?.remarks as string | null | undefined) ?? null)
        : (draft.remarks as string | null),
    status: 'DRAFT',
    auditedAt: null,
    insertedAt: '',
    updatedAt: '',
    companyId: String(draft.companyId ?? before?.companyId ?? ''),
    warehouseId:
      draft.warehouseId === undefined
        ? ((before?.warehouseId as string | null | undefined) ?? null)
        : (draft.warehouseId as string | null),
    debitAccountId: String(draft.debitAccountId ?? before?.debitAccountId ?? ''),
    creditAccountId: String(draft.creditAccountId ?? before?.creditAccountId ?? ''),
    createdById: null,
    auditedById: null,
  }
}
