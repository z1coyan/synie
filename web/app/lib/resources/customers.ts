import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { strictResourceListBody } from './resource-wire'
import type { ResourceClient } from './types'

type CustomerCreate = Record<string, unknown>
type CustomerUpdate = Record<string, unknown>

export const customerClient: ResourceClient = {
  id: 'rest:salCustomers',


  async query(input) {
    const result = await apiData(
      api.sales.customers.query.$post({
        json: strictResourceListBody(input, '客户'),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.sales.customers[':id'].$get({
        param: { id }}),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.sales.customers.$post({
        json: input as never}),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.sales.customers[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },

  async delete(id) {
    await apiData(
      api.sales.customers[':id'].$delete({
        param: { id }}),
    )
  },
}
