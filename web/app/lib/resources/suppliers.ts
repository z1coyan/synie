import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type SupplierCreate = components['schemas']['SupplierCreate']
type SupplierUpdate = components['schemas']['SupplierUpdate']

function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('供应商 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

export const supplierClient: ResourceClient = {
  id: 'rest:purSuppliers',

  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'purSuppliers' } },
        }),
      ),
    )
  },

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData(
      apiClient.POST('/purchase/suppliers/query', {
        body: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: input.filter as components['schemas']['FilterState'],
        },
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/suppliers/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/suppliers', {
        body: input as SupplierCreate,
      }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/suppliers/{id}', {
        params: { path: { id } },
        body: input as SupplierUpdate,
      }),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/suppliers/{id}', {
        params: { path: { id } },
      }),
    )
  },
}
