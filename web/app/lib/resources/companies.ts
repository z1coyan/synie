import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { strictResourceListBody } from './resource-wire'
import type { ResourceClient } from './types'

type CompanyCreate = Record<string, unknown>
type CompanyUpdate = Record<string, unknown>

export const companyClient: ResourceClient = {
  id: 'rest:basCompanies',

  async query(input) {
    const result = await apiData(api.base.companies.query.$post({
      json: strictResourceListBody(input, '公司'),
    }))
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
    await apiData(api.base.companies[':id'].$delete({
      param: { id }}))
  },
}
