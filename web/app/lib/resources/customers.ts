import { apiData, api } from '../api/client'
import type {Row, FilterState} from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type CustomerCreate = Record<string, unknown>
type CustomerUpdate = Record<string, unknown>

function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('客户 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

export const customerClient: ResourceClient = {
  id: 'rest:salCustomers',

  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
          param: { name: 'salCustomers' }}),
      ),
    )
  },

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales.customers.query.$post({
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
    await apiData<void>(
      api.sales.customers[':id'].$delete({
        param: { id }}),
    )
  },
}
