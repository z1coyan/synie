import { unboundResourceClient, unavailableResourceOperation } from './unbound'

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

export const numberingRuleClient = unboundResourceClient('sysNumberingRules')
export const numberingCounterClient = unboundResourceClient('sysNumberingCounters')

/** 实际查询由 sysNumberingRules.listNumberables Convex command 执行。 */
export const listNumberableResources = unavailableResourceOperation as () =>
  Promise<NumberableResource[]>
