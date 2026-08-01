import { describe, expect, test } from 'bun:test'
import { acquireLease, canAcquireLease, retryDelayMs } from './model'

describe('durable job lease model', () => {
  const queued = {
    status: 'queued' as const, attempts: 0, maxAttempts: 3,
    nextAttemptAt: 100, leaseToken: null, leaseExpiresAt: null,
  }

  test('only one worker owns an unexpired lease and expiry is recoverable', () => {
    expect(canAcquireLease(queued, 100)).toBe(true)
    const running = acquireLease(queued, 100, 'worker-a', 30_000)
    expect(running.status).toBe('running')
    expect(canAcquireLease(running, 30_099)).toBe(false)
    expect(canAcquireLease(running, 30_100)).toBe(true)
    expect(acquireLease(running, 30_100, 'worker-b', 30_000).attempts).toBe(2)
  })

  test('attempt exhaustion enters dead letter and backoff is bounded', () => {
    const exhausted = acquireLease({ ...queued, status: 'failed', attempts: 3 }, 100, 'worker', 1_000)
    expect(exhausted.status).toBe('dead_letter')
    expect(retryDelayMs(1)).toBe(5_000)
    expect(retryDelayMs(99)).toBe(3_600_000)
  })
})
