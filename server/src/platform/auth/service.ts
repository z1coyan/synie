import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { auditCreated, auditDestroyed, writeAudit } from '../audit/write.ts'
import { ApiError } from '../http/errors.ts'
import type { Actor } from '../authz/core/index.ts'
import type { ActorAssembler } from '../authz/build-actor.ts'
import {
  API_KEY_PREFIX,
  API_KEY_RESOURCE,
  createUserApiKeyStore,
  parseApiKeyExpiry,
  type CreatedUserApiKey,
  type RequestAuthMethod,
  type UserApiKeyDto,
} from './api-key.ts'
import type { SynieBetterAuth } from './better-auth.ts'
import type { RateLimiter } from './limiter.ts'
import { hashPassword, verifyPassword } from './password.ts'
import type { AuthStore, UserCredentials } from './store.ts'
import type { TokenManager } from './token.ts'

export type { RequestAuthMethod }

export interface LoginResult {
  token: string
  expiresAt: Date
  user: Omit<UserCredentials, 'hashedPassword'>
}

/**
 * 认证服务。行为契约（与 server-go platform/auth 一致）：
 * - 用户不存在时也走一次 dummy 校验（等时失败，不区分用户存在性）
 * - 失败计入限流（429 口径见 limiter），成功清零
 * - 身份三轨：cookie 会话（better-auth）优先，再个人 API 密钥，再回退 Bearer JWT
 */
export async function createAuthService(deps: {
  db: Kysely<Database>
  store: AuthStore
  /** Actor 装配（platform/authz 拥有；含 30s TTL 缓存与部门子树物化） */
  actors: ActorAssembler
  tokens: TokenManager
  limiter: RateLimiter
  /** 缺省时 cookie 轨关闭，仅 Bearer（存量单测基座兼容） */
  betterAuth?: SynieBetterAuth
}) {
  const { db, store, actors, tokens, limiter, betterAuth } = deps
  const apiKeys = createUserApiKeyStore(db)
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
    const actor = userId ? await actors.buildActor(userId) : null
    if (!actor) {
      throw new ApiError('unauthorized', '登录状态已失效,请重新登录')
    }
    return actor
  }

  /**
   * 请求级身份三轨：cookie 会话 → 个人 API 密钥（`synie_ak_` 前缀）→ Bearer JWT。
   * 密钥前缀命中后不再回落 JWT。方法不进 Actor。
   */
  async function resolveRequest(
    headers: Headers,
  ): Promise<{ actor: Actor; method: RequestAuthMethod }> {
    if (betterAuth && headers.get('cookie')) {
      const session = await betterAuth.api.getSession({ headers }).catch(() => null)
      if (session) {
        const sysUserId = await store.userIdByAuthUserId(session.user.id)
        const actor = sysUserId ? await actors.buildActor(sysUserId) : null
        if (actor) return { actor, method: 'session' }
      }
    }
    const header = headers.get('authorization')
    const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
    if (token) {
      if (token.startsWith(API_KEY_PREFIX)) {
        const userId = await apiKeys.authenticate(token)
        const actor = userId ? await actors.buildActor(userId) : null
        if (!actor) {
          throw new ApiError('unauthorized', '登录状态已失效,请重新登录')
        }
        return { actor, method: 'api_key' }
      }
      return { actor: await authenticate(token), method: 'jwt' }
    }
    throw new ApiError('unauthorized', '未登录或登录状态已失效')
  }

  async function authenticateRequest(headers: Headers): Promise<Actor> {
    return (await resolveRequest(headers)).actor
  }

  async function listApiKeys(actor: Actor): Promise<UserApiKeyDto[]> {
    return apiKeys.listByUser(actor.userId)
  }

  async function createApiKey(
    actor: Actor,
    input: { name: string; expiresAt?: string | null },
  ): Promise<CreatedUserApiKey> {
    const created = await apiKeys.create({
      userId: actor.userId,
      name: input.name,
      expiresAt: parseApiKeyExpiry(input.expiresAt),
    })
    await writeAudit(db, actor, {
      resource: API_KEY_RESOURCE,
      recordId: created.id,
      recordLabel: created.name,
      actionType: 'create',
      actionName: 'create',
      changes: auditCreated(
        {
          name: created.name,
          token_hint: created.tokenHint,
          expires_at: created.expiresAt,
        },
        ['name', 'token_hint', 'expires_at'],
      ),
    })
    return created
  }

  async function revokeApiKey(actor: Actor, id: string): Promise<void> {
    const revoked = await apiKeys.revoke(actor.userId, id)
    await writeAudit(db, actor, {
      resource: API_KEY_RESOURCE,
      recordId: revoked.id,
      recordLabel: revoked.name,
      actionType: 'destroy',
      actionName: 'destroy',
      changes: auditDestroyed(
        {
          name: revoked.name,
          token_hint: revoked.tokenHint,
        },
        ['name', 'token_hint'],
      ),
    })
  }

  /** 有效菜单码集合；超管恒空数组（= 不限制，对齐绕过一切权限检查先例） */
  async function menuCodes(actor: Actor): Promise<string[]> {
    if (actor.superAdmin) return []
    return store.menuCodesByUserId(actor.userId)
  }

  return {
    login,
    authenticate,
    authenticateRequest,
    resolveRequest,
    menuCodes,
    listApiKeys,
    createApiKey,
    revokeApiKey,
  }
}

export type AuthService = Awaited<ReturnType<typeof createAuthService>>
