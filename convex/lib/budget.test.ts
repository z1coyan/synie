import { expect, test } from 'bun:test'
import { assertMutationBudget, postingBudget } from './budget'

test('posting budget 在任何写入前拒绝过大单据', () => {
  expect(() => assertMutationBudget(postingBudget(10, 5, 2))).not.toThrow()
  expect(() => assertMutationBudget(postingBudget(20_000, 20_000, 20_000))).toThrow('超出单事务安全规模')
})
