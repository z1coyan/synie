import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { DepartmentService } from './department-service.ts'
import { DEPARTMENT_RESOURCE } from './meta.ts'
import type { IamService } from './service.ts'

const idParam = z.object({ id: z.string().uuid() })

const emailField = z.string().email('请输入有效的邮箱地址').max(254).nullable().optional()

const userCreateSchema = z
  .object({
    username: z.string().min(1),
    name: z.string().nullable().optional(),
    email: emailField,
    departmentId: z.string().uuid().nullable().optional(),
    roleIds: z.array(z.string().uuid()).optional(),
    companyIds: z.array(z.string().uuid()).optional(),
  })
  .strict()

const userUpdateSchema = z
  .object({
    name: z.string().nullable().optional(),
    email: emailField,
    departmentId: z.string().uuid().nullable().optional(),
    roleIds: z.array(z.string().uuid()).optional(),
    companyIds: z.array(z.string().uuid()).optional(),
  })
  .strict()

const departmentCreateSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    companyId: z.string().uuid(),
    parentId: z.string().uuid().nullable().optional(),
  })
  .strict()

const departmentUpdateSchema = z
  .object({
    code: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    parentId: z.string().uuid().nullable().optional(),
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

const menusSchema = z.object({ menuCodes: z.array(z.string()) }).strict()

export function iamUserRoutes(deps: { auth: AuthService; iam: IamService }) {
  const { auth, iam } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await iam.listUsers(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(userDto) })
    })
    .post('/', zValidator('json', userCreateSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const created = await iam.createUser(c.get('actor'), {
        username: body.username,
        name: body.name,
        email: body.email,
        departmentId: body.departmentId,
        roleIds: body.roleIds,
        companyIds: body.companyIds,
      })
      c.header('Cache-Control', 'no-store')
      return c.json({ user: userDto(created.user), password: created.password }, 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      return c.json(userDto(await iam.getUser(c.get('actor'), c.req.valid('param').id)))
    })
    .get('/:id/access', zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await iam.userAccess(c.get('actor'), c.req.valid('param').id))
    })
    .post('/:id/reset-password', zValidator('param', idParam, validationHook), async (c) => {
      const password = await iam.resetPassword(c.get('actor'), c.req.valid('param').id)
      c.header('Cache-Control', 'no-store')
      return c.json({ password })
    })
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', userUpdateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await iam.updateUser(c.get('actor'), c.req.valid('param').id, {
          name: body.name,
          namePresent: Object.prototype.hasOwnProperty.call(raw, 'name'),
          email: body.email,
          emailPresent: Object.prototype.hasOwnProperty.call(raw, 'email'),
          departmentId: body.departmentId,
          departmentIdPresent: Object.prototype.hasOwnProperty.call(raw, 'departmentId'),
          roleIds: body.roleIds,
          roleIdsPresent: Object.prototype.hasOwnProperty.call(raw, 'roleIds'),
          companyIds: body.companyIds,
          companyIdsPresent: Object.prototype.hasOwnProperty.call(raw, 'companyIds'),
        })
        return c.json(userDto(item))
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await iam.deleteUser(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function iamRoleRoutes(deps: { auth: AuthService; iam: IamService }) {
  const { auth, iam } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await iam.listRoles(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(roleDto) })
    })
    .post('/', zValidator('json', roleCreateSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const item = await iam.createRole(c.get('actor'), body)
      return c.json(roleDto(item), 201)
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      return c.json(roleDto(await iam.getRole(c.get('actor'), c.req.valid('param').id)))
    })
    .get('/:id/permissions', zValidator('param', idParam, validationHook), async (c) => {
      const rows = await iam.rolePermissions(c.get('actor'), c.req.valid('param').id)
      return c.json({ rows })
    })
    .put(
      '/:id/permissions',
      zValidator('param', idParam, validationHook),
      zValidator('json', permissionsSchema, validationHook),
      async (c) => {
        const permissions = await iam.syncRolePermissions(
          c.get('actor'),
          c.req.valid('param').id,
          c.req.valid('json').permissions,
        )
        return c.json({ permissions })
      },
    )
    .get('/:id/menus', zValidator('param', idParam, validationHook), async (c) => {
      const menuCodes = await iam.roleMenus(c.get('actor'), c.req.valid('param').id)
      return c.json({ menuCodes })
    })
    .put(
      '/:id/menus',
      zValidator('param', idParam, validationHook),
      zValidator('json', menusSchema, validationHook),
      async (c) => {
        const menuCodes = await iam.syncRoleMenus(
          c.get('actor'),
          c.req.valid('param').id,
          c.req.valid('json').menuCodes,
        )
        return c.json({ menuCodes })
      },
    )
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', roleUpdateSchema, validationHook),
      async (c) => {
        const item = await iam.updateRole(c.get('actor'), c.req.valid('param').id, c.req.valid('json'))
        return c.json(roleDto(item))
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await iam.deleteRole(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

/**
 * 部门路由：新授权体系的首个真实消费者。
 * 每个端点挂 `guard(资源, 动作)`（必须在 requireAuth 之后），handler 用 `permitOf(c)` 取凭证——
 * 服务层收 Permit，绕过鉴权直调服务在编译期不成立。
 */
export function iamDepartmentRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  departments: DepartmentService
}) {
  const { auth, authz, departments } = deps
  const guard = (action: string) => authz.guard(DEPARTMENT_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      guard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await departments.list(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(departmentDto) })
      },
    )
    .post(
      '/',
      guard('create'),
      zValidator('json', departmentCreateSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await departments.create(permitOf(c), {
          code: body.code,
          name: body.name,
          companyId: body.companyId,
          parentId: body.parentId,
        })
        return c.json(departmentDto(item), 201)
      },
    )
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(departmentDto(await departments.get(permitOf(c), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', departmentUpdateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await departments.update(permitOf(c), c.req.valid('param').id, {
          code: body.code,
          name: body.name,
          enabled: body.enabled,
          parentId: body.parentId,
          parentIdPresent: Object.prototype.hasOwnProperty.call(raw, 'parentId'),
        })
        return c.json(departmentDto(item))
      },
    )
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await departments.remove(permitOf(c), c.req.valid('param').id)
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
    email: u.email,
    departmentId: u.departmentId,
    department: u.department,
    preferredLanguage: u.preferredLanguage,
    insertedAt: u.insertedAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  }
}

function departmentDto(d: Awaited<ReturnType<DepartmentService['get']>>) {
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    enabled: d.enabled,
    companyId: d.companyId,
    parentId: d.parentId,
    company: d.company,
    parent: d.parent,
    hasChildren: d.hasChildren,
    insertedAt: d.insertedAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
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
