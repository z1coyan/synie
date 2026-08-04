/**
 * better-auth 实例（httpOnly cookie 会话通道；与旧 JWT Bearer 双轨过渡）。
 * 与文档默认不同的点：
 * - database 复用现有 Kysely 连接；表名 auth_*、列名 snake_case 由 modelName/fields 显式映射
 * - 密码哈希/校验挂现有 argon2id PHC（password.ts），存量 hashed_password 直接互通
 * - emailAndPassword 开启但 disableSignUp：建号只走 IAM/setup（credentials.ts 收口）
 * - username 插件放开长度/字符集校验（sys_user.username 是 citext，无字符集限制）
 * - genericOAuth 接 Logto（env 三件套齐备才注册）；OAuth 首登 fail-closed：
 *   email 必须命中 sys_user.email 才允许建号，创建后回写 sys_user.auth_user_id
 */
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { genericOAuth, username } from 'better-auth/plugins'
import { sql, type Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { hashPassword, verifyPassword } from './password.ts'

export interface LogtoConfig {
  issuer: string
  clientId: string
  clientSecret: string
}

/**
 * OAuth 首登供给钩子（databaseHooks.user.create；导出仅供测试）。
 * 走 better-auth 建号的路径只有 OAuth 回调（email/password 注册已关、credential
 * 账号由 credentials.ts 直写 SQL），故对所有 better-auth 建号统一 fail-closed。
 */
export function createOAuthProvision(db: Kysely<Database>) {
  async function sysUserByEmail(email: string) {
    return db
      .selectFrom('sys_user')
      .select(['id', 'auth_user_id'])
      .where(sql`lower(email)`, '=', email.toLowerCase())
      .executeTakeFirst()
  }

  return {
    /** 建号前：email 必须命中 sys_user.email 且该用户尚未关联登录账号，否则拒绝 */
    async before(user: { email: string }): Promise<void> {
      const matched = await sysUserByEmail(user.email)
      if (!matched) {
        throw new APIError('FORBIDDEN', { message: '该邮箱未对应任何系统用户，禁止自动建号' })
      }
      if (matched.auth_user_id) {
        throw new APIError('FORBIDDEN', {
          message: '该邮箱对应的系统用户已有登录账号，请先关联既有账号',
        })
      }
    },
    /** 建号后：回写 sys_user.auth_user_id（仅补空链接，不覆盖） */
    async after(user: { id: string; email: string }): Promise<void> {
      await db
        .updateTable('sys_user')
        .set({ auth_user_id: user.id, updated_at: sql`(now() AT TIME ZONE 'utc')` })
        .where(sql`lower(email)`, '=', user.email.toLowerCase())
        .where('auth_user_id', 'is', null)
        .execute()
    },
  }
}

/**
 * better-auth 的 baseURL：
 * - 多 Host（局域网 / Tailscale）→ dynamic + allowedHosts，按请求 Host 拼 OAuth 回调
 * - 单 Host → 静态字符串
 * 均信任 Vite/反代的 x-forwarded-host/proto（dev 代理 changeOrigin 后 Host 会变成 API 端口）
 */
function resolveBaseURLConfig(deps: {
  baseURL?: string
  allowedHosts?: string[]
}):
  | string
  | { allowedHosts: string[]; fallback?: string; protocol: 'http' | 'https' | 'auto' }
  | undefined {
  const fallback = deps.baseURL?.replace(/\/+$/, '')
  const allowedHosts = [...new Set((deps.allowedHosts ?? []).map((h) => h.trim()).filter(Boolean))]
  if (allowedHosts.length > 1 || (allowedHosts.length === 1 && fallback && !allowedHosts.includes(new URL(fallback).host))) {
    return {
      allowedHosts: fallback
        ? [...new Set([new URL(fallback).host, ...allowedHosts])]
        : allowedHosts,
      ...(fallback ? { fallback } : {}),
      // auto：loopback 走 http，其余按 x-forwarded-proto / 请求推断
      protocol: 'auto',
    }
  }
  if (fallback) return fallback
  if (allowedHosts.length === 1) {
    const host = allowedHosts[0]!
    // 无完整 URL 时只能按 host 猜协议；loopback 用 http
    const isLoopback =
      host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]')
    return `${isLoopback ? 'http' : 'https'}://${host}`
  }
  return undefined
}

export function createBetterAuth(deps: {
  db: Kysely<Database>
  secret: string
  /**
   * 浏览器可达的应用 origin（如 http://localhost:3000）。
   * 启用 Logto 时必填：fallback / 单 host baseURL。
   */
  baseURL?: string
  /** 额外/全部允许的 Host（host:port 或通配）；多于 1 个时启用 dynamic baseURL */
  allowedHosts?: string[]
  logto?: LogtoConfig
}) {
  const provision = createOAuthProvision(deps.db)
  const baseURL = resolveBaseURLConfig(deps)
  const useProxyHeaders = Boolean(baseURL)
  return betterAuth({
    basePath: '/api/v1/auth',
    ...(baseURL ? { baseURL } : {}),
    secret: deps.secret,
    telemetry: { enabled: false },
    database: { db: deps.db, type: 'postgres' },
    // OAuth/回调失败不落 better-auth 默认 HTML 错误页，回登录页由前端 toast 展示
    onAPIError: { errorURL: '/login' },
    advanced: {
      cookiePrefix: 'synie',
      // Vite 代理 / 反代：按 x-forwarded-host 还原浏览器入口，避免 redirect_uri 落到 :8080
      ...(useProxyHeaders ? { trustedProxyHeaders: true } : {}),
    },
    user: {
      modelName: 'auth_user',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    session: {
      modelName: 'auth_session',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      // requireAuth 每请求 getSession：cookie 缓存 5 分钟内免查库
      cookieCache: { enabled: true, maxAge: 300 },
    },
    account: {
      modelName: 'auth_account',
      fields: {
        userId: 'user_id',
        providerId: 'provider_id',
        accountId: 'account_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      accountLinking: {
        enabled: true,
        // 回填的存量 auth_user（email 占位、未验证）用 Logto 同 email 登录时允许隐式关联；
        // 本地账号全部由管理员供给，无「抢注邮箱」风险
        trustedProviders: ['logto'],
        requireLocalEmailVerified: false,
      },
    },
    verification: {
      modelName: 'auth_verification',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    plugins: [
      username({
        minUsernameLength: 1,
        maxUsernameLength: 64,
        // sys_user.username（citext）无字符集限制，存在性/密码校验兜底
        usernameValidator: () => true,
        schema: { user: { fields: { displayUsername: 'display_username' } } },
      }),
      ...(deps.logto
        ? [
            genericOAuth({
              config: [
                {
                  providerId: 'logto',
                  discoveryUrl: `${deps.logto.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
                  clientId: deps.logto.clientId,
                  clientSecret: deps.logto.clientSecret,
                  scopes: ['openid', 'profile', 'email'],
                  pkce: true,
                  // redirect_uri 由 baseURL 按请求 Host 推导：
                  // {origin}/api/v1/auth/oauth2/callback/logto —— 须在 Logto 登记每个入口
                },
              ],
            }),
          ]
        : []),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await provision.before(user)
          },
          after: async (user) => {
            await provision.after(user)
          },
        },
      },
    },
  })
}

export type SynieBetterAuth = ReturnType<typeof createBetterAuth>
