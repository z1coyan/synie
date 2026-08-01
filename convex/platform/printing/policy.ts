export type PrintJobClaimView = {
  status: string
  attempts: number
  maxAttempts: number
  nextAttemptAt: number
  leaseExpiresAt: number | null
  expiresAt: number
}

export type ClaimDisposition = 'claim' | 'expired' | 'exhausted' | 'wait'

/** Pure state-machine policy shared by the Convex mutation and focused tests. */
export function printJobClaimDisposition(
  job: PrintJobClaimView,
  now: number,
): ClaimDisposition {
  if (job.expiresAt <= now) return 'expired'
  const acquirable = job.status === 'queued' || job.status === 'retryable' ||
    (job.status === 'running' && (job.leaseExpiresAt ?? 0) <= now)
  if (!acquirable || job.nextAttemptAt > now) return 'wait'
  if (job.attempts >= job.maxAttempts) return 'exhausted'
  return 'claim'
}

export function printJobRetryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * (2 ** Math.max(0, attempt - 1)))
}

export function printJobShouldRetry(input: {
  retryable: boolean
  attempts: number
  maxAttempts: number
  expiresAt: number
  now: number
}): boolean {
  return input.retryable && input.attempts < input.maxAttempts && input.expiresAt > input.now
}
