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
import type { AccountService } from './account-service.ts'
import type { CompanyService } from './company-service.ts'
import { ACCOUNT_RESOURCE_NAME, COMPANY_RESOURCE_NAME } from './meta.ts'

const idParam = z.object({ id: z.string().uuid() })

const companyCreateSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    shortName: z.string().min(1),
    parentId: z.string().uuid().nullable().optional(),
    baseCurrencyId: z.string().uuid(),
  })
  .strict()

const companyUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    shortName: z.string().min(1).optional(),
    parentId: z.string().uuid().nullable().optional(),
    baseCurrencyId: z.string().uuid().optional(),
  })
  .strict()

const accountDirectionSchema = z.enum(['DEBIT', 'CREDIT'])

const accountCreateSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    direction: accountDirectionSchema,
    isGroup: z.boolean().optional(),
    active: z.boolean().optional(),
    role: z.string().nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
    companyId: z.string().uuid(),
    currencyId: z.string().uuid().nullable().optional(),
  })
  .strict()

const accountUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    direction: accountDirectionSchema.optional(),
    isGroup: z.boolean().optional(),
    active: z.boolean().optional(),
    role: z.string().nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
    currencyId: z.string().uuid().nullable().optional(),
  })
  .strict()

const accountTemplateSchema = z
  .object({
    companyId: z.string().uuid(),
    template: z.enum(['CAS', 'SMALL', 'INTL', 'cas', 'small', 'intl']),
  })
  .strict()

export interface BaseRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  companies: CompanyService
  accounts: AccountService
}

/**
 * 挂载于 /base（公司/科目——尚未标准派生的两资源）。
 * 货币/单位已迁 platform/standard 派生路由，见 app.ts 的 /base/currencies、/base/units。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 动作码唯一事实源是 meta：科目模板初始化未声明独立动作，沿用 create 门控。
 */
export function baseRoutes(deps: BaseRouteDeps) {
  const { auth, authz, companies, accounts } = deps
  const companyGuard = (action: string) => authz.guard(COMPANY_RESOURCE_NAME, action)
  const accountGuard = (action: string) => authz.guard(ACCOUNT_RESOURCE_NAME, action)

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    // —— 公司 ——
    .post(
      '/companies/query',
      companyGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
      const result = await companies.list(permitOf(c), toListQuery(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(companyDto) })
    })
    .post(
      '/companies',
      companyGuard('create'),
      zValidator('json', companyCreateSchema, validationHook),
      async (c) => {
      const body = c.req.valid('json')
      const item = await companies.create(permitOf(c), {
        code: body.code,
        name: body.name,
        shortName: body.shortName,
        parentId: body.parentId,
        baseCurrencyId: body.baseCurrencyId,
      })
      return c.json(companyDto(item), 201)
    })
    .get(
      '/companies/:id',
      companyGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      const item = await companies.get(permitOf(c), c.req.valid('param').id)
      return c.json(companyDto(item))
    })
    .patch(
      '/companies/:id',
      companyGuard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', companyUpdateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await companies.update(permitOf(c), c.req.valid('param').id, {
          name: body.name,
          shortName: body.shortName,
          parentId: body.parentId,
          parentIdPresent: Object.prototype.hasOwnProperty.call(raw, 'parentId'),
          baseCurrencyId: body.baseCurrencyId,
        })
        return c.json(companyDto(item))
      },
    )
    .delete(
      '/companies/:id',
      companyGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      await companies.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
    // —— 会计科目 ——
    .post(
      '/accounts/query',
      accountGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
      const result = await accounts.list(permitOf(c), toListQuery(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(accountDto) })
    })
    .post(
      '/accounts/init-template',
      accountGuard('create'),
      zValidator('json', accountTemplateSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const result = await accounts.initializeTemplate(
          permitOf(c),
          body.companyId,
          body.template,
        )
        return c.json({ createdCount: result.createdCount }, 201)
      },
    )
    .post(
      '/accounts',
      accountGuard('create'),
      zValidator('json', accountCreateSchema, validationHook),
      async (c) => {
      const body = c.req.valid('json')
      const item = await accounts.create(permitOf(c), {
        code: body.code,
        name: body.name,
        direction: body.direction,
        isGroup: body.isGroup,
        active: body.active,
        role: body.role,
        parentId: body.parentId,
        companyId: body.companyId,
        currencyId: body.currencyId,
      })
      return c.json(accountDto(item), 201)
    })
    .get(
      '/accounts/:id',
      accountGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      const item = await accounts.get(permitOf(c), c.req.valid('param').id)
      return c.json(accountDto(item))
    })
    .patch(
      '/accounts/:id',
      accountGuard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', accountUpdateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await accounts.update(permitOf(c), c.req.valid('param').id, {
          name: body.name,
          direction: body.direction,
          isGroup: body.isGroup,
          active: body.active,
          role: body.role,
          rolePresent: Object.prototype.hasOwnProperty.call(raw, 'role'),
          parentId: body.parentId,
          parentIdPresent: Object.prototype.hasOwnProperty.call(raw, 'parentId'),
          currencyId: body.currencyId,
          currencyIdPresent: Object.prototype.hasOwnProperty.call(raw, 'currencyId'),
        })
        return c.json(accountDto(item))
      },
    )
    .delete(
      '/accounts/:id',
      accountGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      await accounts.remove(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

function toListQuery(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

function companyDto(item: Awaited<ReturnType<CompanyService['get']>>) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    shortName: item.shortName,
    parentId: item.parentId,
    baseCurrencyId: item.baseCurrencyId,
    parent: item.parent,
    baseCurrency: item.baseCurrency,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

function accountDto(item: Awaited<ReturnType<AccountService['get']>>) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    direction: item.direction,
    isGroup: item.isGroup,
    active: item.active,
    role: item.role,
    parentId: item.parentId,
    companyId: item.companyId,
    currencyId: item.currencyId,
    parent: item.parent,
    company: item.company,
    currency: item.currency,
    hasChildren: item.hasChildren,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}
