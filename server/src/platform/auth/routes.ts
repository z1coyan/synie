import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { topAtom } from '../authz/core/index.ts'
import type { AppEnv } from '../http/context.ts'
import { validationHook } from '../http/zod.ts'
import { rejectApiKeyManagement, requireAuth } from './middleware.ts'
import type { AuthService } from './service.ts'

// 形状对齐 contracts/openapi LoginRequest/LoginResponse/MeResponse（wire 契约不变）
const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(1024),
  })
  .strict()

const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    expiresAt: z.string().min(1).nullable().optional(),
  })
  .strict()

const apiKeyIdParam = z.object({ id: z.string().uuid() })

export function authRoutes(auth: AuthService) {
  return new Hono<AppEnv>()
    .post('/login', zValidator('json', loginSchema, validationHook), async (c) => {
      const { username, password } = c.req.valid('json')
      const bucket = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
      const result = await auth.login({ username, password, bucket })
      return c.json({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        user: result.user,
      })
    })
    .get('/api-keys', requireAuth(auth), rejectApiKeyManagement(), async (c) => {
      return c.json({ results: await auth.listApiKeys(c.get('actor')) })
    })
    .post(
      '/api-keys',
      requireAuth(auth),
      rejectApiKeyManagement(),
      zValidator('json', createApiKeySchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const created = await auth.createApiKey(c.get('actor'), {
          name: body.name,
          expiresAt: body.expiresAt,
        })
        return c.json(created, 201)
      },
    )
    .delete(
      '/api-keys/:id',
      requireAuth(auth),
      rejectApiKeyManagement(),
      zValidator('param', apiKeyIdParam, validationHook),
      async (c) => {
        await auth.revokeApiKey(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .get('/me', requireAuth(auth), async (c) => {
      const actor = c.get('actor')
      const menuCodes = await auth.menuCodes(actor)
      // Actor v2 投影：精确码（无通配）+ 每码数据范围 + 部门维度（工单 14 收口后唯一权限通道）。
      const grants = [...actor.grants.entries()]
        .map(([code, scopes]) => ({ code, scope: topAtom(scopes) ?? 'none' }))
        .sort((a, b) => a.code.localeCompare(b.code))
      return c.json({
        user: { id: actor.userId, username: actor.username, name: actor.name },
        superAdmin: actor.superAdmin,
        allCompanies: actor.companies.all,
        grants,
        companyIds: actor.companies.ids,
        departmentId: actor.deptId,
        departmentSubtreeIds: actor.deptSubtreeIds,
        menuCodes,
      })
    })
}
