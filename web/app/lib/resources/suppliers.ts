import { apiData, api } from '../api/client'
import type {Row, FilterState} from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'

type SupplierCreate = Record<string, unknown>
type SupplierUpdate = Record<string, unknown>

function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('供应商 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

export const supplierClient: ResourceClient = {
  id: 'rest:purSuppliers',


  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData<{ count: number; results: Row[] }>(
      api.purchase.suppliers.query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: input.filter as FilterState} }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.purchase.suppliers[':id'].$get({
        param: { id }}),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.purchase.suppliers.$post({
        json: input as never}),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.purchase.suppliers[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      api.purchase.suppliers[':id'].$delete({
        param: { id }}),
    )
  },
}
