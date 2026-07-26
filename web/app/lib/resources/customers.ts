import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type CustomerCreate = components['schemas']['CustomerCreate']
type CustomerUpdate = components['schemas']['CustomerUpdate']

function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('客户 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

export const customerClient: ResourceClient = {
  id: 'rest:salCustomers',

  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'salCustomers' } },
        }),
      ),
    )
  },

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData(
      apiClient.POST('/sales/customers/query', {
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
      apiClient.GET('/sales/customers/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/customers', {
        body: input as CustomerCreate,
      }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/customers/{id}', {
        params: { path: { id } },
        body: input as CustomerUpdate,
      }),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/customers/{id}', {
        params: { path: { id } },
      }),
    )
  },
}
