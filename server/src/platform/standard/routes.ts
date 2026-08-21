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
 * - POST /bulk-update    update（{ ids, patch }，单事务全成全败）
 * - POST /bulk-delete    delete（{ ids }）
 *
 * 全部端点链式注册以保 ApiType 类型链（web hono/client 依赖）。因此标准派生
 * 资源必须声明完整标准词表（装配期断言）；只要部分动作的资源应弹射回手写路由。
 *
 * 扩展点：超出一词一码的门控（跨资源 allOf、子行写 anyOf 等封闭词表内的组合子）
 * 经 `guards` 按端点声明式覆盖，不再为此整域弹射手写；真偏离词表的端点（跨实体
 * 写面、编排动作）仍按动作弹射——模块在同一挂载点先注册手写端点（同路径先注册
 * 胜出）再 `.route('/', standardRoutes(…))` 合并。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer, GuardOptions } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { StandardChildService } from './child.ts'
import { toDto } from './fields.ts'
import type { StandardService } from './service.ts'
import { deriveWireSchemas } from './wire.ts'

/** 模块补挂工作流端点（`standardRoutes(deps).post('/:id/audit', …)`）时复用 */
export const idParam = z.object({ id: z.string().uuid() })
export const idsSchema = z.array(z.string().uuid()).min(1).max(200)
/** 批量转移请求体（{ ids }）；带输入的转移由模块自建 schema */
export const bulkIdsSchema = z.object({ ids: idsSchema }).strict()

/** 标准路由要求的动作全集（词表收敛的路由面） */
const REQUIRED_ACTIONS = ['read', 'create', 'update', 'delete'] as const

/** 派生路由的端点键（guard 覆盖的寻址粒度） */
export type StandardRouteEndpoint =
  | 'query'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'bulkUpdate'
  | 'bulkDelete'

/**
 * 端点级 guard 覆盖：超出默认「一词一码」的码级组合子（封闭词表内）按端点声明。
 * - action 缺省取端点自身动作（query/get=read、bulk 同单条）；子行写「持归宿 update
 *   或 create 均可」这类重载用 action + anyOf 表达
 * - options 为 guard 的 allOf/anyOf；附加码从 `authz.targetOf(资源).prefix` 拼，不写字面量
 * 用法示例（模具设计连带写物料的跨资源 allOf）：
 *   standardRoutes({ …, guards: { delete: { options: { allOf: [`${prefix}:delete`] } } } })
 */
export interface StandardGuardOverride {
  action?: string
  options?: GuardOptions
}

/** 派生端点实际消费的服务面（StandardService 子集；适配器只需满足这一窄口） */
export type StandardRouteService = Pick<
  StandardService,
  'get' | 'list' | 'create' | 'update' | 'remove' | 'bulkUpdate' | 'bulkRemove' | 'stampedColumns'
>

/** 子行派生端点实际消费的服务面 */
export type StandardChildRouteService = Pick<
  StandardChildService,
  'get' | 'list' | 'create' | 'update' | 'remove' | 'stampedColumns'
>

/**
 * 聚合草稿整单替换的码级门控：一次 PUT 可同时新增/修改/删除子树，
 * 故要求 `update` ∧ `create` ∧ `delete`（附加码由 prefix 拼，不写字面量）。
 * 各聚合模块的手写路由共用本助手，不再各自复制。
 */
export function aggregateReplaceGuard(authz: AuthzEnforcer, headResource: string) {
  const { prefix } = authz.targetOf(headResource)
  return authz.guard(headResource, 'update', {
    allOf: [`${prefix}:create`, `${prefix}:delete`],
  })
}

