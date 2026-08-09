/** 对账单头/条目 wire DTO（与迁前 mapHeadDto/mapItemDto 对齐） */

export interface ReconciliationHead {
  id: string
  reconciliationNo: string
  reconciliationType: string
  partyType: string
  partyId: string
  postingDate: string | null
  remarks: string | null
  status: string
  insertedAt: string | null
  updatedAt: string | null
  companyId: string
  debitAccountId: string
  creditAccountId: string
  createdById: string | null
  grossTotal: string
  baseGrossTotal: string
}

export interface ReconciliationItem {
  id: string
  idx: number
  qty: string
  baseQty: string
  amount: string
  baseAmount: string
  remarks: string | null
  insertedAt: string | null
  updatedAt: string | null
  reconciliationId: string
  companyId: string
  deliveryItemId: string | null
  /** 销售退货条目来源（与 deliveryItemId 恰一；行金额取负） */
  returnItemId: string | null
  receiptItemId: string | null
  outsourcedReceiptItemId: string | null
  reconciliationNo: string
  reconciliationStatus: string
  deliveryNo?: string
  deliveryDate?: string | null
  receiptNo?: string
  receiptDate?: string | null
  materialName: string
  unitName: string
  orderCurrencyCode: string
}

export type ReconciliationDraft = ReconciliationHead & {
  items: ReconciliationItem[]
}
