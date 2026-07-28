import { describe, expect, test } from 'bun:test'
import { resolveQuote, type QuoteCandidate } from './service.ts'

/**
 * 价点有效唯一键：(品种, 观测时刻, 价类) 且 is_voided=false。
 * 取价侧：同键作废后不再参与；仅未作废候选可被 resolve。
 * DB 层 23505 由 integration / verify-market-rest 覆盖。
 */
describe('价点有效唯一与取价', () => {
  const at = new Date('2026-07-01T00:00:00Z')

  test('同键作废后取价跳过，可落到更早有效点', () => {
    const candidates: QuoteCandidate[] = [
      {
        id: 'old',
        observedAt: new Date('2026-06-01T00:00:00Z'),
        priceKind: 'settlement',
        price: '90',
        isVoided: false,
      },
      {
        id: 'voided',
        observedAt: at,
        priceKind: 'settlement',
        price: '100',
        isVoided: true,
      },
      {
        id: 'rerecord',
        observedAt: at,
        priceKind: 'settlement',
        price: '101',
        isVoided: false,
      },
    ]
    const got = resolveQuote(candidates, at, 'settlement', 'settlement')
    expect(got?.id).toBe('rerecord')
    expect(got?.price).toBe('101')
  })

  test('不同价类不互相冒充', () => {
    const candidates: QuoteCandidate[] = [
      {
        id: 'last',
        observedAt: at,
        priceKind: 'last',
        price: '999',
        isVoided: false,
      },
      {
        id: 'settle',
        observedAt: new Date('2026-06-15T00:00:00Z'),
        priceKind: 'settlement',
        price: '50',
        isVoided: false,
      },
    ]
    expect(resolveQuote(candidates, at, 'settlement', 'settlement')?.id).toBe('settle')
    expect(resolveQuote(candidates, at, null, 'last')?.id).toBe('last')
  })

  test('未来观测点不参与 ≤ 取价', () => {
    const candidates: QuoteCandidate[] = [
      {
        id: 'future',
        observedAt: new Date('2026-08-01T00:00:00Z'),
        priceKind: 'settlement',
        price: '200',
        isVoided: false,
      },
    ]
    expect(resolveQuote(candidates, at, 'settlement', 'settlement')).toBeNull()
  })
})
