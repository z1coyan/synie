import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import { decimalWireInput, resourceListBody } from './resource-wire'
import type { ResourceClient } from './types'

function resourceClient(
  resource: string,
  operations: Omit<ResourceClient, 'id'>,
): ResourceClient {
  return {
    id: `rest:${resource}`,
        ...operations,
  }
}

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

export const salesOrderClient = resourceClient('salOrders', {
  async query(input) {
    const result = await apiData(
      api.sales.orders.query.$post({ json: resourceListBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales.orders[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.sales.orders.$post({
        json: decimalWireInput(input, ['exchangeRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales.orders[':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['exchangeRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.sales.orders[':id'].$delete({ param: { id } }),
    )
  },
})

export const salesOrderItemClient = resourceClient('salOrderItems', {
  async query(input) {
    const result = await apiData(
      api.sales['order-items'].query.$post({ json: resourceListBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales['order-items'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.sales['order-items'].$post({
        json: decimalWireInput(input, ['qty', 'price', 'taxRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales['order-items'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['qty', 'price', 'taxRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.sales['order-items'][':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseOrderClient = resourceClient('purOrders', {
  async query(input) {
    const result = await apiData(
      api.purchase.orders.query.$post({ json: resourceListBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase.orders[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase.orders.$post({
        json: decimalWireInput(input, ['exchangeRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase.orders[':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['exchangeRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.purchase.orders[':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseOrderItemClient = resourceClient('purOrderItems', {
  async query(input) {
    const result = await apiData(
      api.purchase['order-items'].query.$post({ json: resourceListBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase['order-items'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase['order-items'].$post({
        json: decimalWireInput(input, ['qty', 'price', 'taxRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['order-items'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['qty', 'price', 'taxRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.purchase['order-items'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const purchaseOrderItemMaterialClient = resourceClient('purOrderItemMaterials', {
  async query(input) {
    const result = await apiData(
      api.purchase['order-item-materials'].query.$post({
        json: resourceListBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase['order-item-materials'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase['order-item-materials'].$post({
        json: decimalWireInput(input, ['quantity']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['order-item-materials'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['quantity']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.purchase['order-item-materials'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const purchaseOrderItemByproductClient = resourceClient('purOrderItemByproducts', {
  async query(input) {
    const result = await apiData(
      api.purchase['order-item-byproducts'].query.$post({
        json: resourceListBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase['order-item-byproducts'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase['order-item-byproducts'].$post({
        json: decimalWireInput(input, ['quantity']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['order-item-byproducts'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['quantity']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.purchase['order-item-byproducts'][':id'].$delete({
        param: { id }}),
    )
  },
})

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
