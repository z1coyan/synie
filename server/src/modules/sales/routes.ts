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
import { idParam } from '~/platform/standard/routes.ts'
import { deriveWireSchemas } from '~/platform/standard/wire.ts'
import {
  DEFAULT_RESOURCE,
  type CompanyAccountDefaultService,
} from './company-account-default.ts'

const companyParam = z.object({ companyId: z.string().uuid() })

/**
 * 手写路由（按动作弹射）：本资源只有 read/update 两个权限码——创建沿用 update 门控、
 * 无删除与批量端点，故标准路由（要求完整词表）不适用；wire schema 与 DTO 仍自 meta 派生。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后）；handler 用 `permitOf(c)` 取凭证。
 * PATCH 为 present-key 语义：出现即写、null 清空、缺省不动（zod 可选字段天然如此）。
 */
export function companyAccountDefaultRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  defaults: CompanyAccountDefaultService
}) {
  const { auth, authz, defaults } = deps
  const meta = defaults.meta
  const schemas = deriveWireSchemas(meta, defaults.stampedColumns)
  // DTO 保持手写显式形状：hc 类型链需要精确键型（toDto 的 Record 会宽化 ApiType）
  const dto = (item: Awaited<ReturnType<CompanyAccountDefaultService['get']>>) => ({
    id: item.id,
    companyId: item.companyId,
    deliveryDebitAccountId: item.deliveryDebitAccountId,
    deliveryCreditAccountId: item.deliveryCreditAccountId,
    receiptDebitAccountId: item.receiptDebitAccountId,
    receiptCreditAccountId: item.receiptCreditAccountId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  })
  const defaultGuard = (action: string) => authz.guard(DEFAULT_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', defaultGuard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await defaults.list(permitOf(c), {
        limit: c.req.valid('json').limit,
        offset: c.req.valid('json').offset,
        search: c.req.valid('json').search,
        sort: c.req.valid('json').sort,
        filter: c.req.valid('json').filter as ListQuery['filter'],
      })
      return c.json({ count: result.count, results: result.results.map(dto) })
    })
    // 创建无独立权限码：按现状由 update 门控
    .post('/', defaultGuard('update'), zValidator('json', schemas.create, validationHook), async (c) => {
      const item = await defaults.create(permitOf(c), c.req.valid('json') as Record<string, unknown>)
      return c.json(dto(item), 201)
    })
    .get(
      '/by-company/:companyId',
      defaultGuard('read'),
      zValidator('param', companyParam, validationHook),
      async (c) => {
        const item = await defaults.getByCompany(
          permitOf(c),
          c.req.valid('param').companyId,
        )
        return c.json(dto(item))
      },
    )
    .get('/:id', defaultGuard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(dto(await defaults.get(permitOf(c), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      defaultGuard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', schemas.update, validationHook),
      async (c) => {
        const item = await defaults.update(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json') as Record<string, unknown>,
        )
        return c.json(dto(item))
      },
    )
}
