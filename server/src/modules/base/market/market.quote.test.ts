import { describe, expect, test } from 'bun:test'
import { pastSettlementWindow } from './fetch.ts'
import { resolveQuote, type QuoteCandidate } from './service.ts'

function point(
  id: string,
  at: string,
  kind: string,
  price: string,
  isVoided = false,
): QuoteCandidate {
  return {
    id,
    observedAt: new Date(at),
    priceKind: kind,
    price,
    isVoided,
  }
}

describe('取价 resolveQuote', () => {
  const candidates = [
    point('a', '2026-07-01T00:00:00Z', 'settlement', '100'),
    point('b', '2026-07-02T00:00:00Z', 'settlement', '101'),
    point('c', '2026-07-03T00:00:00Z', 'last', '999'),
    point('d', '2026-07-04T00:00:00Z', 'settlement', '102', true),
    point('e', '2026-07-05T00:00:00Z', 'settlement', '103'),
  ]

  test('≤ 目标时点最近有效价点', () => {
    const got = resolveQuote(candidates, new Date('2026-07-03T12:00:00Z'), 'settlement', 'last')
    expect(got?.id).toBe('b')
    expect(got?.price).toBe('101')
  })

  test('价类缺省回落品种默认', () => {
    const got = resolveQuote(candidates, new Date('2026-07-10T00:00:00Z'), null, 'last')
    expect(got?.id).toBe('c')
  })

  test('作废点不参与取价，可取更早有效点', () => {
    const got = resolveQuote(
      candidates,
      new Date('2026-07-04T12:00:00Z'),
      'SETTLEMENT',
      'settlement',
    )
    expect(got?.id).toBe('b')
  })

  test('目标时点前无点返回 null', () => {
    expect(
      resolveQuote(candidates, new Date('2025-01-01T00:00:00Z'), 'settlement', 'settlement'),
    ).toBeNull()
  })

  test('精确等于观测时刻可取', () => {
    const got = resolveQuote(
      candidates,
      new Date('2026-07-02T00:00:00Z'),
      'settlement',
      'settlement',
    )
    expect(got?.id).toBe('b')
  })
})

describe('pastSettlementWindow', () => {
  test('上海 15:29 未进窗口，15:30 进入', () => {
    // 15:29 上海 = 07:29 UTC
    expect(pastSettlementWindow(new Date(Date.UTC(2026, 6, 17, 7, 29, 0)))).toBe(false)
    expect(pastSettlementWindow(new Date(Date.UTC(2026, 6, 17, 7, 30, 0)))).toBe(true)
  })
})
