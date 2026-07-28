import { describe, expect, test } from 'bun:test'
import {
  decimal,
  isDecimalString,
  roundAmount,
  roundBasePrice,
  roundBaseQty,
  toDecimalString,
} from './decimal.ts'

describe('decimal 金额纪律', () => {
  test('half-up 舍入（half away from zero）', () => {
    expect(roundAmount('1.005') as string).toBe('1.01')
    expect(roundAmount('2.675') as string).toBe('2.68')
    expect(roundAmount('-1.005') as string).toBe('-1.01')
    expect(roundAmount('1.004') as string).toBe('1.00')
    expect(roundAmount('0') as string).toBe('0.00')
  })

  test('精度档位', () => {
    expect(roundBasePrice('12.34567') as string).toBe('12.3457')
    expect(roundBaseQty('1.0000005') as string).toBe('1.000001')
    expect(roundBaseQty('3') as string).toBe('3.000000')
  })

  test('金额链：amount = round(qty * price, 2)，base = round(amount * rate, 2)', () => {
    const qty = decimal('3')
    const price = decimal('9.995')
    const amount = roundAmount(qty.mul(price))
    expect(amount as string).toBe('29.99')
    const base = roundAmount(decimal(amount).mul('6.7891'))
    expect(base as string).toBe('203.61')
  })

  test('定点输出不用科学计数法', () => {
    expect(toDecimalString(decimal('12345678901234567890.123')) as string).toBe('12345678901234567890.123')
    expect(toDecimalString(decimal('0.000001')) as string).toBe('0.000001')
  })

  test('isDecimalString', () => {
    expect(isDecimalString('123.45')).toBe(true)
    expect(isDecimalString('-7')).toBe(true)
    expect(isDecimalString('1e5')).toBe(false)
    expect(isDecimalString('abc')).toBe(false)
    expect(isDecimalString('')).toBe(false)
  })
})