export interface StandardRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  registry: Registry
  resource: string
  service: StandardRouteService
  /** 端点级 guard 覆盖（跨资源 allOf / 多码 anyOf），缺省端点用自身动作码 */
  guards?: Partial<Record<StandardRouteEndpoint, StandardGuardOverride>>
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
  const guardFor = (endpoint: StandardRouteEndpoint, action: string) => {
    const override = deps.guards?.[endpoint]
    return authz.guard(resource, override?.action ?? action, override?.options)
  }
  const dto = (item: Record<string, unknown>) => toDto(meta, item)

  const bulkUpdateSchema = z.object({ ids: idsSchema, patch: schemas.update }).strict()
  const bulkDeleteSchema = z.object({ ids: idsSchema }).strict()

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guardFor('query', 'read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
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
    .post('/', guardFor('create', 'create'), zValidator('json', schemas.create, validationHook), async (c) => {
      const item = await service.create(permitOf(c), c.req.valid('json') as Record<string, unknown>)
      return c.json(dto(item), 201)
    })
    .get('/:id', guardFor('get', 'read'), zValidator('param', idParam, validationHook), async (c) => {
      const item = await service.get(permitOf(c), c.req.valid('param').id)
      return c.json(dto(item))
    })
    .patch(
      '/:id',
      guardFor('update', 'update'),
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
    .delete('/:id', guardFor('delete', 'delete'), zValidator('param', idParam, validationHook), async (c) => {
      await service.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/bulk-update', guardFor('bulkUpdate', 'update'), zValidator('json', bulkUpdateSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const items = await service.bulkUpdate(permitOf(c), body.ids, body.patch as Record<string, unknown>)
      return c.json({ count: items.length, results: items.map(dto) })
    })
    .post('/bulk-delete', guardFor('bulkDelete', 'delete'), zValidator('json', bulkDeleteSchema, validationHook), async (c) => {
      const count = await service.bulkRemove(permitOf(c), c.req.valid('json').ids)
      return c.json({ count })
    })
}

/** 子行路由要求的动作集（单据行无批量端点，与既有手写形状一致） */
const CHILD_REQUIRED_ACTIONS = ['read', 'create', 'update', 'delete'] as const

export interface StandardChildRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  registry: Registry
  resource: string
  service: StandardChildRouteService
  /** 端点级 guard 覆盖（子行写「持归宿 update 或 create 均可」用 action:'update' + anyOf） */
  guards?: Partial<Record<StandardRouteEndpoint, StandardGuardOverride>>
}

/**
 * 子行标准路由（挂载点如 `/inventory/stock-doc-items`）：
 * POST /query、POST /、GET /:id、PATCH /:id、DELETE /:id。
 * 权限码用子行资源自己的动作码；行级可达性经 via 递归到母单。
 * 动作存在性按判定归宿（via 链根）校验：via 子行本地只声明 read，写动作码由宿主声明。
 */
export function standardChildRoutes(deps: StandardChildRouteDeps) {
  const { auth, authz, registry, resource, service } = deps
  const meta = registry.get(resource)
  if (!meta) throw new Error(`标准子行路由：未知 Meta 资源 ${resource}`)
  for (const action of CHILD_REQUIRED_ACTIONS) {
    if (!authz.hasAction(resource, action)) {
      throw new Error(`标准子行路由：资源 ${resource}（含判定归宿）未声明动作 ${action}——请弹射回手写路由`)
    }
  }
  const schemas = deriveWireSchemas(meta, service.stampedColumns)
  const guardFor = (endpoint: StandardRouteEndpoint, action: string) => {
    const override = deps.guards?.[endpoint]
    return authz.guard(resource, override?.action ?? action, override?.options)
  }
  const dto = (item: Record<string, unknown>) => toDto(meta, item)

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guardFor('query', 'read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
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
    .post('/', guardFor('create', 'create'), zValidator('json', schemas.create, validationHook), async (c) => {
      const item = await service.create(permitOf(c), c.req.valid('json') as Record<string, unknown>)
      return c.json(dto(item), 201)
    })
    .get('/:id', guardFor('get', 'read'), zValidator('param', idParam, validationHook), async (c) => {
      const item = await service.get(permitOf(c), c.req.valid('param').id)
      return c.json(dto(item))
    })
    .patch(
      '/:id',
      guardFor('update', 'update'),
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
    .delete('/:id', guardFor('delete', 'delete'), zValidator('param', idParam, validationHook), async (c) => {
      await service.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}
