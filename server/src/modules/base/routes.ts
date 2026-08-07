import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, toListQuery, validationHook } from '~/platform/http/zod.ts'
import { idParam } from '~/platform/standard/routes.ts'
import { deriveWireSchemas } from '~/platform/standard/wire.ts'
import type { AccountService } from './account-service.ts'
import type { CompanyService } from './company-service.ts'
import { ACCOUNT_RESOURCE_NAME, COMPANY_RESOURCE_NAME } from './meta.ts'

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
 * 挂载于 /base（公司/科目——服务已标准派生，路由按动作弹射保留手写）。
 * 货币/单位走 platform/standard 派生路由，见 app.ts 的 /base/currencies、/base/units。
 *
 * 手写理由：两资源的 wire 含嵌套对象（parent/baseCurrency/company/currency/hasChildren），
 * 标准路由的通用 toDto 返回 Record 会宽化 ApiType、打断 web 的 hc 类型链；
 * 且标准路由要求完整词表（批量动作），两资源现只有 CRUD 四码。
 * wire schema 仍自 meta 派生（唯一事实源），PATCH 即 present-key 语义：
 * 出现即写、null 清空、缺省不动（zod 可选字段天然如此，不再需要 `*Present` 布尔）。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 动作码唯一事实源是 meta：科目模板初始化未声明独立动作，沿用 create 门控。
 */
export function baseRoutes(deps: BaseRouteDeps) {
  const { auth, authz, companies, accounts } = deps
  const companyGuard = (action: string) => authz.guard(COMPANY_RESOURCE_NAME, action)
  const accountGuard = (action: string) => authz.guard(ACCOUNT_RESOURCE_NAME, action)
  const companySchemas = deriveWireSchemas(companies.meta, companies.stampedColumns)
  const accountSchemas = deriveWireSchemas(accounts.meta, accounts.stampedColumns)

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
      zValidator('json', companySchemas.create, validationHook),
      async (c) => {
      const item = await companies.create(permitOf(c), c.req.valid('json') as Record<string, unknown>)
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
      zValidator('json', companySchemas.update, validationHook),
      async (c) => {
        const item = await companies.update(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json') as Record<string, unknown>,
        )
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
      zValidator('json', accountSchemas.create, validationHook),
      async (c) => {
      const item = await accounts.create(permitOf(c), c.req.valid('json') as Record<string, unknown>)
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
      zValidator('json', accountSchemas.update, validationHook),
      async (c) => {
        const item = await accounts.update(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json') as Record<string, unknown>,
        )
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

/** DTO 保持手写显式形状：hc 类型链需要精确键型（标准 toDto 的 Record 会宽化 ApiType） */
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
