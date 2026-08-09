/**
 * 销售退货领域钩子：条目快照派生（来源=发货条目）、头校验、审核装载。
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
  upperStatus,
} from '../common.ts'
import {
  RETURN_HEAD_LABEL,
  RETURN_HEAD_TABLE,
  RETURN_ITEM_LABEL,
  RETURN_ITEM_TABLE,
  RETURN_REQUIRED_ROLE,
} from './spec.ts'
import type { ReturnHead } from './types.ts'

export const ITEM_ALIAS = 'return_items'
export const ITEM_SELECT = sql`SELECT *`

/** beforeWrite 派生列（快照随发货条目带入） */
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
  'orderItemId',
  'materialId',
] as const

export const RETURN_WRITE_ERRORS = [
  { code: '23505', message: '单号已存在' },
] as const

export const ITEM_SOURCE: RawBuilder<unknown> = sql` FROM (
  SELECT i.*, h.return_no, h.return_date,
    h.status AS return_status, h.party_type, h.party_id,
    (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty
  FROM ${ident(RETURN_ITEM_TABLE)} i
  JOIN ${ident(RETURN_HEAD_TABLE)} h ON h.id=i.return_id
) ${sql.raw(ITEM_ALIAS)}`

export function validateHeadWire(
  draft: Record<string, unknown>,
  opts: { requireReturnNo: boolean; requireDate: boolean },
): void {
  const fields: Record<string, string[]> = {}
  if (opts.requireReturnNo) {
    const no = String(draft.returnNo ?? '').trim()
    if (!no || runeLen(no) > 32) fields.returnNo = ['不能为空且最多 32 个字符']
  }
  if (opts.requireDate && !draft.returnDate) fields.returnDate = ['必填']
  const partyType = draft.partyType != null ? lowerParty(String(draft.partyType)) : ''
  if (partyType !== 'customer' && partyType !== 'company') {
    fields.partyType = ['对手类型不合法']
  }
  if (!draft.partyId) fields.partyId = ['必填']
  if (draft.companyId !== undefined && !draft.companyId) fields.companyId = ['必填']
  if (partyType === 'company' && draft.partyId && draft.companyId && draft.partyId === draft.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!draft.debitAccountId) fields.debitAccountId = ['必填']
  if (!draft.creditAccountId) fields.creditAccountId = ['必填']
  if (
    draft.exchangeRate != null &&
    draft.exchangeRate !== '' &&
    !decimal(String(draft.exchangeRate)).gt(0)
  ) {
    fields.exchangeRate = ['必须大于 0']
  }
  if (draft.remarks != null && runeLen(String(draft.remarks)) > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${RETURN_HEAD_LABEL}参数不合法`, fields)
  }
}

export function validateHeadShape(item: ReturnHead) {
  const fields: Record<string, string[]> = {}
  if (!item.no.trim() || runeLen(item.no) > 32) fields.number = ['不能为空且最多 32 个字符']
  if (!item.documentDate) fields.documentDate = ['必填']
  const partyType = lowerParty(item.partyType)
  if (partyType !== 'customer' && partyType !== 'company') fields.partyType = ['对手类型不合法']
  if (!item.partyId) fields.partyId = ['必填']
  if (!item.companyId) fields.companyId = ['必填']
  if (partyType === 'company' && item.partyId === item.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!item.debitAccountId) fields.debitAccountId = ['必填']
  if (!item.creditAccountId) fields.creditAccountId = ['必填']
  if (item.remarks && runeLen(item.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${RETURN_HEAD_LABEL}参数不合法`, fields)
  }
}

export async function validateHeadRefs(db: DbHandle, item: ReturnHead) {
  if (!(await partyExists(db, item.partyType, item.partyId))) {
    throw ApiError.validation(`${RETURN_HEAD_LABEL}参数不合法`, { partyId: ['对手不存在'] })
  }
  if (item.warehouseId) {
    await validateEnabledLeafWarehouse(db, item.companyId, item.warehouseId, '退货仓库不合法')
  }
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
      throw ApiError.validation(`${RETURN_HEAD_LABEL}参数不合法`, {
        [field]: ['科目须属于单据公司、启用且非汇总'],
      })
    }
    if (field === 'creditAccountId' && (!acc.role || acc.role.toLowerCase() !== RETURN_REQUIRED_ROLE)) {
      throw ApiError.validation(`${RETURN_HEAD_LABEL}参数不合法`, {
        [field]: ['科目角色须为未开票应收'],
      })
    }
  }
}

