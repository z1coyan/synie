/**
 * 单进程内存滑动窗口限流（KD24：单进程即可）。
 * - 登录限流默认 5 分钟 10 次（blocked / recordFailure / reset）
 * - 重资源端点限流用 hit()：一次调用完成「计数 + 判定」，true 放行 / false 超限
 * - 桶表有界（maxBuckets，默认 10_000）：满时先全量清扫过期桶，仍满则按
 *   插入序淘汰最旧桶——攻击者用随机 bucket 也无法让 Map 无界增长
 */
export function createRateLimiter(options?: {
  max?: number
  windowMs?: number
  /** 桶表上限（条）；默认 10_000 */
  maxBuckets?: number
  now?: () => number
}) {
  const max = options?.max ?? 10
  const windowMs = options?.windowMs ?? 5 * 60 * 1000
  const maxBuckets = options?.maxBuckets ?? 10_000
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

  /** 全量清扫过期桶（所有记录都滑出窗口的桶整桶删除） */
  function sweep(): void {
    const cutoff = now() - windowMs
    for (const [bucket, values] of attempts) {
      const kept = values.filter((at) => at >= cutoff)
      if (kept.length === 0) attempts.delete(bucket)
      else attempts.set(bucket, kept)
    }
  }

  /** 新桶准入：满时先 sweep 过期桶，仍满则按插入序（Map 迭代序）淘汰最旧桶 */
  function admitBucket(bucket: string): void {
    if (attempts.has(bucket) || attempts.size < maxBuckets) return
    sweep()
    if (attempts.size < maxBuckets) return
    for (const key of attempts.keys()) {
      if (attempts.size < maxBuckets) break
      attempts.delete(key)
    }
  }

  function blocked(bucket: string): boolean {
    prune(bucket)
    return (attempts.get(bucket)?.length ?? 0) >= max
  }

  function recordFailure(bucket: string): void {
    prune(bucket)
    admitBucket(bucket)
    const values = attempts.get(bucket) ?? []
    values.push(now())
    attempts.set(bucket, values)
  }

  /**
   * 计数并判定：窗口内未超 max 则记录本次并返回 true（放行）；
   * 已达 max 则不记录、返回 false（拒绝）。
   */
  function hit(bucket: string): boolean {
    prune(bucket)
    const values = attempts.get(bucket) ?? []
    if (values.length >= max) return false
    admitBucket(bucket)
    values.push(now())
    attempts.set(bucket, values)
    return true
  }

  function reset(bucket: string): void {
    attempts.delete(bucket)
  }

  /** 当前桶数（测试与排障观测用） */
  function size(): number {
    return attempts.size
  }

  return { blocked, recordFailure, hit, reset, size }
}

export type RateLimiter = ReturnType<typeof createRateLimiter>
