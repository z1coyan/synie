/**
 * 委外发料/入库领域：投影源、快照派生、头/行校验、审核装载。
 * 聚合草稿只管持久化；本 module 供标准钩子与 workflow effect 复用。
 */
import { decimal } from '@synie/shared'
import { sql, type RawBuilder } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import {
  validateEnabledLeafWarehouse,
  validateOutsourcedWarehouse,
} from '~/platform/posting/warehouse.ts'
import {
  asDate,
  asDateTime,
  asOptionalString,
  convertToBaseQty,
  guardMaterialType,
  loadMaterialSnap,
  lowerParty,
  partyExists,
  runeLen,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'

export const ISSUE_PREFIX = 'purchase.outsourced_issue'
export const RECEIPT_PREFIX = 'purchase.outsourced_receipt'
export const ISSUE_TABLE = 'pur_outsourced_issue'
export const ISSUE_ITEM_TABLE = 'pur_outsourced_issue_item'
export const RECEIPT_TABLE = 'pur_outsourced_receipt'
export const RECEIPT_ITEM_TABLE = 'pur_outsourced_receipt_item'
export const MATERIAL_TABLE = 'pur_outsourced_receipt_item_material'
export const BYPRODUCT_TABLE = 'pur_outsourced_receipt_item_byproduct'

export const ISSUE_LABEL = '委外发料单'
export const ISSUE_ITEM_LABEL = '委外发料行'
export const RECEIPT_LABEL = '委外入库单'
export const RECEIPT_ITEM_LABEL = '委外入库成品行'
export const MATERIAL_LABEL = '委外入库材料行'
export const BYPRODUCT_LABEL = '委外入库副产物行'

export const ISSUE_ITEM_ALIAS = 'issue_items'
export const ISSUE_ITEM_SOURCE: RawBuilder<unknown> = sql` FROM (
  SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,i.material_spec,
    i.unit_name,i.order_no,i.remarks,i.inserted_at,i.updated_at,i.issue_id,i.company_id,
    i.order_item_material_id,i.material_id,i.unit_id,i.from_warehouse_id,i.outsourced_warehouse_id,
    h.issue_no,h.issue_date,h.status AS issue_status,h.party_type,h.party_id
  FROM pur_outsourced_issue_item i
  JOIN pur_outsourced_issue h ON h.id=i.issue_id
) issue_items`

export const RECEIPT_ITEM_ALIAS = 'receipt_items'
export const RECEIPT_ITEM_SOURCE: RawBuilder<unknown> = sql` FROM (
  SELECT i.id,i.idx,i.qty,i.base_qty,i.material_code,i.material_name,i.material_spec,
    i.customer_part_no,i.unit_name,i.order_no,i.order_qty,i.order_base_qty,i.order_unit_name,
    i.order_price,i.order_amount,i.order_base_price,i.order_base_amount,i.order_tax_rate,
    i.order_currency_code,i.reconciled_qty,i.returned_qty,i.remarks,i.inserted_at,i.updated_at,
    i.receipt_id,i.company_id,i.order_item_id,i.material_id,i.unit_id,i.warehouse_id,
    h.receipt_no,h.receipt_date,h.status AS receipt_status,h.party_type,h.party_id,
    (i.base_qty - i.reconciled_qty) AS remaining_reconcilable_qty,
    (i.base_qty - i.returned_qty) AS remaining_returnable_qty
  FROM pur_outsourced_receipt_item i
  JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
) receipt_items`

export const MATERIAL_ALIAS = 'receipt_materials'
export const MATERIAL_SOURCE: RawBuilder<unknown> = sql` FROM (
  SELECT c.id,c.idx,c.qty,c.base_qty,c.material_code,c.material_name,c.material_spec,
    c.unit_name,c.order_no,c.remarks,c.inserted_at,c.updated_at,c.receipt_item_id,
    c.company_id,c.order_item_material_id,c.material_id,c.unit_id,c.outsourced_warehouse_id,
    h.receipt_no
  FROM pur_outsourced_receipt_item_material c
  JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
  JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
) receipt_materials`

export const BYPRODUCT_ALIAS = 'receipt_byproducts'
export const BYPRODUCT_SOURCE: RawBuilder<unknown> = sql` FROM (
  SELECT c.id,c.idx,c.qty,c.base_qty,c.material_code,c.material_name,c.material_spec,
    c.unit_name,c.order_no,c.remarks,c.inserted_at,c.updated_at,c.receipt_item_id,
    c.company_id,c.order_item_byproduct_id,c.material_id,c.unit_id,c.warehouse_id,
    h.receipt_no
  FROM pur_outsourced_receipt_item_byproduct c
  JOIN pur_outsourced_receipt_item i ON i.id=c.receipt_item_id
  JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
) receipt_byproducts`

export const SELECT_ALL = sql`SELECT *`
export const CHILD_ORDER = sql`"idx" ASC, "id" ASC`
export const HEAD_ORDER = sql`"inserted_at" DESC, "id" DESC`

export const ISSUE_ITEM_DERIVED = [
  'baseQty',
  'materialCode',
  'materialName',
  'materialSpec',
  'unitName',
  'orderNo',
  'materialId',
  'unitId',
] as const

export const RECEIPT_ITEM_DERIVED = [
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
  'materialId',
  'reconciledQty',
] as const

export const CHILD_LINE_DERIVED = [
  'baseQty',
  'materialCode',
  'materialName',
  'materialSpec',
  'unitName',
  'orderNo',
  'materialId',
  'unitId',
] as const

export const WRITE_ERRORS = [
  { code: '23505', message: '单号或记录已存在' },
  { code: '23503', message: '已被业务引用,不可删除' },
] as const

/** 时间字段：标准 mapRow 出 Date；手写 SQL 投影可走 ISO 串 */
type WireTime = Date | string

export type IssueHead = {
  id: string
  issueNo: string
  issueDate: string
  partyType: string
  partyId: string
  remarks: string | null
  status: string
  auditedAt: WireTime | null
  insertedAt: WireTime
  updatedAt: WireTime
  companyId: string
  fromWarehouseId: string | null
  outsourcedWarehouseId: string | null
  createdById: string | null
  auditedById: string | null
  [key: string]: unknown
}

export type ReceiptHead = {
  id: string
  receiptNo: string
  receiptDate: string
  postingDate: string | null
  partyType: string
  partyId: string
  remarks: string | null
  status: string
  auditedAt: WireTime | null
  insertedAt: WireTime
  updatedAt: WireTime
  companyId: string
  warehouseId: string | null
  outsourcedWarehouseId: string | null
  debitAccountId: string
  creditAccountId: string
  createdById: string | null
  auditedById: string | null
  [key: string]: unknown
}

export type IssueItem = {
  id: string
  idx: number
  qty: string
  baseQty: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  orderNo: string
  remarks: string | null
  insertedAt: WireTime
  updatedAt: WireTime
  issueId: string
  companyId: string
  orderItemMaterialId: string
  materialId: string
  unitId: string
  fromWarehouseId: string
  outsourcedWarehouseId: string
  issueNo?: string
  issueDate?: string
  issueStatus?: string
  partyType?: string
  partyId?: string
  [key: string]: unknown
}

export type ReceiptItem = {
  id: string
  idx: number
  qty: string
  baseQty: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  orderNo: string
  orderQty: string
  orderBaseQty: string
  orderUnitName: string
  orderPrice: string
  orderAmount: string
  orderBasePrice: string
  orderBaseAmount: string
  orderTaxRate: string
  orderCurrencyCode: string
  reconciledQty: string
  remainingReconcilableQty?: string
  returnedQty?: string
  remainingReturnableQty?: string
  remarks: string | null
  insertedAt: WireTime
  updatedAt: WireTime
  receiptId: string
  companyId: string
  orderItemId: string
  materialId: string
  unitId: string
  warehouseId: string
  receiptNo?: string
  receiptDate?: string
  receiptStatus?: string
  partyType?: string
  partyId?: string
  [key: string]: unknown
}

export type ReceiptMaterial = {
  id: string
  idx: number
  qty: string
  baseQty: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  orderNo: string
  remarks: string | null
  insertedAt: WireTime
  updatedAt: WireTime
  receiptItemId: string
  companyId: string
  orderItemMaterialId: string
  materialId: string
  unitId: string
  outsourcedWarehouseId: string | null
  receiptNo?: string
  [key: string]: unknown
}

export type ReceiptByproduct = {
  id: string
  idx: number
  qty: string
  baseQty: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  orderNo: string
  remarks: string | null
  insertedAt: WireTime
  updatedAt: WireTime
  receiptItemId: string
  companyId: string
  orderItemByproductId: string
  materialId: string
  unitId: string
  warehouseId: string | null
  receiptNo?: string
  [key: string]: unknown
}

export function mapIssueExtras(row: Record<string, unknown>): Partial<IssueHead> {
  return {
    partyType: upperStatus(String(row.party_type ?? row.partyType ?? '')),
    status: upperStatus(String(row.status ?? '')),
  }
}

export function mapReceiptExtras(row: Record<string, unknown>): Partial<ReceiptHead> {
  return {
    partyType: upperStatus(String(row.party_type ?? row.partyType ?? '')),
    status: upperStatus(String(row.status ?? '')),
  }
}

export function mapIssueItemExtras(row: Record<string, unknown>): Record<string, unknown> {
  return {
    issueNo: String(row.issue_no ?? row.issueNo ?? ''),
    issueDate: asDate(row.issue_date ?? row.issueDate),
    issueStatus: upperStatus(String(row.issue_status ?? row.issueStatus ?? '')),
    partyType: upperStatus(String(row.party_type ?? row.partyType ?? '')),
    partyId: String(row.party_id ?? row.partyId ?? ''),
  }
}

export function mapReceiptItemExtras(row: Record<string, unknown>): Record<string, unknown> {
  const baseQty = String(row.base_qty ?? row.baseQty ?? 0)
  const reconciled = String(row.reconciled_qty ?? row.reconciledQty ?? 0)
  return {
    receiptNo: String(row.receipt_no ?? row.receiptNo ?? ''),
    receiptDate: asDate(row.receipt_date ?? row.receiptDate),
    receiptStatus: upperStatus(String(row.receipt_status ?? row.receiptStatus ?? '')),
    partyType: upperStatus(String(row.party_type ?? row.partyType ?? '')),
    partyId: String(row.party_id ?? row.partyId ?? ''),
    remainingReconcilableQty: wireRequiredDecimal(
      String(
        row.remaining_reconcilable_qty ??
          row.remainingReconcilableQty ??
          decimal(baseQty).sub(decimal(reconciled)),
      ),
    ),
    returnedQty: wireRequiredDecimal(String(row.returned_qty ?? row.returnedQty ?? 0)),
    remainingReturnableQty: wireRequiredDecimal(
      String(
        row.remaining_returnable_qty ??
          row.remainingReturnableQty ??
          decimal(baseQty).sub(decimal(String(row.returned_qty ?? row.returnedQty ?? 0))),
      ),
    ),
  }
}

export function mapMaterialExtras(row: Record<string, unknown>): Record<string, unknown> {
  return { receiptNo: String(row.receipt_no ?? row.receiptNo ?? '') }
}

export function mapByproductExtras(row: Record<string, unknown>): Record<string, unknown> {
  return { receiptNo: String(row.receipt_no ?? row.receiptNo ?? '') }
}

/** 兼容旧手写 map* 形状（测试/审核装载） */
export function mapIssue(row: Record<string, unknown>): IssueHead {
  return {
    id: String(row.id),
    issueNo: String(row.issue_no ?? row.issueNo),
    issueDate: asDate(row.issue_date ?? row.issueDate)!,
    partyType: upperStatus(String(row.party_type ?? row.partyType)),
    partyId: String(row.party_id ?? row.partyId),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    auditedAt: asDateTime(row.audited_at ?? row.auditedAt),
    insertedAt: asDateTime(row.inserted_at ?? row.insertedAt)!,
    updatedAt: asDateTime(row.updated_at ?? row.updatedAt)!,
    companyId: String(row.company_id ?? row.companyId),
    fromWarehouseId: row.from_warehouse_id
      ? String(row.from_warehouse_id)
      : row.fromWarehouseId
        ? String(row.fromWarehouseId)
        : null,
    outsourcedWarehouseId: row.outsourced_warehouse_id
      ? String(row.outsourced_warehouse_id)
      : row.outsourcedWarehouseId
        ? String(row.outsourcedWarehouseId)
        : null,
    createdById: row.created_by_id
      ? String(row.created_by_id)
      : row.createdById
        ? String(row.createdById)
        : null,
    auditedById: row.audited_by_id
      ? String(row.audited_by_id)
      : row.auditedById
        ? String(row.auditedById)
        : null,
  }
}

export function mapReceipt(row: Record<string, unknown>): ReceiptHead {
  return {
    id: String(row.id),
    receiptNo: String(row.receipt_no ?? row.receiptNo),
    receiptDate: asDate(row.receipt_date ?? row.receiptDate)!,
    postingDate: (row.posting_date ?? row.postingDate)
      ? asDate(row.posting_date ?? row.postingDate)
      : null,
    partyType: upperStatus(String(row.party_type ?? row.partyType)),
    partyId: String(row.party_id ?? row.partyId),
    remarks: asOptionalString(row.remarks),
    status: upperStatus(String(row.status)),
    auditedAt: asDateTime(row.audited_at ?? row.auditedAt),
    insertedAt: asDateTime(row.inserted_at ?? row.insertedAt)!,
    updatedAt: asDateTime(row.updated_at ?? row.updatedAt)!,
    companyId: String(row.company_id ?? row.companyId),
    warehouseId: row.warehouse_id
      ? String(row.warehouse_id)
      : row.warehouseId
        ? String(row.warehouseId)
        : null,
    outsourcedWarehouseId: row.outsourced_warehouse_id
      ? String(row.outsourced_warehouse_id)
      : row.outsourcedWarehouseId
        ? String(row.outsourcedWarehouseId)
        : null,
    debitAccountId: String(row.debit_account_id ?? row.debitAccountId),
    creditAccountId: String(row.credit_account_id ?? row.creditAccountId),
    createdById: row.created_by_id
      ? String(row.created_by_id)
      : row.createdById
        ? String(row.createdById)
        : null,
    auditedById: row.audited_by_id
      ? String(row.audited_by_id)
      : row.auditedById
        ? String(row.auditedById)
        : null,
  }
}

export function mapIssueItem(row: Record<string, unknown>): IssueItem {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty ?? row.baseQty)),
    materialCode: String(row.material_code ?? row.materialCode),
    materialName: String(row.material_name ?? row.materialName),
    materialSpec: asOptionalString(row.material_spec ?? row.materialSpec),
    unitName: String(row.unit_name ?? row.unitName),
    orderNo: String(row.order_no ?? row.orderNo),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at ?? row.insertedAt)!,
    updatedAt: asDateTime(row.updated_at ?? row.updatedAt)!,
    issueId: String(row.issue_id ?? row.issueId),
    companyId: String(row.company_id ?? row.companyId),
    orderItemMaterialId: String(row.order_item_material_id ?? row.orderItemMaterialId),
    materialId: String(row.material_id ?? row.materialId),
    unitId: String(row.unit_id ?? row.unitId),
    fromWarehouseId: String(row.from_warehouse_id ?? row.fromWarehouseId),
    outsourcedWarehouseId: String(row.outsourced_warehouse_id ?? row.outsourcedWarehouseId),
    ...mapIssueItemExtras(row),
  }
}