export async function loadHead(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM ${ident(RETURN_HEAD_TABLE)} WHERE id=${id}::uuid
  `.execute(db)
  return rows.rows[0]
}

export interface ActionItem {
  id: string
  deliveryItemId: string
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

export async function loadActionItems(db: DbHandle, headId: string): Promise<ActionItem[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT i.id, i.delivery_item_id, i.order_item_id, i.base_qty, i.material_id, i.warehouse_id,
      i.material_code, i.material_name, i.order_base_qty, i.order_base_amount, i.reconciled_qty,
      m.material_type
    FROM ${ident(RETURN_ITEM_TABLE)} i
    JOIN inv_material m ON m.id=i.material_id
    WHERE i.return_id=${headId}::uuid
    ORDER BY i.idx, i.id
    FOR UPDATE OF i
  `.execute(db)
  return rows.rows.map((r) => ({
    id: String(r.id),
    deliveryItemId: String(r.delivery_item_id),
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

/**
 * 源单行派生：从发货条目带物料快照与订单快照（复用发货条目快照列）。
 * 保存时不硬卡剩余可退（审核硬校验）；发货单须已审核未作废、同公司同对手；
 * 单头原币已填时须与订单快照币种一致。
 */
export async function deriveItem(
  db: DbHandle,
  parent: { companyId: string; partyType: string; partyId: string; currencyId: string | null },
  draft: {
    idx: number
    qty: ReturnType<typeof decimal>
    deliveryItemId: string
    unitId: string | null
    warehouseId: string | null
    remarks: string | null
  },
) {
  if (!draft.qty.gt(0)) {
    throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, { qty: ['必须大于 0'] })
  }
  if (draft.remarks && runeLen(draft.remarks) > 512) {
    throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, { remarks: ['最多 512 个字符'] })
  }
  const rows = await sql<Record<string, unknown>>`
    SELECT i.*, h.status AS delivery_status, h.company_id AS delivery_company_id,
      h.party_type AS delivery_party_type, h.party_id AS delivery_party_id
    FROM sal_delivery_item i
    JOIN sal_delivery h ON h.id=i.delivery_id
    WHERE i.id=${draft.deliveryItemId}::uuid
    FOR UPDATE OF h, i
  `.execute(db)
  const source = rows.rows[0]
  if (!source) {
    throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, { deliveryItemId: ['发货条目不存在'] })
  }
  if (String(source.delivery_status).toLowerCase() !== 'audited') {
    throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
      deliveryItemId: ['发货单须已审核未作废'],
    })
  }
  if (String(source.delivery_company_id) !== parent.companyId) {
    throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
      deliveryItemId: ['发货单公司不一致'],
    })
  }
  if (
    lowerParty(String(source.delivery_party_type)) !== lowerParty(parent.partyType) ||
    String(source.delivery_party_id) !== parent.partyId
  ) {
    throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
      deliveryItemId: ['发货单对手不一致'],
    })
  }
  if (parent.currencyId) {
    const cur = await db
      .selectFrom('bas_currency')
      .select('iso_code')
      .where('id', '=', parent.currencyId)
      .executeTakeFirst()
    if (!cur) {
      throw ApiError.validation(`${RETURN_HEAD_LABEL}参数不合法`, { currencyId: ['币种不存在'] })
    }
    if (String(cur.iso_code) !== String(source.order_currency_code)) {
      throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
        deliveryItemId: ['发货条目原币与单头原币不一致'],
      })
    }
  }
  const unitId = draft.unitId ?? String(source.unit_id)
  const snap = await loadMaterialSnap(db, String(source.material_id), unitId)
  guardMaterialType(snap, ['STOCK', 'VIRTUAL'], RETURN_ITEM_LABEL)
  if (!draft.warehouseId) {
    if (snap.materialType === 'STOCK') {
      throw ApiError.validation(`${RETURN_ITEM_LABEL}参数不合法`, {
        warehouseId: ['库存类物料必须填写行仓'],
      })
    }
  } else {
    await validateEnabledLeafWarehouse(db, parent.companyId, draft.warehouseId, '退货仓库不合法')
  }
  const baseQty = convertToBaseQty(draft.qty, unitId, snap)
  return {
    idx: draft.idx,
    qty: draft.qty,
    baseQty,
    deliveryItemId: draft.deliveryItemId,
    orderItemId: String(source.order_item_id),
    materialId: String(source.material_id),
    unitId,
    warehouseId: draft.warehouseId,
    materialCode: String(source.material_code),
    materialName: String(source.material_name),
    materialSpec: asOptionalString(source.material_spec),
    customerPartNo: asOptionalString(source.customer_part_no),
    unitName: snap.unitName,
    orderNo: String(source.order_no),
    orderQty: String(source.order_qty),
    orderBaseQty: String(source.order_base_qty),
    orderUnitName: String(source.order_unit_name),
    orderPrice: String(source.order_price),
    orderAmount: String(source.order_amount),
    orderBasePrice: String(source.order_base_price),
    orderBaseAmount: String(source.order_base_amount),
    orderTaxRate: String(source.order_tax_rate),
    orderCurrencyCode: String(source.order_currency_code),
    remarks: draft.remarks,
  }
}

export function mapHead(row: Record<string, unknown>): ReturnHead {
  return {
    id: String(row.id),
    no: String(row.return_no ?? row.number ?? ''),
    documentDate: asDate(row.return_date ?? row.document_date),
    postingDate: row.posting_date ? asDate(row.posting_date) : null,
    partyType: String(row.party_type),
    partyId: String(row.party_id),
    currencyId: row.currency_id ? String(row.currency_id) : null,
    exchangeRate: row.exchange_rate != null ? String(row.exchange_rate) : null,
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

export function headSnap(item: ReturnHead): Record<string, unknown> {
  return {
    number: item.no,
    document_date: item.documentDate,
    posting_date: item.postingDate,
    party_type: item.partyType,
    party_id: item.partyId,
    currency_id: item.currencyId,
    exchange_rate: item.exchangeRate,
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

export function headLikeFromDraft(
  draft: Record<string, unknown>,
  before: Record<string, unknown> | undefined,
): ReturnHead {
  return {
    id: String(before?.id ?? ''),
    no: String(draft.returnNo ?? before?.returnNo ?? 'x'),
    documentDate: String(draft.returnDate ?? before?.returnDate ?? ''),
    postingDate:
      draft.postingDate === undefined
        ? ((before?.postingDate as string | null | undefined) ?? null)
        : (draft.postingDate as string | null),
    partyType: String(draft.partyType ?? before?.partyType ?? ''),
    partyId: String(draft.partyId ?? before?.partyId ?? ''),
    currencyId:
      draft.currencyId === undefined
        ? ((before?.currencyId as string | null | undefined) ?? null)
        : (draft.currencyId as string | null),
    exchangeRate:
      draft.exchangeRate === undefined
        ? ((before?.exchangeRate as string | null | undefined) ?? null)
        : (draft.exchangeRate as string | null),
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
