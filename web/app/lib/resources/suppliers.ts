import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { strictResourceListBody } from './resource-wire'
import type { ResourceClient } from './types'

type SupplierCreate = Record<string, unknown>
type SupplierUpdate = Record<string, unknown>

export const supplierClient: ResourceClient = {
  id: 'rest:purSuppliers',


  async query(input) {
    const result = await apiData(
      api.purchase.suppliers.query.$post({
        json: strictResourceListBody(input, '供应商'),
      }),
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
    await apiData(
      api.purchase.suppliers[':id'].$delete({
        param: { id }}),
    )
  },
}
