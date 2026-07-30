import { apiData, api } from '../api/client'
import type { Row, FilterState } from '~/components/synie-data-grid/types'
import type { ResourceClient } from './types'

export const unitClient: ResourceClient = {
  id: 'rest:basUnits',
  async query(input) {
    const x = await apiData<{ count: number; results: Row[] }>(
      api.base.units.query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: input.filter as FilterState,
        },
      }),
    )
    return { count: x.count, results: x.results as Row[] }
  },
  async get(id) {
    return (await apiData(api.base.units[':id'].$get({ param: { id } }))) as Row
  },
  async create(input) {
    return (await apiData(api.base.units.$post({ json: input as never }))) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.base.units[':id'].$patch({ param: { id }, json: input as never }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(api.base.units[':id'].$delete({ param: { id } }))
  },
}
