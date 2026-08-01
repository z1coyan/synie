import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decimal } from '@synie/shared'
import { deriveItemAmounts } from './amounts.ts'

interface Fixture {
  version: number
  rounding: string
  wire: string
  cases: Array<{
    name: string
    qty: string
    price: string
    rate: string
    amount: string
    baseAmount: string
    basePrice: string
  }>
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, 'testdata/amount_chain.json'), 'utf8'),
) as Fixture

describe('订单金额链 golden', () => {
  test('fixture 约定头（2/4/6 档）', () => {
    expect(fixture.rounding).toBe('half-up')
    expect(fixture.wire).toBe('string')
    expect(fixture.cases.length).toBeGreaterThanOrEqual(2)
    const scales = (fixture as { scales?: { amount: number; basePrice: number; baseQty: number } }).scales
    if (scales) {
      expect(scales.amount).toBe(2)
      expect(scales.basePrice).toBe(4)
      expect(scales.baseQty).toBe(6)
    }
  })

  for (const tc of fixture.cases) {
    test(tc.name, () => {
      const got = deriveItemAmounts(tc.qty, tc.price, tc.rate)
      expect(got.amount.equals(decimal(tc.amount))).toBe(true)
      expect(got.basePrice.equals(decimal(tc.basePrice))).toBe(true)
      expect(got.baseAmount.equals(decimal(tc.baseAmount))).toBe(true)
      // wire 字符串；金额 2 位、本币单价 4 位
      expect(got.amount.toFixed(2)).toBe(decimal(tc.amount).toFixed(2))
      expect(got.basePrice.toFixed(4)).toBe(decimal(tc.basePrice).toFixed(4))
    })
  }
})
