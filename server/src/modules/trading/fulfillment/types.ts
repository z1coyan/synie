/** 履约（销售发货 / 采购入库）服务公开类型。 */
export interface FulfillmentHead {
  id: string
  no: string
  documentDate: string
  postingDate: string | null
  partyType: string
  partyId: string
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

/** wire 头 DTO（presentSalesHead 返回形；键集/键序/值由 meta 派生，本接口是 hc 契约锚点） */
export interface SalesHeadDto {
  id: string
  deliveryNo: string
  deliveryDate: string
  postingDate: string | null
  partyType: string
  partyId: string
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

/** wire 头 DTO（presentPurchaseHead 返回形） */
export interface PurchaseHeadDto {
  id: string
  receiptNo: string
  receiptDate: string
  postingDate: string | null
  partyType: string
  partyId: string
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

export interface FulfillmentHeadDraftInput {
  companyId: string
  no?: string | null
  documentDate?: string | null
  postingDate?: string | null
  partyType: string
  partyId: string
  remarks?: string | null
  warehouseId?: string | null
  debitAccountId: string
  creditAccountId: string
}

export interface FulfillmentHeadUpdateInput {
  no?: string
  documentDate?: string
  postingDate?: string | null
  postingDatePresent?: boolean
  partyType?: string
  partyId?: string
  remarks?: string | null
  remarksPresent?: boolean
  warehouseId?: string | null
  warehouseIdPresent?: boolean
  debitAccountId?: string
  creditAccountId?: string
}

export interface SalesDraftItemInput {
  id?: string
  idx: number
  qty: string
  orderItemId: string
  unitId?: string | null
  /** 非库存类（VIRTUAL/ASSET）行可空；STOCK 行保存时强制必填 */
  warehouseId: string | null
  remarks?: string | null
}

export interface FulfillmentItemUpdateInput {
  idx?: number
  qty?: string
  orderItemId?: string
  unitId?: string | null
  unitIdPresent?: boolean
  warehouseId?: string | null
  warehouseIdPresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
}

export interface SalesDraftPackLineInput {
  id?: string
  idx: number
  qty: string
  materialId: string
  unitId?: string | null
  remarks?: string | null
}

export interface SalesDraftPackBoxInput {
  id?: string
  lines: SalesDraftPackLineInput[]
}

export interface SalesDraftInput extends FulfillmentHeadDraftInput {
  items: SalesDraftItemInput[]
  packBoxes: SalesDraftPackBoxInput[]
}

/** 采购入库聚合草稿：表头与全部入库条目作为一个事务写入。 */
export interface PurchaseReceiptDraftInput extends FulfillmentHeadDraftInput {
  items: SalesDraftItemInput[]
}

export interface SalesDraftItemDto {
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
  remarks: string | null
  insertedAt: string
  updatedAt: string
  deliveryId: string
  companyId: string
  orderItemId: string
  materialId: string
  unitId: string
  warehouseId: string | null
  deliveryNo: string
  deliveryDate: string
  deliveryStatus: string
  partyType: string
  partyId: string
  remainingReconcilableQty: string
  returnedQty: string
  remainingReturnableQty: string
}

export interface SalesDraftPackLineDto {
  id: string
  idx: number
  packBoxId: string
  qty: string
  baseQty: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  remarks: string | null
  insertedAt: string
  updatedAt: string
  deliveryId: string
  companyId: string
  materialId: string
  unitId: string
}

export interface SalesDraftPackBoxDto {
  id: string
  boxNo: string
  insertedAt: string
  updatedAt: string
  deliveryId: string
  companyId: string
  lines: SalesDraftPackLineDto[]
}

export type SalesDraftDto = SalesHeadDto & {
  items: SalesDraftItemDto[]
  packBoxes: SalesDraftPackBoxDto[]
}

export interface PurchaseReceiptItemDto {
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
  remarks: string | null
  insertedAt: string
  updatedAt: string
  receiptId: string
  companyId: string
  orderItemId: string
  materialId: string
  unitId: string
  warehouseId: string | null
  receiptNo: string
  receiptDate: string
  receiptStatus: string
  partyType: string
  partyId: string
  remainingReconcilableQty: string
  returnedQty: string
  remainingReturnableQty: string
}

export type PurchaseReceiptDraftDto = PurchaseHeadDto & {
  items: PurchaseReceiptItemDto[]
}
