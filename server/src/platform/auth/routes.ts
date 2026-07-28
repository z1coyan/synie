import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { AppEnv } from '../http/context.ts'
import { validationHook } from '../http/zod.ts'
import { requireAuth } from './middleware.ts'
import type { AuthService } from './service.ts'

// 形状对齐 contracts/openapi LoginRequest/LoginResponse/MeResponse（wire 契约不变）
const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(1024),
  })
  .strict()

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
    .get('/me', requireAuth(auth), (c) => {
      const actor = c.get('actor')
      return c.json({
        user: { id: actor.userId, username: actor.username, name: actor.name },
        superAdmin: actor.superAdmin,
        allCompanies: actor.allCompanies,
        permissions: [...actor.permissions].sort(),
        companyIds: actor.companyIds,
      })
    })
}
