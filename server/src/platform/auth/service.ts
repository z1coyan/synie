import { ApiError } from '../http/errors.ts'
import type { Actor } from '../authz/actor.ts'
import type { SynieBetterAuth } from './better-auth.ts'
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
 * - 身份双轨（过渡期）：cookie 会话（better-auth）优先，回退 Bearer JWT
 */
export async function createAuthService(deps: {
  store: AuthStore
  tokens: TokenManager
  limiter: RateLimiter
  /** 缺省时 cookie 轨关闭，仅 Bearer（存量单测基座兼容） */
  betterAuth?: SynieBetterAuth
}) {
  const { store, tokens, limiter, betterAuth } = deps
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

  /**
   * 请求级身份双轨：先试 cookie 会话（better-auth，auth_user → sys_user 反查），
   * 无效再走 Bearer JWT；两路都失败 401。
   */
  async function authenticateRequest(headers: Headers): Promise<Actor> {
    if (betterAuth && headers.get('cookie')) {
      const session = await betterAuth.api.getSession({ headers }).catch(() => null)
      if (session) {
        const sysUserId = await store.userIdByAuthUserId(session.user.id)
        const actor = sysUserId ? await store.actorByUserId(sysUserId) : null
        if (actor) return actor
      }
    }
    const header = headers.get('authorization')
    const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
    if (token) {
      return authenticate(token)
    }
    throw new ApiError('unauthorized', '未登录或登录状态已失效')
  }

  /** 有效菜单码集合；超管恒空数组（= 不限制，对齐绕过一切权限检查先例） */
  async function menuCodes(actor: Actor): Promise<string[]> {
    if (actor.superAdmin) return []
    return store.menuCodesByUserId(actor.userId)
  }

  return { login, authenticate, authenticateRequest, menuCodes }
}

export type AuthService = Awaited<ReturnType<typeof createAuthService>>
