import { apiData, api } from '../api/client'
import { restTransport } from './rest-transport'

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

export const numberingRuleClient = restTransport(
  'sysNumberingRules',
  api.system.numbering.rules,
)

export const numberingCounterClient = restTransport(
  'sysNumberingCounters',
  api.system.numbering.counters,
  { capabilities: { create: false, delete: false } },
)

export async function listNumberableResources(): Promise<NumberableResource[]> {
  const result = await apiData(
    api.system.numbering.resources.$get(),
  )
  return result.resources
}
