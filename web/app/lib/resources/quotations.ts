import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import { decimalWireInput, resourceListBody } from './resource-wire'
import type { ResourceClient, ResourceQuery } from './types'

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
  audit: {
    handler: auditSalesQuotation,
    affectedResources: ['salQuotationItems'],
  },
  void: {
    handler: voidSalesQuotation,
    affectedResources: ['salQuotationItems'],
  },
})

export const purchaseQuotationCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditPurchaseQuotation,
    affectedResources: ['purQuotationItems'],
  },
  void: {
    handler: voidPurchaseQuotation,
    affectedResources: ['purQuotationItems'],
  },
})

export const salesQuotationClient = resourceClient('salQuotations', {
  async query(input) {
    const result = await apiData(
      api.sales.quotations.query.$post({ json: resourceListBody(input) }),
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
    await apiData(
      api.sales.quotations[':id'].$delete({ param: { id } }),
    )
  },
})

export const salesQuotationItemClient = resourceClient('salQuotationItems', {
  async query(input) {
    const result = await apiData(
      api.sales['quotation-items'].query.$post({ json: resourceListBody(input) }),
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
        json: decimalWireInput(input, ['price', 'taxRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales['quotation-items'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['price', 'taxRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.sales['quotation-items'][':id'].$delete({ param: { id } }),
    )
  },
})

export const salesQuotationTierClient = resourceClient('salQuotationTiers', {
  async query(input) {
    const result = await apiData(
      api.sales['quotation-tiers'].query.$post({ json: resourceListBody(input) }),
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
        json: decimalWireInput(input, ['minQty', 'price']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales['quotation-tiers'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['minQty', 'price']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.sales['quotation-tiers'][':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseQuotationClient = resourceClient('purQuotations', {
  async query(input) {
    const result = await apiData(
      api.purchase.quotations.query.$post({ json: resourceListBody(input) }),
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
    await apiData(
      api.purchase.quotations[':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseQuotationItemClient = resourceClient('purQuotationItems', {
  async query(input) {
    const result = await apiData(
      api.purchase['quotation-items'].query.$post({ json: resourceListBody(input) }),
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
        json: decimalWireInput(input, ['price', 'taxRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['quotation-items'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['price', 'taxRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.purchase['quotation-items'][':id'].$delete({ param: { id } }),
    )
  },
})

export const purchaseQuotationTierClient = resourceClient('purQuotationTiers', {
  async query(input) {
    const result = await apiData(
      api.purchase['quotation-tiers'].query.$post({ json: resourceListBody(input) }),
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
        json: decimalWireInput(input, ['minQty', 'price']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.purchase['quotation-tiers'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['minQty', 'price']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.purchase['quotation-tiers'][':id'].$delete({ param: { id } }),
    )
  },
})
