import { nullableString, requiredString } from './draft-fields'
import { api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { aggregateDraftTransport } from './aggregate-draft-transport'

export interface OutsourcedIssueDraftItem {
  id?: string
  idx: number
  qty: string
  orderItemMaterialId: string
  fromWarehouseId?: string | null
  outsourcedWarehouseId?: string | null
  remarks?: string | null
}

export interface OutsourcedIssueDraft {
  companyId: string
  issueNo?: string | null
  issueDate?: string | null
  partyType: string
  partyId: string
  remarks?: string | null
  fromWarehouseId?: string | null
  outsourcedWarehouseId?: string | null
  items: OutsourcedIssueDraftItem[]
}

export interface OutsourcedReceiptDraftItem {
  id?: string
  idx: number
  qty: string
  orderItemId: string
  unitId?: string | null
  warehouseId?: string | null
  remarks?: string | null
}

export interface OutsourcedReceiptDraft {
  companyId: string
  receiptNo?: string | null
  receiptDate?: string | null
  postingDate?: string | null
  partyType: string
  partyId: string
  remarks?: string | null
  warehouseId?: string | null
  outsourcedWarehouseId?: string | null
  debitAccountId?: string | null
  creditAccountId?: string | null
  items: OutsourcedReceiptDraftItem[]
}

/** 后端返回的权威聚合快照：表头与全部条目（委外入库快照仅含成品行）。 */
export type OutsourcedIssueSavedDraft = Row & {
  items: Row[]
}

export type OutsourcedReceiptSavedDraft = Row & {
  items: Row[]
}

/**
 * 把表单状态收口成委外发料聚合草稿。
 * 材料/单位/折算数量由后端按发料清单行重新派生，不进 wire input。
 */
export function buildOutsourcedIssueDraft(
  values: Record<string, unknown>,
  rows: Row[],
): OutsourcedIssueDraft {
  return {
    companyId: requiredString(values.companyId, '公司'),
    issueNo: nullableString(values.issueNo),
    issueDate: nullableString(values.issueDate),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    remarks: nullableString(values.remarks),
    fromWarehouseId: nullableString(values.fromWarehouseId),
    outsourcedWarehouseId: nullableString(values.outsourcedWarehouseId),
    items: rows.map((row) => ({
      ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
      idx: Number(row.idx),
      qty: requiredString(row.qty, `第${String(row.idx)}行发料数量`),
      orderItemMaterialId: requiredString(
        row.orderItemMaterialId,
        `第${String(row.idx)}行发料清单行`,
      ),
      fromWarehouseId: nullableString(row.fromWarehouseId),
      outsourcedWarehouseId: nullableString(row.outsourcedWarehouseId),
      remarks: nullableString(row.remarks),
    })),
  }
}

/**
 * 把表单状态收口成委外入库聚合草稿（头+成品行）。
 * 材料扣减/副产物行不进草稿树（carry 由后端按比例带出，独立 CRUD 维护）。
 */
export function buildOutsourcedReceiptDraft(
  values: Record<string, unknown>,
  rows: Row[],
): OutsourcedReceiptDraft {
  return {
    companyId: requiredString(values.companyId, '公司'),
    receiptNo: nullableString(values.receiptNo),
    receiptDate: nullableString(values.receiptDate),
    postingDate: nullableString(values.postingDate),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    remarks: nullableString(values.remarks),
    warehouseId: nullableString(values.warehouseId),
    outsourcedWarehouseId: nullableString(values.outsourcedWarehouseId),
    debitAccountId: nullableString(values.debitAccountId),
    creditAccountId: nullableString(values.creditAccountId),
    items: rows.map((row) => ({
      ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
      idx: Number(row.idx),
      qty: requiredString(row.qty, `第${String(row.idx)}行入库数量`),
      orderItemId: requiredString(
        row.orderItemId,
        `第${String(row.idx)}行委外订单条目`,
      ),
      unitId: nullableString(row.unitId),
      warehouseId: nullableString(row.warehouseId),
      remarks: nullableString(row.remarks),
    })),
  }
}

function wireIssueDraft(input: OutsourcedIssueDraft): OutsourcedIssueDraft {
  return {
    ...input,
    items: input.items.map((item) => ({
      ...item,
      qty: String(item.qty),
    })),
  }
}

function wireReceiptDraft(input: OutsourcedReceiptDraft): OutsourcedReceiptDraft {
  return {
    ...input,
    items: input.items.map((item) => ({
      ...item,
      qty: String(item.qty),
    })),
  }
}

/** production Hono Adapters：发料与入库各占一个明确的聚合 seam。 */
export const purchaseOutsourcedIssueDraftAdapter = aggregateDraftTransport<
  OutsourcedIssueDraft,
  OutsourcedIssueSavedDraft
>(api.purchase['outsourced-issues'], { wire: wireIssueDraft })

export const purchaseOutsourcedReceiptDraftAdapter = aggregateDraftTransport<
  OutsourcedReceiptDraft,
  OutsourcedReceiptSavedDraft
>(api.purchase['outsourced-receipts'], { wire: wireReceiptDraft })
