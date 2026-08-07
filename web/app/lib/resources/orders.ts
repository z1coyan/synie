import { apiData, api } from '../api/client'
import { createRowCommandAdapter } from './catalog/commands'
import { restTransport } from './rest-transport'

export async function auditSalesOrder(id: string) {
  return apiData(
    api.sales.orders[':id'].audit.$post({
      param: { id }}),
  )
}

export async function auditPurchaseOrder(id: string) {
  return apiData(
    api.purchase.orders[':id'].audit.$post({
      param: { id }}),
  )
}

async function closeSalesOrder(id: string) {
  return apiData(
    api.sales.orders[':id'].close.$post({
      param: { id }}),
  )
}

async function voidSalesOrder(id: string) {
  return apiData(
    api.sales.orders[':id'].void.$post({
      param: { id }}),
  )
}

async function closePurchaseOrder(id: string) {
  return apiData(
    api.purchase.orders[':id'].close.$post({
      param: { id }}),
  )
}

async function voidPurchaseOrder(id: string) {
  return apiData(
    api.purchase.orders[':id'].void.$post({
      param: { id }}),
  )
}

export const salesOrderCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditSalesOrder,
    affectedResources: ['salOrderItems'],
  },
  close: {
    handler: closeSalesOrder,
    affectedResources: ['salOrderItems'],
  },
  void: {
    handler: voidSalesOrder,
    affectedResources: ['salOrderItems'],
  },
})

export const purchaseOrderCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditPurchaseOrder,
    affectedResources: [
      'purOrderItems',
      'purOrderItemMaterials',
      'mfgDemandItems',
    ],
  },
  close: {
    handler: closePurchaseOrder,
    affectedResources: ['purOrderItems', 'purOrderItemMaterials'],
  },
  void: {
    handler: voidPurchaseOrder,
    affectedResources: [
      'purOrderItems',
      'purOrderItemMaterials',
      'mfgDemandItems',
    ],
  },
})

export const salesOrderClient = restTransport('salOrders', api.sales.orders, {
})

export const salesOrderItemClient = restTransport(
  'salOrderItems',
  api.sales['order-items'])

export const purchaseOrderClient = restTransport(
  'purOrders',
  api.purchase.orders)

export const purchaseOrderItemClient = restTransport(
  'purOrderItems',
  api.purchase['order-items'])

export const purchaseOrderItemMaterialClient = restTransport(
  'purOrderItemMaterials',
  api.purchase['order-item-materials'])

export const purchaseOrderItemByproductClient = restTransport(
  'purOrderItemByproducts',
  api.purchase['order-item-byproducts'])

export async function queryPurchaseOrderDemandLines(input: {
  companyId: string
  isOutsourced: boolean
  search?: string
}) {
  const result = await apiData(
    api.purchase['order-demand-lines'].query.$post({
      json: { ...input, limit: 200 }}),
  )
  return result.results
}

export async function expandPurchaseOrderBom(bomId: string, qty: unknown) {
  return apiData(
    api.purchase['order-bom'].expand.$post({
      json: { bomId, qty: String(qty) }}),
  )
}

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

export async function getSalesOrderHistory(orderId: string): Promise<OrderFlowHistoryRow[]> {
  const result = await apiData(
    api.sales.orders[':id'].history.$get({
      param: { id: orderId },
    }),
  )
  return result.results
}

export async function getPurchaseOrderHistory(orderId: string): Promise<OrderFlowHistoryRow[]> {
  const result = await apiData(
    api.purchase.orders[':id'].history.$get({
      param: { id: orderId },
    }),
  )
  return result.results
}