export function mapReceiptItem(row: Record<string, unknown>): ReceiptItem {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty ?? row.baseQty)),
    materialCode: String(row.material_code ?? row.materialCode),
    materialName: String(row.material_name ?? row.materialName),
    materialSpec: asOptionalString(row.material_spec ?? row.materialSpec),
    customerPartNo: asOptionalString(row.customer_part_no ?? row.customerPartNo),
    unitName: String(row.unit_name ?? row.unitName),
    orderNo: String(row.order_no ?? row.orderNo),
    orderQty: wireRequiredDecimal(String(row.order_qty ?? row.orderQty)),
    orderBaseQty: wireRequiredDecimal(String(row.order_base_qty ?? row.orderBaseQty)),
    orderUnitName: String(row.order_unit_name ?? row.orderUnitName),
    orderPrice: wireRequiredDecimal(String(row.order_price ?? row.orderPrice)),
    orderAmount: wireRequiredDecimal(String(row.order_amount ?? row.orderAmount)),
    orderBasePrice: wireRequiredDecimal(String(row.order_base_price ?? row.orderBasePrice)),
    orderBaseAmount: wireRequiredDecimal(String(row.order_base_amount ?? row.orderBaseAmount)),
    orderTaxRate: wireRequiredDecimal(String(row.order_tax_rate ?? row.orderTaxRate)),
    orderCurrencyCode: String(row.order_currency_code ?? row.orderCurrencyCode),
    reconciledQty: wireRequiredDecimal(String(row.reconciled_qty ?? row.reconciledQty ?? 0)),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at ?? row.insertedAt)!,
    updatedAt: asDateTime(row.updated_at ?? row.updatedAt)!,
    receiptId: String(row.receipt_id ?? row.receiptId),
    companyId: String(row.company_id ?? row.companyId),
    orderItemId: String(row.order_item_id ?? row.orderItemId),
    materialId: String(row.material_id ?? row.materialId),
    unitId: String(row.unit_id ?? row.unitId),
    warehouseId: String(row.warehouse_id ?? row.warehouseId),
    ...mapReceiptItemExtras(row),
  }
}

