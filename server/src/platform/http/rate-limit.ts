import type { MiddlewareHandler } from 'hono'
import type { RateLimiter } from '../auth/limiter.ts'
import type { AppEnv } from './context.ts'
import { ApiError } from './errors.ts'

/**
 * 重资源端点限流中间件：按已登录用户分桶（须挂在 requireAuth 之后），
 * 窗口内超限抛 429 rate_limited。计数即判定（limiter.hit），
 * 成功与失败的请求都计数——防的是资源滥用，不是只防失败。
 * limiter 缺省时直通不限流（测试基座/未配置场景兼容，保持中间件个数恒定以保 hc 类型链）。
 */
export function rateLimitByActor(
  limiter: RateLimiter | undefined,
  message: string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (limiter) {
      const actor = c.get('actor')
      const bucket = actor?.userId ?? 'anonymous'
      if (!limiter.hit(bucket)) {
        throw new ApiError('rate_limited', message)
      }
    }
    await next()
  }
}
