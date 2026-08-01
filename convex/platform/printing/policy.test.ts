import { describe, expect, test } from 'bun:test'
import {
  printJobClaimDisposition,
  printJobRetryDelay,
  printJobShouldRetry,
} from './policy'

const now = 1_700_000_000_000
const queued = {
  status: 'queued',
  attempts: 0,
  maxAttempts: 5,
  nextAttemptAt: now,
  leaseExpiresAt: null,
  expiresAt: now + 86_400_000,
}

describe('transient print job policy', () => {
  test('claims queued/retryable work and reclaims only an expired running lease', () => {
    expect(printJobClaimDisposition(queued, now)).toBe('claim')
    expect(printJobClaimDisposition({ ...queued, status: 'retryable' }, now)).toBe('claim')
    expect(printJobClaimDisposition({
      ...queued, status: 'running', attempts: 1, leaseExpiresAt: now - 1,
    }, now)).toBe('claim')
    expect(printJobClaimDisposition({
      ...queued, status: 'running', attempts: 1, leaseExpiresAt: now + 1,
    }, now)).toBe('wait')
  })

  test('expires before reclaim and stops after the fixed attempt budget', () => {
    expect(printJobClaimDisposition({ ...queued, expiresAt: now }, now)).toBe('expired')
    expect(printJobClaimDisposition({ ...queued, attempts: 5 }, now)).toBe('exhausted')
    expect(printJobClaimDisposition({ ...queued, nextAttemptAt: now + 1 }, now)).toBe('wait')
  })

  test('uses bounded exponential retry and never retries terminal or expired work', () => {
    expect([1, 2, 3, 4, 5, 9].map(printJobRetryDelay)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000,
    ])
    expect(printJobShouldRetry({ retryable: true, attempts: 1, maxAttempts: 5, expiresAt: now + 1, now })).toBe(true)
    expect(printJobShouldRetry({ retryable: false, attempts: 1, maxAttempts: 5, expiresAt: now + 1, now })).toBe(false)
    expect(printJobShouldRetry({ retryable: true, attempts: 5, maxAttempts: 5, expiresAt: now + 1, now })).toBe(false)
    expect(printJobShouldRetry({ retryable: true, attempts: 1, maxAttempts: 5, expiresAt: now, now })).toBe(false)
  })
})
