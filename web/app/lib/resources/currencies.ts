import { apiData, api } from '../api/client'
import type {Row, FilterState} from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type CurrencyCreate = Record<string, unknown>
type CurrencyUpdate = Record<string, unknown>
function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('币种 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

export const currencyClient: ResourceClient = {
  id: 'rest:basCurrencies',

  async meta() {
    const document = await apiData<import('@synie/shared').ResourceMetaDocument>(
      api.meta.resources[':name'].$get({ param: { name: 'basCurrencies' } }),
    )
    return gridMeta(document)
  },

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData<{ count: number; results: Row[] }>(
      api.base.currencies.query.$post({
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
    const result = await apiData<{ count?: number; results?: Row[]; resources?: unknown[] }>(
      api.base.currencies[':id'].$get({ param: { id } }),
    )
    return result as Row
  },

  async create(input) {
    return (await apiData(
      api.base.currencies.$post({ json: input as never }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.base.currencies[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      api.base.currencies[':id'].$delete({ param: { id } }),
    )
  },
}
