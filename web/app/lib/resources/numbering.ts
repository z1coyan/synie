import type { ListQuery } from '@synie/shared'
import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

function queryBody(input: ResourceQuery): ListQuery {
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    } as FilterState,
  }
}

export interface NumberableResource {
  resource: string
  label: string
  prefix?: string
  fields?: NumberableField[]
}
export interface NumberableField {
  path: string
  label: string
  type: string
  name?: string
}

export const numberingRuleClient: ResourceClient = {
  id: 'rest:sysNumberingRules',
  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
          param: { name: 'sysNumberingRules' }}),
      ),
    )
  },
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.system.numbering.rules.query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.system.numbering.rules[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.system.numbering.rules.$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.system.numbering.rules[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.system.numbering.rules[':id'].$delete({ param: { id } }),
    )
  },
}

export const numberingCounterClient: ResourceClient = {
  id: 'rest:sysNumberingCounters',
  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
          param: { name: 'sysNumberingCounters' }}),
      ),
    )
  },
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.system.numbering.counters.query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.system.numbering.counters[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create() {
    throw new Error('编号计数器由取号流程自动创建')
  },
  async update(id, input) {
    return (await apiData(
      api.system.numbering.counters[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete() {
    throw new Error('编号计数器随规则自动维护')
  },
}

export async function listNumberableResources(): Promise<NumberableResource[]> {
  const result = await apiData<{ resources: NumberableResource[] }>(
    api.system.numbering.resources.$get(),
  )
  return result.resources
}
