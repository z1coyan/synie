import { expect, test } from 'bun:test'
import { postingBudget, assertMutationBudget } from '../../lib/budget'

test('过账预算覆盖库存、总账、head 和 audit fan-out', () => {
  const plan = postingBudget(200, 100, 100)
  expect(plan.writes).toBeGreaterThan(600)
  expect(() => assertMutationBudget(plan)).not.toThrow()
})
