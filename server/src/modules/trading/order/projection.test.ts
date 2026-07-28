import { describe, expect, test } from 'bun:test'
import { decimal } from '@synie/shared'
import { maxFulfillableQty } from './projection.ts'

describe('履约容差上限 maxFulfillableQty', () => {
  test('零容差：恰好订单 base_qty', () => {
    expect(maxFulfillableQty('10', '0').equals(decimal(10))).toBe(true)
  })

  test('10% 超发：10 → 11', () => {
    expect(maxFulfillableQty('10', '0.1').equals(decimal(11))).toBe(true)
  })

  test('20% 超收与小数 base', () => {
    expect(maxFulfillableQty('5.5', '0.2').equals(decimal('6.6'))).toBe(true)
  })

  test('边界：next 等于上限通过，大于硬拦（调用方比较）', () => {
    const max = maxFulfillableQty('10', '0.1')
    expect(decimal('11').lte(max)).toBe(true)
    expect(decimal('11.01').gt(max)).toBe(true)
  })
})
