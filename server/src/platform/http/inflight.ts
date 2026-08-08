import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './context.ts'

/**
 * 在途请求计数器（停机排空用）。
 * middleware 注册在 accessLog 之前（最外层）：计数覆盖整个请求生命周期，
 * 保证 drained() 返回时访问日志也已落盘。
 */
export function createInflightTracker() {
  let count = 0
  const waiters: Array<() => void> = []

  const middleware: MiddlewareHandler<AppEnv> = async (_c, next) => {
    count += 1
    try {
      await next()
    } finally {
      count -= 1
      if (count === 0) {
        for (const wake of waiters.splice(0)) wake()
      }
    }
  }

  /** 等在途请求归零（已为零立即返回） */
  async function drained(): Promise<void> {
    if (count === 0) return
    await new Promise<void>((resolve) => waiters.push(resolve))
  }

  return { middleware, drained, count: () => count }
}

export type InflightTracker = ReturnType<typeof createInflightTracker>