export function mapReceiptMaterial(row: Record<string, unknown>): ReceiptMaterial {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty ?? row.baseQty)),
    materialCode: String(row.material_code ?? row.materialCode),
    materialName: String(row.material_name ?? row.materialName),
    materialSpec: asOptionalString(row.material_spec ?? row.materialSpec),
    unitName: String(row.unit_name ?? row.unitName),
    orderNo: String(row.order_no ?? row.orderNo),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at ?? row.insertedAt)!,
    updatedAt: asDateTime(row.updated_at ?? row.updatedAt)!,
    receiptItemId: String(row.receipt_item_id ?? row.receiptItemId),
    companyId: String(row.company_id ?? row.companyId),
    orderItemMaterialId: String(row.order_item_material_id ?? row.orderItemMaterialId),
    materialId: String(row.material_id ?? row.materialId),
    unitId: String(row.unit_id ?? row.unitId),
    outsourcedWarehouseId: (row.outsourced_warehouse_id ?? row.outsourcedWarehouseId)
      ? String(row.outsourced_warehouse_id ?? row.outsourcedWarehouseId)
      : null,
    ...mapMaterialExtras(row),
  }
}

export function mapReceiptByproduct(row: Record<string, unknown>): ReceiptByproduct {
  return {
    id: String(row.id),
    idx: Number(row.idx),
    qty: wireRequiredDecimal(String(row.qty)),
    baseQty: wireRequiredDecimal(String(row.base_qty ?? row.baseQty)),
    materialCode: String(row.material_code ?? row.materialCode),
    materialName: String(row.material_name ?? row.materialName),
    materialSpec: asOptionalString(row.material_spec ?? row.materialSpec),
    unitName: String(row.unit_name ?? row.unitName),
    orderNo: String(row.order_no ?? row.orderNo),
    remarks: asOptionalString(row.remarks),
    insertedAt: asDateTime(row.inserted_at ?? row.insertedAt)!,
    updatedAt: asDateTime(row.updated_at ?? row.updatedAt)!,
    receiptItemId: String(row.receipt_item_id ?? row.receiptItemId),
    companyId: String(row.company_id ?? row.companyId),
    orderItemByproductId: String(row.order_item_byproduct_id ?? row.orderItemByproductId),
    materialId: String(row.material_id ?? row.materialId),
    unitId: String(row.unit_id ?? row.unitId),
    warehouseId: (row.warehouse_id ?? row.warehouseId)
      ? String(row.warehouse_id ?? row.warehouseId)
      : null,
    ...mapByproductExtras(row),
  }
}

