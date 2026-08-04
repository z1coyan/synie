/**
 * Setup 公开/受保护路由。
 * 公开：GET /status、POST /first-user
 * 需超管：currencies/seed-common、currencies/activate-base、complete
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import { validationHook } from '../http/zod.ts'
import type { SetupService } from './service.ts'

const firstUserSchema = z
  .object({
    username: z.string().min(1).max(64),
    name: z.string().max(64).nullable().optional(),
    password: z.string().min(1).max(1024),
  })
  .strict()

const activateBaseSchema = z
  .object({
    currencyId: z.string().uuid(),
  })
  .strict()

const completeSchema = z
  .object({
    preferredLanguage: z.enum(['zh-CN', 'en-US']),
    seedSampleData: z.boolean().optional().default(false),
  })
  .strict()

function requireSuperAdmin() {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    const actor = c.get('actor')
    if (!actor?.superAdmin) {
      throw new ApiError('forbidden', '仅超级管理员可执行初始化')
    }
    await next()
  }
}

export function setupRoutes(deps: {
  auth: AuthService
  setup: SetupService
  /** Logto OIDC 是否启用（env 门控）；前端据此决定登录页是否显示 Logto 按钮 */
  logtoEnabled: boolean
}) {
  const { auth, setup, logtoEnabled } = deps
  return new Hono<AppEnv>()
    .get('/status', async (c) => {
      const status = await setup.getStatus()
      return c.json({ ...status, logtoEnabled })
    })
    .post(
      '/first-user',
      zValidator('json', firstUserSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const result = await setup.createFirstUser({
          username: body.username,
          name: body.name ?? null,
          password: body.password,
        })
        c.header('Cache-Control', 'no-store')
        return c.json(
          {
            token: result.token,
            expiresAt: result.expiresAt.toISOString(),
            user: {
              id: result.user.id,
              username: result.user.username,
              name: result.user.name,
            },
          },
          201,
        )
      },
    )
    .post(
      '/currencies/seed-common',
      requireAuth(auth),
      requireSuperAdmin(),
      async (c) => {
        const created = await setup.seedCommonCurrencies()
        return c.json({ created })
      },
    )
    .post(
      '/currencies/activate-base',
      requireAuth(auth),
      requireSuperAdmin(),
      zValidator('json', activateBaseSchema, validationHook),
      async (c) => {
        await setup.activateBaseCurrency(c.req.valid('json').currencyId)
        return c.json({ success: true })
      },
    )
    .post(
      '/complete',
      requireAuth(auth),
      requireSuperAdmin(),
      zValidator('json', completeSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        await setup.complete(c.get('actor'), body.preferredLanguage, body.seedSampleData ?? false)
        return c.json({ success: true })
      },
    )
}
