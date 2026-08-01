import { describe, expect, test } from 'bun:test'
import { ConvexError } from 'convex/values'
import { normalizeCurrency, normalizedKey, normalizeUnit, normalizeWarehouse } from './model'

describe('pilot resource normalization', () => {
  test('currency keeps uppercase ISO and bounded strings', () => {
    expect(normalizeCurrency({ name: ' 人民币 ', isoCode: 'CNY', symbol: ' ¥ ' })).toMatchObject({
      name: '人民币', isoCode: 'CNY', symbol: '¥', isoCodeKey: 'cny',
    })
    expect(() => normalizeCurrency({ name: '人民币', isoCode: 'cny' })).toThrow(ConvexError)
  })

  test('unit stores scale-6 bigint and enforces base ratio', () => {
    expect(normalizeUnit({ unitType: 'weight', isBase: false, name: '克', symbol: 'g', ratio: '0.001' }).ratioScaled).toBe(1_000n)
    expect(() => normalizeUnit({ unitType: 'WEIGHT', isBase: true, name: '克', symbol: 'g', ratio: '0.001' })).toThrow(ConvexError)
  })

  test('warehouse outsourced pair and opaque IDs fail closed', () => {
    expect(normalizeWarehouse({ name: 'A', companyId: 'opaque/company:1' }).companyId).toBe('opaque/company:1')
    expect(() => normalizeWarehouse({ name: 'A', companyId: 'c', isOutsourced: true })).toThrow(ConvexError)
    expect(normalizedKey(' ＡBc ')).toBe('abc')
  })
})