/**
 * 公司 / 对手 / 备注的形态校验（create 的公司闸之前先跑）：
 * 入参校验（400）必须先于公司边界（404），否则 `companyId: ''` 会先撞公司闸报「公司不存在」。
 */
export function validateHeadParty(
  companyId: string,
  partyType: string,
  partyId: string,
  remarks: string | null,
) {
  const fields = partyFields(companyId, partyType, partyId, remarks)
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外履约单参数不合法', fields)
  }
}

function partyFields(
  companyId: string,
  partyType: string,
  partyId: string,
  remarks: string | null,
): Record<string, string[]> {
  const fields: Record<string, string[]> = {}
  const pt = lowerParty(partyType)
  if (pt !== 'supplier' && pt !== 'company') fields.partyType = ['只允许供应商或内部公司']
  if (!partyId) fields.partyId = ['必填']
  if (!companyId) fields.companyId = ['必填']
  if (pt === 'company' && partyId === companyId) fields.partyId = ['对手不能是本公司']
  if (remarks && runeLen(remarks) > 512) fields.remarks = ['最多 512 个字符']
  return fields
}

function validateCommonHead(
  companyId: string,
  no: string,
  documentDate: string,
  partyType: string,
  partyId: string,
  remarks: string | null,
) {
  const fields: Record<string, string[]> = {}
  if (!no.trim() || runeLen(no) > 32) fields.number = ['不能为空且最多 32 个字符']
  if (!documentDate) fields.documentDate = ['必填']
  Object.assign(fields, partyFields(companyId, partyType, partyId, remarks))
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外履约单参数不合法', fields)
  }
}

export async function validateWarehouse(db: DbHandle, companyId: string, warehouseId: string) {
  await validateEnabledLeafWarehouse(db, companyId, warehouseId, '委外履约仓库不合法')
}

export async function validateIssueHead(
  db: DbHandle,
  item: {
    issueNo: string
    issueDate: string
    partyType: string
    partyId: string
    remarks: string | null
    companyId: string
    fromWarehouseId: string | null
    outsourcedWarehouseId: string | null
  },
) {
  validateCommonHead(
    item.companyId,
    item.issueNo,
    item.issueDate,
    item.partyType,
    item.partyId,
    item.remarks,
  )
  if (!(await partyExists(db, item.partyType, item.partyId))) {
    throw ApiError.validation('委外履约单参数不合法', { partyId: ['对手不存在'] })
  }
  if (item.fromWarehouseId) {
    await validateWarehouse(db, item.companyId, item.fromWarehouseId)
  }
  if (item.outsourcedWarehouseId) {
    await validateOutsourcedWarehouse(
      db,
      item.companyId,
      item.partyType,
      item.partyId,
      item.outsourcedWarehouseId,
    )
  }
}

