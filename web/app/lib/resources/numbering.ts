import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

function queryBody(input: ResourceQuery): components['schemas']['ListQuery'] {
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    } as components['schemas']['FilterState'],
  }
}

export type NumberableResource = components['schemas']['NumberableResource']
export type NumberableField = components['schemas']['NumberableField']

export const numberingRuleClient: ResourceClient = {
  id: 'rest:sysNumberingRules',
  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'sysNumberingRules' } },
        }),
      ),
    )
  },
  async query(input) {
    const result = await apiData(
      apiClient.POST('/system/numbering/rules/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/system/numbering/rules/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/system/numbering/rules', {
        body: input as components['schemas']['NumberingRuleCreate'],
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/system/numbering/rules/{id}', {
        params: { path: { id } },
        body: input as components['schemas']['NumberingRuleUpdate'],
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/system/numbering/rules/{id}', { params: { path: { id } } }),
    )
  },
}

export const numberingCounterClient: ResourceClient = {
  id: 'rest:sysNumberingCounters',
  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'sysNumberingCounters' } },
        }),
      ),
    )
  },
  async query(input) {
    const result = await apiData(
      apiClient.POST('/system/numbering/counters/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/system/numbering/counters/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create() {
    throw new Error('编号计数器由取号流程自动创建')
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/system/numbering/counters/{id}', {
        params: { path: { id } },
        body: input as components['schemas']['NumberingCounterUpdate'],
      }),
    )) as Row
  },
  async delete() {
    throw new Error('编号计数器随规则自动维护')
  },
}

export async function listNumberableResources(): Promise<NumberableResource[]> {
  const result = await apiData(apiClient.GET('/system/numbering/resources'))
  return result.resources
}
