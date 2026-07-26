import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type CurrencyCreate = components['schemas']['CurrencyCreate']
type CurrencyUpdate = components['schemas']['CurrencyUpdate']
function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('币种 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

export const currencyClient: ResourceClient = {
  id: 'rest:basCurrencies',

  async meta() {
    const document = await apiData(
      apiClient.GET('/meta/resources/{name}', { params: { path: { name: 'basCurrencies' } } }),
    )
    return gridMeta(document)
  },

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData(
      apiClient.POST('/base/currencies/query', {
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
    const result = await apiData(
      apiClient.GET('/base/currencies/{id}', { params: { path: { id } } }),
    )
    return result as Row
  },

  async create(input) {
    return (await apiData(
      apiClient.POST('/base/currencies', { body: input as CurrencyCreate }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/base/currencies/{id}', {
        params: { path: { id } },
        body: input as CurrencyUpdate,
      }),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/base/currencies/{id}', { params: { path: { id } } }),
    )
  },
}
