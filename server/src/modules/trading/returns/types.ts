/** 销售退货服务公开类型（镜像 fulfillment 销售侧，无装箱子树）。 */
export interface ReturnHead {
  id: string
  no: string
  documentDate: string
  postingDate: string | null
  partyType: string
  partyId: string
  currencyId: string | null
  exchangeRate: string | null
  remarks: string | null
  status: string
  auditedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  warehouseId: string | null
  debitAccountId: string
  creditAccountId: string
  createdById: string | null
  auditedById: string | null
}

export interface ReturnDraftItemInput {
  id?: string
  idx: number
  qty: string
  /** 源单行锚点（本票必填；#57 手工行放开） */
  deliveryItemId: string
  unitId?: string | null
  /** 非库存类（VIRTUAL/ASSET）行可空；STOCK 行保存时强制必填 */
  warehouseId: string | null
  remarks?: string | null
}

export interface ReturnDraftInput {
  companyId: string
  no?: string | null
  documentDate?: string | null
  postingDate?: string | null
  partyType: string
  partyId: string
  currencyId?: string | null
  exchangeRate?: string | null
  remarks?: string | null
  warehouseId?: string | null
  debitAccountId: string
  creditAccountId: string
  items: ReturnDraftItemInput[]
}

export interface ReturnItemDto {
  id: string
  idx: number
  qty: string
  baseQty: string
  materialCode: string | null
  materialName: string | null
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string | null
  orderNo: string | null
  orderQty: string | null
  orderBaseQty: string | null
  orderUnitName: string | null
  orderPrice: string | null
  orderAmount: string | null
  orderBasePrice: string | null
  orderBaseAmount: string | null
  orderTaxRate: string | null
  orderCurrencyCode: string | null
  reconciledQty: string
  remarks: string | null
  insertedAt: string
  updatedAt: string
  returnId: string
  companyId: string
  deliveryItemId: string
  orderItemId: string | null
  materialId: string | null
  unitId: string | null
  warehouseId: string | null
  returnNo: string
  returnDate: string
  returnStatus: string
  partyType: string
  partyId: string
  remainingReconcilableQty: string
}

export interface ReturnDraftDto {
  id: string
  returnNo: string
  returnDate: string
  postingDate: string | null
  partyType: string
  partyId: string
  currencyId: string | null
  exchangeRate: string | null
  remarks: string | null
  status: string
  auditedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  warehouseId: string | null
  debitAccountId: string
  creditAccountId: string
  createdById: string | null
  auditedById: string | null
  items: ReturnItemDto[]
}
