import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import type { AuthService } from './service.ts'

/** Bearer 令牌 → Actor，写入请求上下文；未携带或失效一律 401 */
export function requireAuth(auth: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization')
    const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
    if (!token) {
      throw new ApiError('unauthorized', '未登录或登录状态已失效')
    }
    c.set('actor', await auth.authenticate(token))
    await next()
  }
}
