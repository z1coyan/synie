import { unboundCommandAdapter, unboundResourceClient, unavailableResourceOperation } from './unbound'

export interface OrderFlowHistoryRow {
  flowType: string
  documentNo: string
  documentDate: string
  status: string
  companyId: string
  orderId: string
  orderItemId: string
  materialCode?: string | null
  materialName?: string | null
  materialSpec?: string | null
  customerPartNo?: string | null
  unitName?: string | null
  quantity: string
}

export interface ExpandedPurchaseBomLine {
  materialId: string
  materialCode: string
  materialName: string
  unitId: string
  unitName: string
  quantity: string
  remarks: string | null
}

export interface ExpandedPurchaseBom {
  materials: ExpandedPurchaseBomLine[]
  byproducts: ExpandedPurchaseBomLine[]
}

export interface OrderSemanticOperations {
  demandLines(input: { companyId: string; isOutsourced: boolean; search?: string }): Promise<unknown[]>
  expandBom(bomId: string, quantity: string): Promise<ExpandedPurchaseBom>
  salesHistory(orderId: string): Promise<OrderFlowHistoryRow[]>
  purchaseHistory(orderId: string): Promise<OrderFlowHistoryRow[]>
}

let semanticOperations: OrderSemanticOperations | null = null
export function activateOrderSemanticOperations(next: OrderSemanticOperations): void {
  semanticOperations = next
}
function orders(): OrderSemanticOperations {
  if (!semanticOperations) throw new Error('订单能力尚未由 Convex 应用壳装配')
  return semanticOperations
}

export const salesOrderClient = unboundResourceClient('salOrders')
export const salesOrderItemClient = unboundResourceClient('salOrderItems')
export const purchaseOrderClient = unboundResourceClient('purOrders')
export const purchaseOrderItemClient = unboundResourceClient('purOrderItems')
export const purchaseOrderItemMaterialClient = unboundResourceClient('purOrderItemMaterials')
export const purchaseOrderItemByproductClient = unboundResourceClient('purOrderItemByproducts')

export const salesOrderCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: ['salOrderItems'] },
  close: { target: 'row', affectedResources: ['salOrderItems'] },
  void: { target: 'row', affectedResources: ['salOrderItems'] },
})
export const purchaseOrderCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: ['purOrderItems', 'purOrderItemMaterials', 'mfgDemandItems'] },
  close: { target: 'row', affectedResources: ['purOrderItems', 'purOrderItemMaterials'] },
  void: { target: 'row', affectedResources: ['purOrderItems', 'purOrderItemMaterials', 'mfgDemandItems'] },
})
export const auditSalesOrder = unavailableResourceOperation
export const auditPurchaseOrder = unavailableResourceOperation

export const queryPurchaseOrderDemandLines = (input: {
  companyId: string
  isOutsourced: boolean
  search?: string
}) => orders().demandLines(input)
export const expandPurchaseOrderBom = (bomId: string, qty: unknown) =>
  orders().expandBom(bomId, String(qty))
export const getSalesOrderHistory = (orderId: string) => orders().salesHistory(orderId)
export const getPurchaseOrderHistory = (orderId: string) => orders().purchaseHistory(orderId)
