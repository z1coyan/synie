import { createClient, type GenericCtx } from '@convex-dev/better-auth'
import { isRunMutationCtx } from '@convex-dev/better-auth/utils'
import { convex } from '@convex-dev/better-auth/plugins'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth/minimal'
import type { BetterAuthOptions } from 'better-auth/minimal'
import { username } from 'better-auth/plugins/username'
import authConfig from './auth.config'
import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'
import { usesSecureSessionCookies } from './lib/authPolicy'
import { isValidPluginUsername, normalizeUsername } from './lib/username'

type AuthConstructionOptions = {
  allowUserCreation?: boolean
  faultPoint?: 'after_auth_user' | 'after_credential'
}

function deploymentEnv(name: 'SITE_URL' | 'BETTER_AUTH_SECRET'): string {
  const value = (
    globalThis as typeof globalThis & {
      process?: { env?: Partial<Record<typeof name, string>> }
    }
  ).process?.env?.[name]
  if (!value) throw new Error(`缺少 Convex deployment env：${name}`)
  return value
}

function loginKey(request: Request | undefined, usernameValue: unknown): string | null {
  if (typeof usernameValue !== 'string') return null
  const forwarded = request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const ip = forwarded || request?.headers.get('x-real-ip')?.trim() || 'unknown'
  return `${ip}\u0000${normalizeUsername(usernameValue)}`
}

async function responseWithoutInternalEmail(returned: unknown): Promise<unknown | null> {
  if (!returned || returned instanceof APIError) return null
  let body = returned
  if (returned instanceof Response) {
    if (!returned.ok) return null
    body = await returned.clone().json().catch(() => null)
  }
  if (!body || typeof body !== 'object' || !('user' in body)) return null
  const user = (body as { user?: unknown }).user
  if (!user || typeof user !== 'object' || !('email' in user)) return null
  const { email: _internalEmail, ...safeUser } = user as Record<string, unknown>
  return { ...(body as Record<string, unknown>), user: safeUser }
}

export const authComponent = createClient<DataModel>(components.betterAuth)

export function createAuth(
  ctx: GenericCtx<DataModel>,
  construction: AuthConstructionOptions = {},
) {
  const siteUrl = deploymentEnv('SITE_URL')
  return betterAuth({
    baseURL: siteUrl,
    secret: deploymentEnv('BETTER_AUTH_SECRET'),
    trustedOrigins: [siteUrl],
    disabledPaths: [
      '/is-username-available',
      '/sign-in/email',
      '/change-email',
      '/update-user',
      '/delete-user',
    ],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: false,
      minPasswordLength: 1,
      maxPasswordLength: 1024,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    database: authComponent.adapter(ctx),
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!construction.allowUserCreation) {
              throw new APIError('FORBIDDEN', { message: '公开注册已关闭' })
            }
            return { data: user }
          },
          after: async () => {
            if (construction.faultPoint === 'after_auth_user') {
              throw new Error('SYNIE_AUTH_FAULT_AFTER_AUTH_USER')
            }
          },
        },
      },
      account: {
        create: {
          after: async (account) => {
            if (
              construction.faultPoint === 'after_credential' &&
              account.providerId === 'credential'
            ) {
              throw new Error('SYNIE_AUTH_FAULT_AFTER_CREDENTIAL')
            }
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      // Better Auth's request counter intentionally remains a broad abuse
      // ceiling. The business 10-failures/5-minute rule below counts only
      // failed username attempts and is reset after a successful sign-in.
      window: 60,
      max: 1_000,
      customRules: {
        // Better Auth otherwise applies its built-in 3/10s sign-in rule before
        // Synie's stricter failure-only IP+username policy can run. Keep this
        // endpoint under the broad abuse ceiling; the atomic business counter
        // below remains the authoritative 10 failures / 5 minutes rule.
        '/sign-in/username': { window: 60, max: 1_000 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (hookCtx) => {
        if (hookCtx.path !== '/sign-in/username' || !isRunMutationCtx(ctx)) return
        const key = loginKey(hookCtx.request, hookCtx.body?.username)
        if (!key) return
        const allowed = await ctx.runMutation(internal.iam.loginRateLimit.consume, { key })
        if (!allowed) {
          throw new APIError('TOO_MANY_REQUESTS', {
            message: '登录尝试过于频繁,请稍后再试',
          })
        }
      }),
      after: createAuthMiddleware(async (hookCtx) => {
        const returned = hookCtx.context.returned
        const stripsUserResponse =
          hookCtx.path === '/sign-in/username' || hookCtx.path === '/get-session'
        const safeResponse = stripsUserResponse
          ? await responseWithoutInternalEmail(returned)
          : null
        if (hookCtx.path === '/sign-in/username' && isRunMutationCtx(ctx)) {
          if (safeResponse) {
            const key = loginKey(hookCtx.request, hookCtx.body?.username)
            if (key) await ctx.runMutation(internal.iam.loginRateLimit.reset, { key })
          }
        }
        if (safeResponse) return hookCtx.json(safeResponse)
      }),
    },
    advanced: {
      useSecureCookies: usesSecureSessionCookies(siteUrl),
    },
    plugins: [
      username({
        minUsernameLength: 1,
        // Plugin uses UTF-16 code units; business validation below uses Unicode code points.
        maxUsernameLength: 128,
        usernameNormalization: normalizeUsername,
        usernameValidator: isValidPluginUsername,
        displayUsernameValidator: (value) => {
          const length = [...value.trim()].length
          return value === value.trim() && length >= 1 && length <= 64
        },
      }),
      convex({ authConfig }),
    ],
  } satisfies BetterAuthOptions)
}
