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
  test('fixture 约定头', () => {
    expect(fixture.rounding).toBe('half-up')
    expect(fixture.wire).toBe('string')
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  for (const tc of fixture.cases) {
    test(tc.name, () => {
      const got = deriveItemAmounts(tc.qty, tc.price, tc.rate)
      expect(got.amount.equals(decimal(tc.amount))).toBe(true)
      expect(got.basePrice.equals(decimal(tc.basePrice))).toBe(true)
      expect(got.baseAmount.equals(decimal(tc.baseAmount))).toBe(true)
      // wire 字符串
      expect(typeof got.amount.toFixed()).toBe('string')
    })
  }
})
