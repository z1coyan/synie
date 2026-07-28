import { ApiError } from '../http/errors.ts'
import type { Actor } from '../authz/actor.ts'
import type { RateLimiter } from './limiter.ts'
import { hashPassword, verifyPassword } from './password.ts'
import type { AuthStore, UserCredentials } from './store.ts'
import type { TokenManager } from './token.ts'

export interface LoginResult {
  token: string
  expiresAt: Date
  user: Omit<UserCredentials, 'hashedPassword'>
}

/**
 * 认证服务。行为契约（与 server-go platform/auth 一致）：
 * - 用户不存在时也走一次 dummy 校验（等时失败，不区分用户存在性）
 * - 失败计入限流（429 口径见 limiter），成功清零
 */
export async function createAuthService(deps: {
  store: AuthStore
  tokens: TokenManager
  limiter: RateLimiter
}) {
  const { store, tokens, limiter } = deps
  const dummyHash = await hashPassword('synie-invalid-credential-dummy')

  async function login(input: { username: string; password: string; bucket: string }): Promise<LoginResult> {
    const username = input.username.trim()
    if (!username || !input.password) {
      throw new ApiError('unauthorized', '用户名或密码错误')
    }
    if (limiter.blocked(input.bucket)) {
      throw new ApiError('rate_limited', '登录尝试过于频繁,请稍后再试')
    }

    const user = await store.credentialsByUsername(username)
    const valid = await verifyPassword(user?.hashedPassword ?? dummyHash, input.password)
    if (!user || !valid) {
      limiter.recordFailure(input.bucket)
      throw new ApiError('unauthorized', '用户名或密码错误')
    }

    const { token, expiresAt } = await tokens.issue(user.id)
    limiter.reset(input.bucket)
    return { token, expiresAt, user: { id: user.id, username: user.username, name: user.name } }
  }

  async function authenticate(rawToken: string): Promise<Actor> {
    const userId = await tokens.verifyToken(rawToken)
    const actor = userId ? await store.actorByUserId(userId) : null
    if (!actor) {
      throw new ApiError('unauthorized', '登录状态已失效,请重新登录')
    }
    return actor
  }

  return { login, authenticate }
}

export type AuthService = Awaited<ReturnType<typeof createAuthService>>
