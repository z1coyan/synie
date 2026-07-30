import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = FilterState

function queryBody(input: ResourceQuery) {
  const filter = {
    ...(input.filter ?? {}),
    ...((input.fixedFilter ?? {}) as FilterState),
  }
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: filter as FilterDocument,
  }
}

function decimalInput(input: Record<string, unknown>, fields: readonly string[]) {
  const result = { ...input }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    result[field] = value == null || value === '' ? null : String(value)
  }
  return result
}

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
  audit: auditSalesOrder,
  close: closeSalesOrder,
  void: voidSalesOrder,
})

export const purchaseOrderCommandAdapter = createRowCommandAdapter({
  audit: auditPurchaseOrder,
  close: closePurchaseOrder,
  void: voidPurchaseOrder,
})

export const salesOrderClient = resourceClient('salOrders', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales.orders.query.$post({ json: queryBody(input) }),
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
        json: decimalInput(input, ['exchangeRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales.orders[':id'].$patch({
        param: { id },
        json: decimalInput(input, ['exchangeRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.sales.orders[':id'].$delete({ param: { id } }),
    )
  },
})

export const salesOrderItemClient = resourceClient('salOrderItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales['order-items'].query.$post({ json: queryBody(input) }),
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
        json: decimalInput(input, ['qty', 'price', 'taxRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales['order-items'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['qty', 'price', 'taxRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.sales['order-items'][':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseOrderClient = resourceClient('purOrders', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase.orders.query.$post({ json: queryBody(input) }),
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
        json: decimalInput(input, ['exchangeRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase.orders[':id'].$patch({
        param: { id },
        json: decimalInput(input, ['exchangeRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.purchase.orders[':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseOrderItemClient = resourceClient('purOrderItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase['order-items'].query.$post({ json: queryBody(input) }),
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
        json: decimalInput(input, ['qty', 'price', 'taxRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['order-items'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['qty', 'price', 'taxRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.purchase['order-items'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const purchaseOrderItemMaterialClient = resourceClient('purOrderItemMaterials', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase['order-item-materials'].query.$post({
        json: queryBody(input)}),
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
        json: decimalInput(input, ['quantity']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['order-item-materials'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['quantity']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.purchase['order-item-materials'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const purchaseOrderItemByproductClient = resourceClient('purOrderItemByproducts', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase['order-item-byproducts'].query.$post({
        json: queryBody(input)}),
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
        json: decimalInput(input, ['quantity']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['order-item-byproducts'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['quantity']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
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
  const result = await apiData<{ count: number; results: Row[] }>(
    api.purchase['order-demand-lines'].query.$post({
      json: { ...input, limit: 200 }}),
  )
  return result.results
}

export async function expandPurchaseOrderBom(bomId: string, qty: unknown) {
  return apiData<{ materials: Array<Record<string, unknown>>; byproducts: Array<Record<string, unknown>> }>(
    api.purchase['order-bom'].expand.$post({
      json: { bomId, qty: String(qty) }}),
  )
}

export interface OrderFlowHistoryRow {
  flowType: string
  voucherNo: string
  voucherDate: string
  status: string
  materialCode?: string | null
  materialName?: string | null
  materialSpec?: string | null
  customerPartNo?: string | null
  unitName?: string | null
  qty?: string | null
}

export async function getSalesOrderHistory(orderId: string): Promise<OrderFlowHistoryRow[]> {
  const result = await apiData<{ results: OrderFlowHistoryRow[] }>(
    api.sales.orders[':id'].history.$get({
      param: { id: orderId },
    }),
  )
  return result.results
}

export async function getPurchaseOrderHistory(orderId: string): Promise<OrderFlowHistoryRow[]> {
  const result = await apiData<{ results: OrderFlowHistoryRow[] }>(
    api.purchase.orders[':id'].history.$get({
      param: { id: orderId },
    }),
  )
  return result.results
}
