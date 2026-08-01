import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  PRINT_WORKER_MAX_CLOCK_SKEW_MS,
  PRINT_WORKER_SIGNATURE_HEADER,
  PRINT_WORKER_TIMESTAMP_HEADER,
  printWorkerSignaturePayload,
} from '@synie/shared'

if (typeof window !== 'undefined') throw new Error('print worker auth is server-only')

export function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function signPrintWorkerBody(secret: string, timestamp: string, rawBody: Uint8Array): string {
  requireWorkerSecret(secret)
  return createHmac('sha256', secret)
    .update(printWorkerSignaturePayload(timestamp, sha256Hex(rawBody)))
    .digest('hex')
}

export function requireWorkerSecret(secret: string | undefined): string {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('PRINT_WORKER_HMAC_SECRET 必须至少 32 bytes')
  }
  return secret
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function authenticatePrintWorkerRequest(
  headers: Headers,
  rawBody: Uint8Array,
  options: { now?: number; secrets?: readonly string[] } = {},
): boolean {
  const timestamp = headers.get(PRINT_WORKER_TIMESTAMP_HEADER) ?? ''
  const signature = headers.get(PRINT_WORKER_SIGNATURE_HEADER) ?? ''
  if (!/^\d{13}$/.test(timestamp)) return false
  const now = options.now ?? Date.now()
  if (Math.abs(now - Number(timestamp)) > PRINT_WORKER_MAX_CLOCK_SKEW_MS) return false
  const secrets = (options.secrets ?? [process.env.PRINT_WORKER_HMAC_SECRET ?? '', process.env.PRINT_WORKER_HMAC_PREVIOUS_SECRET ?? ''])
    .filter((secret) => Buffer.byteLength(secret) >= 32)
  let valid = false
  for (const secret of secrets) {
    const expected = signPrintWorkerBody(secret, timestamp, rawBody)
    valid = safeEqualHex(signature, expected) || valid
  }
  return valid
}
