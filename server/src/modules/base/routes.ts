import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { AccountService } from './account-service.ts'
import type { CompanyService } from './company-service.ts'
import type { CurrencyService } from './currency-service.ts'
import type { UnitService } from './unit-service.ts'

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({
        column: z.string(),
        direction: z.enum(['ascending', 'descending']),
      })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const idParam = z.object({ id: z.string().uuid() })

const currencyCreateSchema = z
  .object({
    name: z.string().min(1),
    isoCode: z.string().min(1),
    symbol: z.string().nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()

const currencyUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    symbol: z.string().nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()

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

const unitTypeSchema = z.enum(['LENGTH', 'AREA', 'WEIGHT', 'QUANTITY'])

const unitCreateSchema = z
  .object({
    unitType: unitTypeSchema,
    isBase: z.boolean().optional(),
    name: z.string().min(1),
    symbol: z.string().min(1),
    ratio: z.string().min(1),
  })
  .strict()

const unitUpdateSchema = z
  .object({
    unitType: unitTypeSchema.optional(),
    isBase: z.boolean().optional(),
    name: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    ratio: z.string().min(1).optional(),
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
  currencies: CurrencyService
  companies: CompanyService
  units: UnitService
  accounts: AccountService
}

/** 挂载于 /base（对齐 OpenAPI：/base/currencies|companies|units|accounts） */
/** 权限中间件：必须挂在 zValidator 之前 */
function requirePerm(code: string) {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    requirePermission(c.get('actor'), code)
    await next()
  }
}

export function baseRoutes(deps: BaseRouteDeps) {
  const { auth, currencies, companies, units, accounts } = deps

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    // —— 货币 ——
    .post(
      '/currencies/query',
      requirePerm('base.currency:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
      const result = await currencies.list(toListQuery(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(currencyDto) })
    })
    .post(
      '/currencies',
      requirePerm('base.currency:create'),
      zValidator('json', currencyCreateSchema, validationHook),
      async (c) => {
      const body = c.req.valid('json')
      const item = await currencies.create(c.get('actor'), {
        name: body.name,
        isoCode: body.isoCode,
        symbol: body.symbol,
        active: body.active,
      })
      return c.json(currencyDto(item), 201)
    })
    .get(
      '/currencies/:id',
      requirePerm('base.currency:read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      const item = await currencies.get(c.req.valid('param').id)
      return c.json(currencyDto(item))
    })
    .patch(
      '/currencies/:id',
      requirePerm('base.currency:update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', currencyUpdateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await currencies.update(c.get('actor'), c.req.valid('param').id, {
          name: body.name,
          symbol: body.symbol,
          symbolPresent: Object.prototype.hasOwnProperty.call(raw, 'symbol'),
          active: body.active,
        })
        return c.json(currencyDto(item))
      },
    )
    .delete(
      '/currencies/:id',
      requirePerm('base.currency:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      await currencies.remove(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    // —— 公司 ——
    .post(
      '/companies/query',
      requirePerm('base.company:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
      const result = await companies.list(toListQuery(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(companyDto) })
    })
    .post(
      '/companies',
      requirePerm('base.company:create'),
      zValidator('json', companyCreateSchema, validationHook),
      async (c) => {
      const body = c.req.valid('json')
      const item = await companies.create(c.get('actor'), {
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
      requirePerm('base.company:read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      const item = await companies.get(c.req.valid('param').id)
      return c.json(companyDto(item))
    })
    .patch(
      '/companies/:id',
      requirePerm('base.company:update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', companyUpdateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await companies.update(c.get('actor'), c.req.valid('param').id, {
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
      requirePerm('base.company:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      await companies.remove(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    // —— 计量单位 ——
    .post(
      '/units/query',
      requirePerm('base.unit:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
      const result = await units.list(toListQuery(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(unitDto) })
    })
    .post(
      '/units',
      requirePerm('base.unit:create'),
      zValidator('json', unitCreateSchema, validationHook),
      async (c) => {
      const body = c.req.valid('json')
      const item = await units.create(c.get('actor'), {
        unitType: body.unitType,
        isBase: body.isBase,
        name: body.name,
        symbol: body.symbol,
        ratio: body.ratio,
      })
      return c.json(unitDto(item), 201)
    })
    .get(
      '/units/:id',
      requirePerm('base.unit:read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      const item = await units.get(c.req.valid('param').id)
      return c.json(unitDto(item))
    })
    .patch(
      '/units/:id',
      requirePerm('base.unit:update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', unitUpdateSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await units.update(c.get('actor'), c.req.valid('param').id, {
          unitType: body.unitType,
          isBase: body.isBase,
          name: body.name,
          symbol: body.symbol,
          ratio: body.ratio,
        })
        return c.json(unitDto(item))
      },
    )
    .delete(
      '/units/:id',
      requirePerm('base.unit:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      await units.remove(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    // —— 会计科目 ——
    .post(
      '/accounts/query',
      requirePerm('base.account:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
      const result = await accounts.list(c.get('actor'), toListQuery(c.req.valid('json')))
      return c.json({ count: result.count, results: result.results.map(accountDto) })
    })
    .post(
      '/accounts/init-template',
      requirePerm('base.account:create'),
      zValidator('json', accountTemplateSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const result = await accounts.initializeTemplate(
          c.get('actor'),
          body.companyId,
          body.template,
        )
        return c.json({ createdCount: result.createdCount }, 201)
      },
    )
    .post(
      '/accounts',
      requirePerm('base.account:create'),
      zValidator('json', accountCreateSchema, validationHook),
      async (c) => {
      const body = c.req.valid('json')
      const item = await accounts.create(c.get('actor'), {
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
      requirePerm('base.account:read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      const item = await accounts.get(c.get('actor'), c.req.valid('param').id)
      return c.json(accountDto(item))
    })
    .patch(
      '/accounts/:id',
      requirePerm('base.account:update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', accountUpdateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await accounts.update(c.get('actor'), c.req.valid('param').id, {
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
      requirePerm('base.account:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
      await accounts.remove(c.get('actor'), c.req.valid('param').id)
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

function currencyDto(item: Awaited<ReturnType<CurrencyService['get']>>) {
  return {
    id: item.id,
    name: item.name,
    isoCode: item.isoCode,
    symbol: item.symbol,
    active: item.active,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
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

function unitDto(item: Awaited<ReturnType<UnitService['get']>>) {
  return {
    id: item.id,
    unitType: item.unitType,
    isBase: item.isBase,
    name: item.name,
    symbol: item.symbol,
    ratio: item.ratio,
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

