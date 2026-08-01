import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { strictResourceListBody } from './resource-wire'
import type { ResourceClient } from './types'

type CurrencyCreate = Record<string, unknown>
type CurrencyUpdate = Record<string, unknown>

export const currencyClient: ResourceClient = {
  id: 'rest:basCurrencies',


  async query(input) {
    const result = await apiData(
      api.base.currencies.query.$post({
        json: strictResourceListBody(input, '币种'),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    const result = await apiData(
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
    await apiData(
      api.base.currencies[':id'].$delete({ param: { id } }),
    )
  },
}