export async function validateReceiptHead(
  db: DbHandle,
  item: {
    receiptNo: string
    receiptDate: string
    partyType: string
    partyId: string
    remarks: string | null
    companyId: string
    warehouseId: string | null
    outsourcedWarehouseId: string | null
    debitAccountId: string
    creditAccountId: string
  },
) {
  validateCommonHead(
    item.companyId,
    item.receiptNo,
    item.receiptDate,
    item.partyType,
    item.partyId,
    item.remarks,
  )
  if (!item.debitAccountId || !item.creditAccountId) {
    throw ApiError.validation('委外入库单参数不合法', {
      debitAccountId: ['必填'],
      creditAccountId: ['必填'],
    })
  }
  if (!(await partyExists(db, item.partyType, item.partyId))) {
    throw ApiError.validation('委外履约单参数不合法', { partyId: ['对手不存在'] })
  }
  if (item.warehouseId) await validateWarehouse(db, item.companyId, item.warehouseId)
  if (item.outsourcedWarehouseId) {
    await validateOutsourcedWarehouse(
      db,
      item.companyId,
      item.partyType,
      item.partyId,
      item.outsourcedWarehouseId,
    )
  }
  await validateReceiptAccounts(db, item)
}

export async function validateReceiptAccounts(
  db: DbHandle,
  item: { companyId: string; debitAccountId: string; creditAccountId: string },
) {
  const rows = await sql<{
    id: string
    company_id: string
    is_group: boolean
    active: boolean
    role: string | null
  }>`
    SELECT id, company_id, is_group, active, role
    FROM bas_account WHERE id = ANY(${[item.debitAccountId, item.creditAccountId]}::uuid[])
  `.execute(db)
  const map = new Map(rows.rows.map((r) => [r.id, r]))
  for (const [field, accountId] of [
    ['debitAccountId', item.debitAccountId],
    ['creditAccountId', item.creditAccountId],
  ] as const) {
    const value = map.get(accountId)
    if (!value || value.company_id !== item.companyId || value.is_group || !value.active) {
      throw ApiError.validation('委外入库科目不合法', {
        [field]: ['须属于单据公司、启用且非汇总'],
      })
    }
    if (
      field === 'creditAccountId' &&
      (!value.role || value.role.toLowerCase() !== 'unbilled_payable')
    ) {
      throw ApiError.validation('委外入库科目不合法', {
        [field]: ['须为未开票应付角色科目'],
      })
    }
  }
}

export async function resolveReceiptAccounts(
  db: DbHandle,
  companyId: string,
  debit: string | null,
  credit: string | null,
): Promise<{ debit: string; credit: string }> {
  let d = debit
  let c = credit
  if (!d || !c) {
    const defaults = await sql<{
      receipt_debit_account_id: string | null
      receipt_credit_account_id: string | null
    }>`
      SELECT receipt_debit_account_id, receipt_credit_account_id
      FROM sal_company_account_default WHERE company_id=${companyId}::uuid
    `.execute(db)
    const row = defaults.rows[0]
    if (!d) d = row?.receipt_debit_account_id ?? null
    if (!c) c = row?.receipt_credit_account_id ?? null
  }
  if (!d || !c) {
    throw ApiError.validation('委外入库单参数不合法', {
      accounts: ['未填写科目且公司未配置默认入库科目'],
    })
  }
  return { debit: d, credit: c }
}

