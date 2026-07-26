import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = components['schemas']['FilterState']
type QuotationCreate = components['schemas']['QuotationCreate']
type QuotationUpdate = components['schemas']['QuotationUpdate']
type QuotationItemCreate = components['schemas']['QuotationItemCreate']
type QuotationItemUpdate = components['schemas']['QuotationItemUpdate']
type QuotationTierCreate = components['schemas']['QuotationTierCreate']
type QuotationTierUpdate = components['schemas']['QuotationTierUpdate']

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

function decimalInput(
  input: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const result = { ...input }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    result[field] = value == null || value === '' ? null : String(value)
  }
  return result
}

interface ClientOperations {
  query(input: ResourceQuery): Promise<{ count: number; results: Row[] }>
  get(id: string): Promise<Row>
  create(input: Record<string, unknown>): Promise<Row>
  update(id: string, input: Record<string, unknown>): Promise<Row>
  delete(id: string): Promise<void>
  action?: (key: string, ids: string[]) => Promise<void>
}

function resourceClient(
  resource: string,
  operations: ClientOperations,
): ResourceClient {
  return {
    id: `rest:${resource}`,
    meta: () => meta(resource),
    ...operations,
  }
}

export async function auditSalesQuotation(id: string) {
  return apiData(
    apiClient.POST('/sales/quotations/{id}/audit', {
      params: { path: { id } },
    }),
  )
}

export async function voidSalesQuotation(id: string) {
  return apiData(
    apiClient.POST('/sales/quotations/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export async function auditPurchaseQuotation(id: string) {
  return apiData(
    apiClient.POST('/purchase/quotations/{id}/audit', {
      params: { path: { id } },
    }),
  )
}

export async function voidPurchaseQuotation(id: string) {
  return apiData(
    apiClient.POST('/purchase/quotations/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export const salesQuotationClient = resourceClient('salQuotations', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/sales/quotations/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/sales/quotations/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/quotations', { body: input as QuotationCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/quotations/{id}', {
        params: { path: { id } },
        body: input as QuotationUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/quotations/{id}', { params: { path: { id } } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditSalesQuotation(id)
      else if (key === 'void') await voidSalesQuotation(id)
      else throw new Error(`销售报价 REST Client 未实现动作 ${key}`)
    }
  },
})

export const salesQuotationItemClient = resourceClient('salQuotationItems', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/sales/quotation-items/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/sales/quotation-items/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/quotation-items', {
        body: decimalInput(input, ['price', 'taxRate']) as QuotationItemCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/quotation-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['price', 'taxRate']) as QuotationItemUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/quotation-items/{id}', { params: { path: { id } } }),
    )
  },
})

export const salesQuotationTierClient = resourceClient('salQuotationTiers', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/sales/quotation-tiers/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/sales/quotation-tiers/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/quotation-tiers', {
        body: decimalInput(input, ['minQty', 'price']) as QuotationTierCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/quotation-tiers/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['minQty', 'price']) as QuotationTierUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/quotation-tiers/{id}', { params: { path: { id } } }),
    )
  },
})

export const purchaseQuotationClient = resourceClient('purQuotations', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/quotations/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/quotations/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/quotations', { body: input as QuotationCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/quotations/{id}', {
        params: { path: { id } },
        body: input as QuotationUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/quotations/{id}', { params: { path: { id } } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditPurchaseQuotation(id)
      else if (key === 'void') await voidPurchaseQuotation(id)
      else throw new Error(`采购报价 REST Client 未实现动作 ${key}`)
    }
  },
})

export const purchaseQuotationItemClient = resourceClient('purQuotationItems', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/quotation-items/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/quotation-items/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/quotation-items', {
        body: decimalInput(input, ['price', 'taxRate']) as QuotationItemCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/quotation-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['price', 'taxRate']) as QuotationItemUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/quotation-items/{id}', { params: { path: { id } } }),
    )
  },
})

export const purchaseQuotationTierClient = resourceClient('purQuotationTiers', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/quotation-tiers/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/quotation-tiers/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/quotation-tiers', {
        body: decimalInput(input, ['minQty', 'price']) as QuotationTierCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/quotation-tiers/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['minQty', 'price']) as QuotationTierUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/quotation-tiers/{id}', { params: { path: { id } } }),
    )
  },
})
