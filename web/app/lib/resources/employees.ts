import { apiData, api } from '../api/client'
import type {Row, FilterState} from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type EmployeeCreate = Record<string, unknown>
type EmployeeUpdate = Record<string, unknown>

function ensureSupportedQuery(input: ResourceQuery) {
  if (input.fixedFilter || input.extraFields?.length || input.joinFields) {
    throw new Error('员工 REST 资源不支持额外字段、joinFields 或受信 fixedFilter')
  }
}

function wireEmployeeInput(input: Record<string, unknown>): Record<string, unknown> {
  const body = { ...input }
  for (const field of ['dailyWage', 'monthlyAllowance'] as const) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    body[field] = value == null || value === '' ? null : String(value)
  }
  return body
}

export const employeeClient: ResourceClient = {
  id: 'rest:hrEmployees',

  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
          param: { name: 'hrEmployees' }}),
      ),
    )
  },

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData<{ count: number; results: Row[] }>(
      api.hr.employees.query.$post({
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
      api.hr.employees[':id'].$get({
        param: { id }}),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.hr.employees.$post({
        json: wireEmployeeInput(input) as never}),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.hr.employees[':id'].$patch({
        param: { id },
        json: wireEmployeeInput(input) as never}),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      api.hr.employees[':id'].$delete({
        param: { id }}),
    )
  },
}
