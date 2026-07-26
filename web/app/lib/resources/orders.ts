import { apiClient, apiData } from '../api/client'
import type { components } from '../api/schema'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = components['schemas']['FilterState']

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

async function meta(resource: string) {
  return gridMeta(
    await apiData(
      apiClient.GET('/meta/resources/{name}', {
        params: { path: { name: resource } },
      }),
    ),
  )
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
  operations: Omit<ResourceClient, 'id' | 'meta'>,
): ResourceClient {
  return {
    id: `rest:${resource}`,
    meta: () => meta(resource),
    ...operations,
  }
}

export async function auditSalesOrder(id: string) {
  return apiData(
    apiClient.POST('/sales/orders/{id}/audit', {
      params: { path: { id } },
    }),
  )
}

export async function auditPurchaseOrder(id: string) {
  return apiData(
    apiClient.POST('/purchase/orders/{id}/audit', {
      params: { path: { id } },
    }),
  )
}

async function closeSalesOrder(id: string) {
  return apiData(
    apiClient.POST('/sales/orders/{id}/close', {
      params: { path: { id } },
    }),
  )
}

async function voidSalesOrder(id: string) {
  return apiData(
    apiClient.POST('/sales/orders/{id}/void', {
      params: { path: { id } },
    }),
  )
}

async function closePurchaseOrder(id: string) {
  return apiData(
    apiClient.POST('/purchase/orders/{id}/close', {
      params: { path: { id } },
    }),
  )
}

async function voidPurchaseOrder(id: string) {
  return apiData(
    apiClient.POST('/purchase/orders/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export const salesOrderClient = resourceClient('salOrders', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/sales/orders/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/sales/orders/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/orders', {
        body: decimalInput(input, ['exchangeRate']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/orders/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['exchangeRate']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/orders/{id}', { params: { path: { id } } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditSalesOrder(id)
      else if (key === 'close') await closeSalesOrder(id)
      else if (key === 'void') await voidSalesOrder(id)
      else throw new Error(`销售订单 REST Client 未实现动作 ${key}`)
    }
  },
})

export const salesOrderItemClient = resourceClient('salOrderItems', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/sales/order-items/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/sales/order-items/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/order-items', {
        body: decimalInput(input, ['qty', 'price', 'taxRate']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/order-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['qty', 'price', 'taxRate']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/order-items/{id}', { params: { path: { id } } }),
    )
  },
})

export const purchaseOrderClient = resourceClient('purOrders', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/orders/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/orders/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/orders', {
        body: decimalInput(input, ['exchangeRate']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/orders/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['exchangeRate']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/orders/{id}', { params: { path: { id } } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditPurchaseOrder(id)
      else if (key === 'close') await closePurchaseOrder(id)
      else if (key === 'void') await voidPurchaseOrder(id)
      else throw new Error(`采购订单 REST Client 未实现动作 ${key}`)
    }
  },
})

export const purchaseOrderItemClient = resourceClient('purOrderItems', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/order-items/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/order-items/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/order-items', {
        body: decimalInput(input, ['qty', 'price', 'taxRate']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/order-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['qty', 'price', 'taxRate']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/order-items/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const purchaseOrderItemMaterialClient = resourceClient('purOrderItemMaterials', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/order-item-materials/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/order-item-materials/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/order-item-materials', {
        body: decimalInput(input, ['quantity']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/order-item-materials/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['quantity']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/order-item-materials/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const purchaseOrderItemByproductClient = resourceClient('purOrderItemByproducts', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/order-item-byproducts/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/order-item-byproducts/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/order-item-byproducts', {
        body: decimalInput(input, ['quantity']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/order-item-byproducts/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['quantity']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/order-item-byproducts/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export async function queryPurchaseOrderDemandLines(input: {
  companyId: string
  isOutsourced: boolean
  search?: string
}) {
  const result = await apiData(
    apiClient.POST('/purchase/order-demand-lines/query', {
      body: { ...input, limit: 200 },
    }),
  )
  return result.results
}

export async function expandPurchaseOrderBom(bomId: string, qty: unknown) {
  return apiData(
    apiClient.POST('/purchase/order-bom/expand', {
      body: { bomId, qty: String(qty) },
    }),
  )
}

export async function getSalesOrderHistory(orderId: string) {
  const result = await apiData(
    apiClient.GET('/sales/orders/{id}/history', {
      params: { path: { id: orderId } },
    }),
  )
  return result.results
}

export async function getPurchaseOrderHistory(orderId: string) {
  const result = await apiData(
    apiClient.GET('/purchase/orders/{id}/history', {
      params: { path: { id: orderId } },
    }),
  )
  return result.results
}
