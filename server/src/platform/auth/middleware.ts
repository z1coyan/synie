import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/context.ts'
import type { AuthService } from './service.ts'

/** cookie 会话优先、Bearer JWT 回退 → Actor，写入请求上下文；两路失效一律 401 */
export function requireAuth(auth: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('actor', await auth.authenticateRequest(c.req.raw.headers))
    await next()
  }
}
