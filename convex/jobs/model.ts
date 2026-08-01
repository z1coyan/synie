export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dead_letter'

export interface LeaseState {
  status: JobStatus
  attempts: number
  maxAttempts: number
  nextAttemptAt: number
  leaseToken: string | null
  leaseExpiresAt: number | null
}

export function canAcquireLease(job: LeaseState, now: number): boolean {
  if (job.status === 'queued' || job.status === 'failed') return job.nextAttemptAt <= now
  return job.status === 'running' && (job.leaseExpiresAt ?? 0) <= now
}

export function acquireLease(job: LeaseState, now: number, token: string, durationMs: number): LeaseState {
  if (!canAcquireLease(job, now)) throw new Error('任务当前不可获取 lease')
  const attempts = job.attempts + 1
  if (attempts > job.maxAttempts) {
    return { ...job, status: 'dead_letter', attempts, leaseToken: null, leaseExpiresAt: null }
  }
  return { ...job, status: 'running', attempts, leaseToken: token, leaseExpiresAt: now + durationMs }
}

export function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * (2 ** Math.max(0, attempt - 1)))
}

export function stableChunkHash(rows: readonly unknown[]): string {
  return JSON.stringify(rows)
}
