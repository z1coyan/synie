/**
 * 标准动作内核·路由派生：meta 声明的动作 → HTTP 端点。
 *
 * URL 形状与手写路由逐字一致（挂载点如 `/base/units`）：
 * - POST /query          read（列表查询）
 * - POST /               create
 * - GET /:id             read
 * - PATCH /:id           update（present-key 语义：出现即写，null 清空，缺省不动——
 *                        取代手写路由的 `*Present` 布尔）
 * - DELETE /:id          delete
 * - POST /bulk-update    batch_update（{ ids, patch }，单事务全成全败）
 * - POST /bulk-delete    batch_delete（{ ids }）
 *
 * 全部端点链式注册以保 ApiType 类型链（web hono/client 依赖）。因此标准派生
 * 资源必须声明完整标准词表（装配期断言）；只要部分动作的资源应弹射回手写路由。
 */
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
import type { Registry } from '~/platform/meta/registry.ts'
import { toDto } from './fields.ts'
import type { StandardService } from './service.ts'
import { deriveWireSchemas } from './wire.ts'

const idParam = z.object({ id: z.string().uuid() })
const idsSchema = z.array(z.string().uuid()).min(1).max(200)

/** 标准路由要求的动作全集（词表收敛的路由面） */
const REQUIRED_ACTIONS = ['read', 'create', 'update', 'delete', 'batch_update', 'batch_delete'] as const

export interface StandardRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  registry: Registry
  resource: string
  service: StandardService
}

export function standardRoutes(deps: StandardRouteDeps) {
  const { auth, authz, registry, resource, service } = deps
  const meta = registry.get(resource)
  if (!meta) throw new Error(`标准路由：未知 Meta 资源 ${resource}`)
  const declared = new Set(meta.actions.map((a) => a.key))
  for (const action of REQUIRED_ACTIONS) {
    if (!declared.has(action)) {
      throw new Error(`标准路由：资源 ${resource} 未声明动作 ${action}——标准派生要求完整词表，部分动作请弹射回手写路由`)
    }
  }
  const schemas = deriveWireSchemas(meta, service.stampedColumns)
  const guard = (action: string) => authz.guard(resource, action)
  const dto = (item: Record<string, unknown>) => toDto(meta, item)

  const bulkUpdateSchema = z.object({ ids: idsSchema, patch: schemas.update }).strict()
  const bulkDeleteSchema = z.object({ ids: idsSchema }).strict()

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const query: Partial<ListQuery> = {
        limit: body.limit,
        offset: body.offset,
        search: body.search,
        sort: body.sort,
        filter: body.filter as ListQuery['filter'],
      }
      const result = await service.list(permitOf(c), query)
      return c.json({ count: result.count, results: result.results.map(dto) })
    })
    .post('/', guard('create'), zValidator('json', schemas.create, validationHook), async (c) => {
      const item = await service.create(permitOf(c), c.req.valid('json') as Record<string, unknown>)
      return c.json(dto(item), 201)
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const item = await service.get(permitOf(c), c.req.valid('param').id)
      return c.json(dto(item))
    })
    .patch(
      '/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', schemas.update, validationHook),
      async (c) => {
        const item = await service.update(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json') as Record<string, unknown>,
        )
        return c.json(dto(item))
      },
    )
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await service.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/bulk-update', guard('batch_update'), zValidator('json', bulkUpdateSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const items = await service.bulkUpdate(permitOf(c), body.ids, body.patch as Record<string, unknown>)
      return c.json({ count: items.length, results: items.map(dto) })
    })
    .post('/bulk-delete', guard('batch_delete'), zValidator('json', bulkDeleteSchema, validationHook), async (c) => {
      const count = await service.bulkRemove(permitOf(c), c.req.valid('json').ids)
      return c.json({ count })
    })
}
