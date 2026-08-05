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
import {
  DEFAULT_RESOURCE,
  type CompanyAccountDefaultService,
} from './company-account-default.ts'

const idParam = z.object({ id: z.string().uuid() })
const companyParam = z.object({ companyId: z.string().uuid() })

const createSchema = z
  .object({
    companyId: z.string().uuid(),
    deliveryDebitAccountId: z.string().uuid().nullable().optional(),
    deliveryCreditAccountId: z.string().uuid().nullable().optional(),
    receiptDebitAccountId: z.string().uuid().nullable().optional(),
    receiptCreditAccountId: z.string().uuid().nullable().optional(),
  })
  .strict()

const updateSchema = z
  .object({
    deliveryDebitAccountId: z.string().uuid().nullable().optional(),
    deliveryCreditAccountId: z.string().uuid().nullable().optional(),
    receiptDebitAccountId: z.string().uuid().nullable().optional(),
    receiptCreditAccountId: z.string().uuid().nullable().optional(),
  })
  .strict()

function present(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

/**
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后）；handler 用 `permitOf(c)` 取凭证。
 * 动作码唯一事实源是 meta：创建未声明独立动作，沿用 update 门控（不新增权限码）。
 */
export function companyAccountDefaultRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  defaults: CompanyAccountDefaultService
}) {
  const { auth, authz, defaults } = deps
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
    .post('/', defaultGuard('update'), zValidator('json', createSchema, validationHook), async (c) => {
      const item = await defaults.create(permitOf(c), c.req.valid('json'))
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
      zValidator('json', updateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await defaults.update(permitOf(c), c.req.valid('param').id, {
          deliveryDebitAccountId: body.deliveryDebitAccountId,
          deliveryDebitPresent: present(raw, 'deliveryDebitAccountId'),
          deliveryCreditAccountId: body.deliveryCreditAccountId,
          deliveryCreditPresent: present(raw, 'deliveryCreditAccountId'),
          receiptDebitAccountId: body.receiptDebitAccountId,
          receiptDebitPresent: present(raw, 'receiptDebitAccountId'),
          receiptCreditAccountId: body.receiptCreditAccountId,
          receiptCreditPresent: present(raw, 'receiptCreditAccountId'),
        })
        return c.json(dto(item))
      },
    )
}

function dto(item: Awaited<ReturnType<CompanyAccountDefaultService['get']>>) {
  return {
    id: item.id,
    companyId: item.companyId,
    deliveryDebitAccountId: item.deliveryDebitAccountId,
    deliveryCreditAccountId: item.deliveryCreditAccountId,
    receiptDebitAccountId: item.receiptDebitAccountId,
    receiptCreditAccountId: item.receiptCreditAccountId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}
