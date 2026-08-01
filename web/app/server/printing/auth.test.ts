import { describe, expect, test } from 'bun:test'
import {
  PRINT_WORKER_SIGNATURE_HEADER,
  PRINT_WORKER_TIMESTAMP_HEADER,
} from '@synie/shared'
import { authenticatePrintWorkerRequest, signPrintWorkerBody } from './auth'

const secret = '0123456789abcdef0123456789abcdef'

describe('print worker HMAC', () => {
  test('accepts the exact timestamp and raw body', () => {
    const now = 1_700_000_000_000
    const body = new TextEncoder().encode('{"version":1}')
    const timestamp = String(now)
    const headers = new Headers({
      [PRINT_WORKER_TIMESTAMP_HEADER]: timestamp,
      [PRINT_WORKER_SIGNATURE_HEADER]: signPrintWorkerBody(secret, timestamp, body),
    })
    expect(authenticatePrintWorkerRequest(headers, body, { now, secrets: [secret] })).toBe(true)
    expect(authenticatePrintWorkerRequest(headers, new TextEncoder().encode('{}'), { now, secrets: [secret] })).toBe(false)
  })

  test('rejects stale timestamp and invalid signature without throwing', () => {
    const now = 1_700_000_000_000
    const body = new Uint8Array([1, 2, 3])
    const headers = new Headers({
      [PRINT_WORKER_TIMESTAMP_HEADER]: String(now - 60_001),
      [PRINT_WORKER_SIGNATURE_HEADER]: 'a'.repeat(64),
    })
    expect(authenticatePrintWorkerRequest(headers, body, { now, secrets: [secret] })).toBe(false)
  })
})
