import { api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { aggregateDraftTransport } from './aggregate-draft-transport'

export type ReconciliationSide = 'sales' | 'purchase'

export interface ReconciliationDraftItem {
  id?: string
  idx: number
  qty: string
  /** 销售侧来源：发货条目 */
  deliveryItemId?: string | null
  /** 采购侧来源（二选一）：采购入库条目 / 委外入库条目 */
  receiptItemId?: string | null
  outsourcedReceiptItemId?: string | null
  remarks?: string | null
}

export interface ReconciliationDraft {
  companyId: string
  reconciliationNo?: string | null
  reconciliationType: string
  partyType: string
  partyId: string
  debitAccountId?: string | null
  creditAccountId?: string | null
  remarks?: string | null
  items: ReconciliationDraftItem[]
}

/** 后端返回的权威聚合快照：表头与全部对账条目。 */
export type ReconciliationSavedDraft = Row & {
  items: Row[]
}

function nullableString(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

function requiredString(value: unknown, label: string): string {
  const result = nullableString(value)
  if (result == null) throw new Error(`${label}不能为空`)
  return result
}

/**
 * 把表单状态收口成对账聚合草稿。
 * 金额/baseQty 等快照由后端按来源条目重新派生，不进 wire input。
 */
export function buildReconciliationDraft(
  side: ReconciliationSide,
  values: Record<string, unknown>,
  rows: Row[],
): ReconciliationDraft {
  return {
    companyId: requiredString(values.companyId, '公司'),
    reconciliationNo: nullableString(values.reconciliationNo),
    reconciliationType: requiredString(values.reconciliationType, '对账类型'),
    partyType: requiredString(values.partyType, '对手类型'),
    partyId: requiredString(values.partyId, '对手'),
    debitAccountId: nullableString(values.debitAccountId),
    creditAccountId: nullableString(values.creditAccountId),
    remarks: nullableString(values.remarks),
    items: rows.map((row) => {
      const idx = Number(row.idx)
      const base = {
        ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
        idx,
        qty: requiredString(row.qty, `第${String(idx)}行对账数量`),
        remarks: nullableString(row.remarks),
      }
      if (side === 'sales') {
        return {
          ...base,
          deliveryItemId: requiredString(
            row.deliveryItemId,
            `第${String(idx)}行发货条目`,
          ),
        }
      }
      const receiptItemId = nullableString(row.receiptItemId)
      const outsourcedReceiptItemId = nullableString(row.outsourcedReceiptItemId)
      if ((receiptItemId == null) === (outsourcedReceiptItemId == null)) {
        throw new Error(`第${String(idx)}行入库条目必须二选一`)
      }
      return { ...base, receiptItemId, outsourcedReceiptItemId }
    }),
  }
}

function wireDraft(input: ReconciliationDraft): ReconciliationDraft {
  return {
    ...input,
    items: input.items.map((item) => ({
      ...item,
      qty: String(item.qty),
    })),
  }
}

/** production Hono Adapters：销售与采购各占一个明确的聚合 seam。 */
export const salesReconciliationDraftAdapter = aggregateDraftTransport<
  ReconciliationDraft,
  ReconciliationSavedDraft
>(api.sales.reconciliations, { wire: wireDraft })

export const purchaseReconciliationDraftAdapter = aggregateDraftTransport<
  ReconciliationDraft,
  ReconciliationSavedDraft
>(api.purchase.reconciliations, { wire: wireDraft })
