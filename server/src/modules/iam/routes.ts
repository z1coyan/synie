import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { IamService } from './service.ts'

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const idParam = z.object({ id: z.string().uuid() })

const userCreateSchema = z
  .object({
    username: z.string().min(1),
    name: z.string().nullable().optional(),
    roleIds: z.array(z.string().uuid()).optional(),
    companyIds: z.array(z.string().uuid()).optional(),
  })
  .strict()

const userUpdateSchema = z
  .object({
    name: z.string().nullable().optional(),
    roleIds: z.array(z.string().uuid()).optional(),
    companyIds: z.array(z.string().uuid()).optional(),
  })
  .strict()

const roleCreateSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean().optional(),
  })
  .strict()

const roleUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

const permissionsSchema = z.object({ permissions: z.array(z.string()) }).strict()

export function iamUserRoutes(deps: { auth: AuthService; iam: IamService }) {
  const { auth, iam } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.user:read')
      const result = await iam.listUsers(toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(userDto) })
    })
    .post('/', zValidator('json', userCreateSchema, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.user:create')
      const body = c.req.valid('json')
      const created = await iam.createUser(c.get('actor'), {
        username: body.username,
        name: body.name,
        roleIds: body.roleIds,
        companyIds: body.companyIds,
      })
      c.header('Cache-Control', 'no-store')
      return c.json({ user: userDto(created.user), password: created.password }, 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.user:read')
      return c.json(userDto(await iam.getUser(c.req.valid('param').id)))
    })
    .get('/:id/access', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.user:read')
      return c.json(await iam.userAccess(c.req.valid('param').id))
    })
    .post('/:id/reset-password', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.user:update')
      const password = await iam.resetPassword(c.get('actor'), c.req.valid('param').id)
      c.header('Cache-Control', 'no-store')
      return c.json({ password })
    })
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', userUpdateSchema, validationHook),
      async (c) => {
        requirePermission(c.get('actor'), 'sys.user:update')
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await iam.updateUser(c.get('actor'), c.req.valid('param').id, {
          name: body.name,
          namePresent: Object.prototype.hasOwnProperty.call(raw, 'name'),
          roleIds: body.roleIds,
          roleIdsPresent: Object.prototype.hasOwnProperty.call(raw, 'roleIds'),
          companyIds: body.companyIds,
          companyIdsPresent: Object.prototype.hasOwnProperty.call(raw, 'companyIds'),
        })
        return c.json(userDto(item))
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.user:delete')
      await iam.deleteUser(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function iamRoleRoutes(deps: { auth: AuthService; iam: IamService }) {
  const { auth, iam } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.role:read')
      const result = await iam.listRoles(toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(roleDto) })
    })
    .post('/', zValidator('json', roleCreateSchema, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.role:create')
      const body = c.req.valid('json')
      const item = await iam.createRole(c.get('actor'), body)
      return c.json(roleDto(item), 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.role:read')
      return c.json(roleDto(await iam.getRole(c.req.valid('param').id)))
    })
    .get('/:id/permissions', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.role:read')
      const rows = await iam.rolePermissions(c.req.valid('param').id)
      return c.json({ rows })
    })
    .put(
      '/:id/permissions',
      zValidator('param', idParam, validationHook),
      zValidator('json', permissionsSchema, validationHook),
      async (c) => {
        requirePermission(c.get('actor'), 'sys.role:update')
        const permissions = await iam.syncRolePermissions(
          c.get('actor'),
          c.req.valid('param').id,
          c.req.valid('json').permissions,
        )
        return c.json({ permissions })
      },
    )
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', roleUpdateSchema, validationHook),
      async (c) => {
        requirePermission(c.get('actor'), 'sys.role:update')
        const item = await iam.updateRole(c.get('actor'), c.req.valid('param').id, c.req.valid('json'))
        return c.json(roleDto(item))
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      requirePermission(c.get('actor'), 'sys.role:delete')
      await iam.deleteRole(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

function userDto(u: Awaited<ReturnType<IamService['getUser']>>) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    preferredLanguage: u.preferredLanguage,
    insertedAt: u.insertedAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  }
}

function roleDto(r: Awaited<ReturnType<IamService['getRole']>>) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    enabled: r.enabled,
    builtin: r.builtin,
    insertedAt: r.insertedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}
