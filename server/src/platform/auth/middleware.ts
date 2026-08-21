import type { MiddlewareHandler } from 'hono'
import { ApiError } from '../http/errors.ts'
import type { AppEnv } from '../http/context.ts'
import type { AuthService } from './service.ts'

/** cookie 会话优先、个人密钥、Bearer JWT → Actor；失效一律 401 */
export function requireAuth(auth: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const headers = c.req.raw.headers
    if (typeof auth.resolveRequest === 'function') {
      const { actor, method } = await auth.resolveRequest(headers)
      c.set('actor', actor)
      c.set('authMethod', method)
    } else {
      c.set('actor', await auth.authenticateRequest(headers))
      c.set('authMethod', 'jwt')
    }
    await next()
  }
}

/** 个人密钥不能管理密钥（列表/创建/撤销） */
export function rejectApiKeyManagement(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('authMethod') === 'api_key') {
      throw new ApiError('unauthorized', '个人 API 密钥不能管理密钥')
    }
    await next()
  }
}
