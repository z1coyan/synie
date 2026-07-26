import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type EmployeeCreate = components['schemas']['EmployeeCreate']
type EmployeeUpdate = components['schemas']['EmployeeUpdate']

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
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'hrEmployees' } },
        }),
      ),
    )
  },

  async query(input) {
    ensureSupportedQuery(input)
    const result = await apiData(
      apiClient.POST('/hr/employees/query', {
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
    return (await apiData(
      apiClient.GET('/hr/employees/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      apiClient.POST('/hr/employees', {
        body: wireEmployeeInput(input) as EmployeeCreate,
      }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/hr/employees/{id}', {
        params: { path: { id } },
        body: wireEmployeeInput(input) as EmployeeUpdate,
      }),
    )) as Row
  },

  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/hr/employees/{id}', {
        params: { path: { id } },
      }),
    )
  },
}
