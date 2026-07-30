import { apiData, api } from '../api/client'
import type {Row, FilterState} from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'

type CompanyCreate = Record<string, unknown>
type CompanyUpdate = Record<string, unknown>

function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('公司 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

export const companyClient: ResourceClient = {
  id: 'rest:basCompanies',

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData<{ count: number; results: Row[] }>(api.base.companies.query.$post({
      json: {
        limit: input.limit,
        offset: input.offset,
        search: input.search || undefined,
        sort: input.sort ?? undefined,
        filter: input.filter as FilterState} }))
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return await apiData(api.base.companies[':id'].$get({
      param: { id }})) as Row
  },

  async create(input) {
    return await apiData(api.base.companies.$post({
      json: input as never})) as never
  },

  async update(id, input) {
    return await apiData(api.base.companies[':id'].$patch({
      param: { id }, json: input as never})) as never
  },

  async delete(id) {
    await apiData<void>(api.base.companies[':id'].$delete({
      param: { id }}))
  },
}
