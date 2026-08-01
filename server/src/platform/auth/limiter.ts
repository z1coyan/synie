/**
 * 登录限流：单进程内存滑动窗口，默认 5 分钟 10 次（KD24：单进程即可）。
 */
export function createRateLimiter(options?: {
  max?: number
  windowMs?: number
  now?: () => number
}) {
  const max = options?.max ?? 10
  const windowMs = options?.windowMs ?? 5 * 60 * 1000
  const now = options?.now ?? Date.now
  const attempts = new Map<string, number[]>()

  function prune(bucket: string): void {
    const values = attempts.get(bucket)
    if (!values) return
    const cutoff = now() - windowMs
    const kept = values.filter((at) => at >= cutoff)
    if (kept.length === 0) attempts.delete(bucket)
    else attempts.set(bucket, kept)
  }

  function blocked(bucket: string): boolean {
    prune(bucket)
    return (attempts.get(bucket)?.length ?? 0) >= max
  }

  function recordFailure(bucket: string): void {
    prune(bucket)
    const values = attempts.get(bucket) ?? []
    values.push(now())
    attempts.set(bucket, values)
  }

  function reset(bucket: string): void {
    attempts.delete(bucket)
  }

  return { blocked, recordFailure, reset }
}

export type RateLimiter = ReturnType<typeof createRateLimiter>