export async function deriveIssueItem(
  db: DbHandle,
  parent: { companyId: string; partyType: string; partyId: string },
  draft: {
    orderItemMaterialId: string
    qty: ReturnType<typeof decimal>
    fromWarehouseId: string | null
    outsourcedWarehouseId: string | null
    remarks: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (!draft.orderItemMaterialId) fields.orderItemMaterialId = ['必填']
  if (!draft.fromWarehouseId) fields.fromWarehouseId = ['必填']
  if (!draft.outsourcedWarehouseId) fields.outsourcedWarehouseId = ['必填']
  if (
    draft.fromWarehouseId &&
    draft.outsourcedWarehouseId &&
    draft.fromWarehouseId === draft.outsourcedWarehouseId
  ) {
    fields.warehouses = ['调出仓与外协仓不能相同']
  }
  if (draft.remarks && runeLen(draft.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (!draft.qty.gt(0)) fields.qty = ['必须大于 0']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外发料行参数不合法', fields)
  }
  const source = await loadMaterialSnapshot(db, draft.orderItemMaterialId)
  if (source.orderStatus !== 'audited' || !source.isOutsourced) {
    throw ApiError.validation('委外发料行参数不合法', {
      orderItemMaterialId: ['来源须为已审核委外订单发料清单行'],
    })
  }
  if (
    source.companyId !== parent.companyId ||
    lowerParty(source.partyType) !== lowerParty(parent.partyType) ||
    source.partyId !== parent.partyId
  ) {
    throw ApiError.validation('委外发料行参数不合法', {
      orderItemMaterialId: ['来源订单公司或对手不一致'],
    })
  }
  await validateWarehouse(db, parent.companyId, draft.fromWarehouseId!)
  await validateOutsourcedWarehouse(
    db,
    parent.companyId,
    parent.partyType,
    parent.partyId,
    draft.outsourcedWarehouseId!,
  )
  const snap = await loadMaterialSnap(db, source.materialId, source.unitId)
  guardMaterialType(snap, ['STOCK'], '委外发料行')
  const baseQty = convertToBaseQty(draft.qty, source.unitId, snap)
  return {
    qty: draft.qty,
    baseQty,
    materialId: source.materialId,
    unitId: source.unitId,
    materialCode: source.materialCode,
    materialName: source.materialName,
    materialSpec: source.materialSpec,
    unitName: source.unitName,
    orderNo: source.orderNo,
    orderItemMaterialId: draft.orderItemMaterialId,
    fromWarehouseId: draft.fromWarehouseId!,
    outsourcedWarehouseId: draft.outsourcedWarehouseId!,
    remarks: draft.remarks,
  }
}

async function loadMaterialSnapshot(db: DbHandle, id: string) {
  const rows = await sql<{
    company_id: string
    party_type: string
    party_id: string
    status: string
    is_outsourced: boolean
    order_no: string
    material_id: string
    unit_id: string
    material_code: string
    material_name: string
    material_spec: string | null
    unit_name: string
  }>`
    SELECT o.company_id, o.party_type, o.party_id, o.status, o.is_outsourced, o.order_no,
      ml.material_id, ml.unit_id, m.code AS material_code, m.name AS material_name, m.spec AS material_spec,
      u.name AS unit_name
    FROM pur_order_item_material ml
    JOIN pur_order_item oi ON oi.id=ml.order_item_id
    JOIN pur_order o ON o.id=oi.order_id
    JOIN inv_material m ON m.id=ml.material_id
    JOIN bas_unit u ON u.id=ml.unit_id
    WHERE ml.id=${id}::uuid
  `.execute(db)
  const r = rows.rows[0]
  if (!r) {
    throw ApiError.validation('委外发料行参数不合法', {
      orderItemMaterialId: ['来源发料清单行不存在'],
    })
  }
  return {
    companyId: r.company_id,
    partyType: r.party_type,
    partyId: r.party_id,
    orderStatus: r.status.toLowerCase(),
    isOutsourced: r.is_outsourced,
    orderNo: r.order_no,
    materialId: r.material_id,
    unitId: r.unit_id,
    materialCode: r.material_code,
    materialName: r.material_name,
    materialSpec: r.material_spec,
    unitName: r.unit_name,
  }
}

export async function deriveReceiptItem(
  db: DbHandle,
  parent: { id: string; companyId: string; partyType: string; partyId: string },
  draft: {
    qty: ReturnType<typeof decimal>
    orderItemId: string
    unitId: string | null
    warehouseId: string | null
    remarks: string | null
  },
  excludeId: string | null,
) {
  const fields: Record<string, string[]> = {}
  if (!draft.qty.gt(0)) fields.qty = ['必须大于 0']
  if (!draft.orderItemId) fields.orderItemId = ['必填']
  if (!draft.warehouseId) fields.warehouseId = ['必填']
  if (draft.remarks && runeLen(draft.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外入库成品行参数不合法', fields)
  }
  await validateWarehouse(db, parent.companyId, draft.warehouseId!)
  const source = await loadReceiptOrderSnapshot(db, draft.orderItemId)
  if (source.orderStatus !== 'audited' || !source.isOutsourced) {
    throw ApiError.validation('委外入库成品行参数不合法', {
      orderItemId: ['来源须为已审核委外订单行'],
    })
  }
  if (
    source.companyId !== parent.companyId ||
    lowerParty(source.partyType) !== lowerParty(parent.partyType) ||
    source.partyId !== parent.partyId
  ) {
    throw ApiError.validation('委外入库成品行参数不合法', {
      orderItemId: ['来源订单公司或对手不一致'],
    })
  }
  const chosenUnit = draft.unitId && draft.unitId.length > 0 ? draft.unitId : source.orderUnitId
  const snap = await loadMaterialSnap(db, source.materialId, chosenUnit)
  guardMaterialType(snap, ['STOCK'], '委外入库成品行')
  const baseQty = convertToBaseQty(draft.qty, chosenUnit, snap)
  const cur = excludeId
    ? await sql<{ order_currency_code: string }>`
        SELECT order_currency_code FROM pur_outsourced_receipt_item
        WHERE receipt_id=${parent.id}::uuid AND id<>${excludeId}::uuid
        ORDER BY idx,id LIMIT 1
      `.execute(db)
    : await sql<{ order_currency_code: string }>`
        SELECT order_currency_code FROM pur_outsourced_receipt_item
        WHERE receipt_id=${parent.id}::uuid
        ORDER BY idx,id LIMIT 1
      `.execute(db)
  if (cur.rows[0] && cur.rows[0].order_currency_code !== source.currencyCode) {
    throw ApiError.validation('委外入库成品行参数不合法', {
      orderItemId: ['同一入库单来源订单原币必须一致'],
    })
  }
  return {
    qty: draft.qty,
    baseQty,
    materialId: source.materialId,
    unitId: chosenUnit,
    unitName: snap.unitName,
    materialCode: source.materialCode,
    materialName: source.materialName,
    materialSpec: source.materialSpec,
    customerPartNo: source.customerPartNo,
    orderNo: source.orderNo,
    orderQty: source.orderQty,
    orderBaseQty: source.orderBaseQty,
    orderUnitName: source.orderUnitName,
    orderPrice: source.orderPrice,
    orderAmount: source.orderAmount,
    orderBasePrice: source.orderBasePrice,
    orderBaseAmount: source.orderBaseAmount,
    orderTaxRate: source.orderTaxRate,
    orderCurrencyCode: source.currencyCode,
    warehouseId: draft.warehouseId!,
    remarks: draft.remarks,
  }
}

async function loadReceiptOrderSnapshot(db: DbHandle, id: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT o.company_id, o.party_type, o.party_id, o.status, o.is_outsourced, o.order_no,
      cur.iso_code AS currency_code, i.material_id, m.default_unit_id, i.unit_id AS order_unit_id,
      i.qty, i.base_qty, i.unit_name, i.price, i.amount, i.base_price, i.base_amount, i.tax_rate,
      m.code AS material_code, m.name AS material_name, m.spec AS material_spec, m.customer_part_no
    FROM pur_order_item i
    JOIN pur_order o ON o.id=i.order_id
    JOIN bas_currency cur ON cur.id=o.currency_id
    JOIN inv_material m ON m.id=i.material_id
    WHERE i.id=${id}::uuid
  `.execute(db)
  const r = rows.rows[0]
  if (!r) {
    throw ApiError.validation('委外入库成品行参数不合法', { orderItemId: ['来源订单行不存在'] })
  }
  return {
    companyId: String(r.company_id),
    partyType: String(r.party_type),
    partyId: String(r.party_id),
    orderStatus: String(r.status).toLowerCase(),
    isOutsourced: Boolean(r.is_outsourced),
    orderNo: String(r.order_no),
    currencyCode: String(r.currency_code),
    materialId: String(r.material_id),
    orderUnitId: String(r.order_unit_id),
    orderQty: String(r.qty),
    orderBaseQty: String(r.base_qty),
    orderUnitName: String(r.unit_name),
    orderPrice: String(r.price),
    orderAmount: String(r.amount),
    orderBasePrice: String(r.base_price),
    orderBaseAmount: String(r.base_amount),
    orderTaxRate: String(r.tax_rate),
    materialCode: String(r.material_code),
    materialName: String(r.material_name),
    materialSpec: asOptionalString(r.material_spec),
    customerPartNo: asOptionalString(r.customer_part_no),
  }
}

export async function deriveReceiptMaterial(
  db: DbHandle,
  receipt: { companyId: string; partyType: string; partyId: string },
  parent: { orderItemId: string },
  draft: {
    qty: ReturnType<typeof decimal>
    orderItemMaterialId: string
    outsourcedWarehouseId: string | null
    remarks: string | null
  },
) {
  validateChildShape(draft.qty, draft.orderItemMaterialId, draft.remarks)
  const source = await loadChildSource(db, true, draft.orderItemMaterialId)
  if (source.orderItemId !== parent.orderItemId) {
    throw ApiError.validation('委外入库材料行参数不合法', {
      orderItemMaterialId: ['来源必须属于父成品行的订单行'],
    })
  }
  if (draft.outsourcedWarehouseId) {
    await validateOutsourcedWarehouse(
      db,
      receipt.companyId,
      receipt.partyType,
      receipt.partyId,
      draft.outsourcedWarehouseId,
    )
  }
  const snap = await loadMaterialSnap(db, source.materialId, source.unitId)
  guardMaterialType(snap, ['STOCK'], '委外入库材料行')
  const baseQty = convertToBaseQty(draft.qty, source.unitId, snap)
  return {
    qty: draft.qty,
    baseQty,
    materialId: source.materialId,
    unitId: source.unitId,
    materialCode: source.materialCode,
    materialName: source.materialName,
    materialSpec: source.materialSpec,
    unitName: source.unitName,
    orderNo: source.orderNo,
    orderItemMaterialId: draft.orderItemMaterialId,
    outsourcedWarehouseId: draft.outsourcedWarehouseId,
    remarks: draft.remarks,
  }
}

export async function deriveReceiptByproduct(
  db: DbHandle,
  receipt: { companyId: string },
  parent: { orderItemId: string },
  draft: {
    qty: ReturnType<typeof decimal>
    orderItemByproductId: string
    warehouseId: string | null
    remarks: string | null
  },
) {
  validateChildShape(draft.qty, draft.orderItemByproductId, draft.remarks)
  const source = await loadChildSource(db, false, draft.orderItemByproductId)
  if (source.orderItemId !== parent.orderItemId) {
    throw ApiError.validation('委外入库副产物行参数不合法', {
      orderItemByproductId: ['来源必须属于父成品行的订单行'],
    })
  }
  if (draft.warehouseId) {
    await validateWarehouse(db, receipt.companyId, draft.warehouseId)
  }
  const snap = await loadMaterialSnap(db, source.materialId, source.unitId)
  guardMaterialType(snap, ['STOCK'], '委外入库副产物行')
  const baseQty = convertToBaseQty(draft.qty, source.unitId, snap)
  return {
    qty: draft.qty,
    baseQty,
    materialId: source.materialId,
    unitId: source.unitId,
    materialCode: source.materialCode,
    materialName: source.materialName,
    materialSpec: source.materialSpec,
    unitName: source.unitName,
    orderNo: source.orderNo,
    orderItemByproductId: draft.orderItemByproductId,
    warehouseId: draft.warehouseId,
    remarks: draft.remarks,
  }
}

function validateChildShape(
  qty: ReturnType<typeof decimal>,
  sourceId: string,
  remarks: string | null,
) {
  const fields: Record<string, string[]> = {}
  if (!qty.gt(0)) fields.qty = ['必须大于 0']
  if (!sourceId) fields.sourceId = ['来源清单行必填']
  if (remarks && runeLen(remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('委外入库子行参数不合法', fields)
  }
}

async function loadChildSource(db: DbHandle, material: boolean, id: string) {
  const table = material ? 'pur_order_item_material' : 'pur_order_item_byproduct'
  const rows = await sql<{
    order_item_id: string
    material_id: string
    unit_id: string
    material_code: string
    material_name: string
    material_spec: string | null
    unit_name: string
    order_no: string
  }>`
    SELECT l.order_item_id, l.material_id, l.unit_id,
      m.code AS material_code, m.name AS material_name, m.spec AS material_spec,
      u.name AS unit_name, o.order_no
    FROM ${sql.raw(table)} l
    JOIN pur_order_item i ON i.id=l.order_item_id
    JOIN pur_order o ON o.id=i.order_id
    JOIN inv_material m ON m.id=l.material_id
    JOIN bas_unit u ON u.id=l.unit_id
    WHERE l.id=${id}::uuid
  `.execute(db)
  const r = rows.rows[0]
  if (!r) {
    throw ApiError.validation('委外入库子行参数不合法', { sourceId: ['来源清单行不存在'] })
  }
  return {
    orderItemId: r.order_item_id,
    materialId: r.material_id,
    unitId: r.unit_id,
    materialCode: r.material_code,
    materialName: r.material_name,
    materialSpec: r.material_spec,
    unitName: r.unit_name,
    orderNo: r.order_no,
  }
}

export async function loadIssueActionItems(db: DbHandle, issueId: string) {
  const rows = await sql<Record<string, unknown>>`
    SELECT id, order_item_material_id, base_qty, material_id, from_warehouse_id,
      outsourced_warehouse_id, qty, remarks
    FROM pur_outsourced_issue_item
    WHERE issue_id=${issueId}::uuid
    ORDER BY idx, id
    FOR UPDATE
  `.execute(db)
  return rows.rows.map((r) => ({
    id: String(r.id),
    orderItemMaterialId: String(r.order_item_material_id),
    baseQty: String(r.base_qty),
    materialId: String(r.material_id),
    fromWarehouseId: String(r.from_warehouse_id),
    outsourcedWarehouseId: String(r.outsourced_warehouse_id),
    qty: String(r.qty),
    remarks: asOptionalString(r.remarks),
  }))
}

export async function loadReceiptActionLines(db: DbHandle, receiptId: string) {
  const itemRows = await sql<Record<string, unknown>>`
    SELECT id, order_item_id, base_qty, material_id, warehouse_id, unit_id, qty, remarks,
      order_base_qty, order_base_amount, reconciled_qty
    FROM pur_outsourced_receipt_item
    WHERE receipt_id=${receiptId}::uuid
    ORDER BY idx, id
    FOR UPDATE
  `.execute(db)
  const items = itemRows.rows.map((r) => ({
    id: String(r.id),
    orderItemId: String(r.order_item_id),
    baseQty: String(r.base_qty),
    materialId: String(r.material_id),
    warehouseId: String(r.warehouse_id),
    unitId: String(r.unit_id),
    qty: String(r.qty),
    remarks: asOptionalString(r.remarks),
    orderBaseQty: String(r.order_base_qty),
    orderBaseAmount: String(r.order_base_amount),
    reconciledQty: String(r.reconciled_qty ?? 0),
  }))
  const materials: Array<{
    outsourcedWarehouseId: string | null
    materialId: string
    baseQty: string
    remarks: string | null
  }> = []
  const byproducts: Array<{
    warehouseId: string | null
    materialId: string
    baseQty: string
    remarks: string | null
  }> = []
  for (const item of items) {
    const mats = await sql<Record<string, unknown>>`
      SELECT outsourced_warehouse_id, material_id, base_qty, remarks
      FROM pur_outsourced_receipt_item_material
      WHERE receipt_item_id=${item.id}::uuid
      ORDER BY idx, id
      FOR UPDATE
    `.execute(db)
    for (const m of mats.rows) {
      materials.push({
        outsourcedWarehouseId: m.outsourced_warehouse_id
          ? String(m.outsourced_warehouse_id)
          : null,
        materialId: String(m.material_id),
        baseQty: String(m.base_qty),
        remarks: asOptionalString(m.remarks),
      })
    }
    const byps = await sql<Record<string, unknown>>`
      SELECT warehouse_id, material_id, base_qty, remarks
      FROM pur_outsourced_receipt_item_byproduct
      WHERE receipt_item_id=${item.id}::uuid
      ORDER BY idx, id
      FOR UPDATE
    `.execute(db)
    for (const b of byps.rows) {
      byproducts.push({
        warehouseId: b.warehouse_id ? String(b.warehouse_id) : null,
        materialId: String(b.material_id),
        baseQty: String(b.base_qty),
        remarks: asOptionalString(b.remarks),
      })
    }
  }
  return { items, materials, byproducts }
}

/** 比例带出材料/副产物（成品行 create afterWrite 钩子） */
export async function carryReceiptChildren(
  trx: DbHandle,
  receipt: { id: string; companyId: string; warehouseId: string | null; outsourcedWarehouseId: string | null; partyType: string; partyId: string },
  parent: { id: string; orderItemId: string; baseQty: string; orderBaseQty: string },
  createMaterial: (input: {
    receiptItemId: string
    idx: number
    qty: string
    orderItemMaterialId: string
    outsourcedWarehouseId: string | null
  }) => Promise<void>,
  createByproduct: (input: {
    receiptItemId: string
    idx: number
    qty: string
    orderItemByproductId: string
    warehouseId: string | null
  }) => Promise<void>,
) {
  if (!decimal(parent.orderBaseQty).gt(0)) return
  const ratio = decimal(parent.baseQty).div(decimal(parent.orderBaseQty))
  for (const isMaterial of [true, false]) {
    const table = isMaterial ? 'pur_order_item_material' : 'pur_order_item_byproduct'
    const sources = await sql<{ id: string; quantity: string }>`
      SELECT id, quantity::text AS quantity FROM ${sql.raw(table)}
      WHERE order_item_id=${parent.orderItemId}::uuid
      ORDER BY inserted_at, id
    `.execute(trx)
    let idx = 0
    for (const source of sources.rows) {
      const qty = decimal(source.quantity).mul(ratio).toDecimalPlaces(6)
      if (!qty.gt(0)) continue
      if (isMaterial) {
        await createMaterial({
          receiptItemId: parent.id,
          idx,
          qty: wireRequiredDecimal(qty),
          orderItemMaterialId: source.id,
          outsourcedWarehouseId: receipt.outsourcedWarehouseId,
        })
      } else {
        await createByproduct({
          receiptItemId: parent.id,
          idx,
          qty: wireRequiredDecimal(qty),
          orderItemByproductId: source.id,
          warehouseId: receipt.warehouseId,
        })
      }
      idx++
    }
  }
}

export async function loadReceiptHead(db: DbHandle, id: string): Promise<ReceiptHead | null> {
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM pur_outsourced_receipt WHERE id=${id}::uuid
  `.execute(db)
  const row = rows.rows[0]
  return row ? mapReceipt(row) : null
}

export async function assertDraftReceipt(
  db: DbHandle,
  receiptId: string,
): Promise<ReceiptHead> {
  const head = await loadReceiptHead(db, receiptId)
  if (!head) throw new ApiError('not_found', `${RECEIPT_LABEL}不存在`)
  if (head.status !== 'DRAFT') {
    throw new ApiError('conflict', `仅草稿${RECEIPT_LABEL}可编辑`)
  }
  return head
}
