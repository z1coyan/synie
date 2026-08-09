/** 退货（销售/采购）服务公开类型（镜像 fulfillment，无装箱子树）。 */
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
  /** 源单行锚点（销售=发货条目 / 采购=入库条目）；留空即手工行（手填物料/价税） */
  deliveryItemId?: string | null
  receiptItemId?: string | null
  /** 手工行必填；源单行由来源快照覆盖 */
  materialId?: string | null
  /** 原币含税单价：手工行手填；源单行随快照 */
  orderPrice?: string | null
  /** 税率：手工行手填；源单行随快照 */
  orderTaxRate?: string | null
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
  /** 销售侧=发货条目锚点；采购侧恒 null */
  deliveryItemId: string | null
  /** 采购侧=入库条目锚点；销售侧恒 null */
  receiptItemId: string | null
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
