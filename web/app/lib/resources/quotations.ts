import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = FilterState
type QuotationCreate = Record<string, unknown>
type QuotationUpdate = Record<string, unknown>
type QuotationItemCreate = Record<string, unknown>
type QuotationItemUpdate = Record<string, unknown>
type QuotationTierCreate = Record<string, unknown>
type QuotationTierUpdate = Record<string, unknown>

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
}

function resourceClient(
  resource: string,
  operations: ClientOperations,
): ResourceClient {
  return {
    id: `rest:${resource}`,
        ...operations,
  }
}

export async function auditSalesQuotation(id: string) {
  return apiData(
    api.sales.quotations[':id'].audit.$post({
      param: { id }}),
  )
}

export async function voidSalesQuotation(id: string) {
  return apiData(
    api.sales.quotations[':id'].void.$post({
      param: { id }}),
  )
}

export async function auditPurchaseQuotation(id: string) {
  return apiData(
    api.purchase.quotations[':id'].audit.$post({
      param: { id }}),
  )
}

export async function voidPurchaseQuotation(id: string) {
  return apiData(
    api.purchase.quotations[':id'].void.$post({
      param: { id }}),
  )
}

export const salesQuotationCommandAdapter = createRowCommandAdapter({
  audit: auditSalesQuotation,
  void: voidSalesQuotation,
})

export const purchaseQuotationCommandAdapter = createRowCommandAdapter({
  audit: auditPurchaseQuotation,
  void: voidPurchaseQuotation,
})

export const salesQuotationClient = resourceClient('salQuotations', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales.quotations.query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales.quotations[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.sales.quotations.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales.quotations[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.sales.quotations[':id'].$delete({ param: { id } }),
    )
  },
})

export const salesQuotationItemClient = resourceClient('salQuotationItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales['quotation-items'].query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales['quotation-items'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.sales['quotation-items'].$post({
        json: decimalInput(input, ['price', 'taxRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales['quotation-items'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['price', 'taxRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.sales['quotation-items'][':id'].$delete({ param: { id } }),
    )
  },
})

export const salesQuotationTierClient = resourceClient('salQuotationTiers', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales['quotation-tiers'].query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales['quotation-tiers'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.sales['quotation-tiers'].$post({
        json: decimalInput(input, ['minQty', 'price']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales['quotation-tiers'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['minQty', 'price']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.sales['quotation-tiers'][':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseQuotationClient = resourceClient('purQuotations', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase.quotations.query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase.quotations[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase.quotations.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase.quotations[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.purchase.quotations[':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseQuotationItemClient = resourceClient('purQuotationItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase['quotation-items'].query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase['quotation-items'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase['quotation-items'].$post({
        json: decimalInput(input, ['price', 'taxRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['quotation-items'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['price', 'taxRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.purchase['quotation-items'][':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseQuotationTierClient = resourceClient('purQuotationTiers', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase['quotation-tiers'].query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.purchase['quotation-tiers'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.purchase['quotation-tiers'].$post({
        json: decimalInput(input, ['minQty', 'price']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['quotation-tiers'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['minQty', 'price']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.purchase['quotation-tiers'][':id'].$delete({ param: { id } }),
    )
  },
})
