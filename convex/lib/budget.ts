import { synieError } from './errors'

export const MUTATION_BUDGET = {
  maxReads: 30_000,
  maxWrites: 15_000,
  maxReadBytes: 15 * 1024 * 1024,
  maxWriteBytes: 15 * 1024 * 1024,
} as const

export type MutationBudgetPlan = {
  label: string
  reads: number
  writes: number
  estimatedReadBytes: number
  estimatedWriteBytes: number
}

/** Conservative preflight below the platform's hard transaction limits. */
export function assertMutationBudget(plan: MutationBudgetPlan): void {
  for (const [key, value] of Object.entries(plan)) {
    if (key !== 'label' && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw synieError('validation', `${plan.label}事务预算参数不合法`)
    }
  }
  if (
    plan.reads > MUTATION_BUDGET.maxReads ||
    plan.writes > MUTATION_BUDGET.maxWrites ||
    plan.estimatedReadBytes > MUTATION_BUDGET.maxReadBytes ||
    plan.estimatedWriteBytes > MUTATION_BUDGET.maxWriteBytes
  ) {
    throw synieError('validation', `${plan.label}超出单事务安全规模`)
  }
}

export function postingBudget(lines: number, distinctStockKeys: number, partyLines: number) {
  return {
    label: '过账',
    reads: 4 * lines + distinctStockKeys + 8,
    writes: lines + 3 * distinctStockKeys + 3 * lines + 2 * partyLines + 4,
    estimatedReadBytes: (4 * lines + distinctStockKeys + 8) * 1_024,
    estimatedWriteBytes: (lines + 3 * distinctStockKeys + 3 * lines + 2 * partyLines + 4) * 1_024,
  }
}
