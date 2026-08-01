import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { resourceListBody } from './resource-wire'
import type { ResourceClient, ResourceTransport } from './types'

export interface NumberableResource {
  prefix: string
  grid: string
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
  async query(input) {
    const result = await apiData(
      api.system.numbering.rules.query.$post({
        json: resourceListBody(input),
      }),
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
        json: input as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.system.numbering.rules[':id'].$patch({
        param: { id },
        json: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.system.numbering.rules[':id'].$delete({ param: { id } }),
    )
  },
}

export const numberingCounterClient = {
  id: 'rest:sysNumberingCounters',
  async query(input) {
    const result = await apiData(
      api.system.numbering.counters.query.$post({
        json: resourceListBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.system.numbering.counters[':id'].$get({ param: { id } }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.system.numbering.counters[':id'].$patch({
        param: { id },
        json: input as never,
      }),
    )) as Row
  },
} satisfies ResourceTransport

export async function listNumberableResources(): Promise<NumberableResource[]> {
  const result = await apiData(
    api.system.numbering.resources.$get(),
  )
  return result.resources
}
