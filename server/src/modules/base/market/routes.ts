import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { validationHook } from '~/platform/http/zod.ts'
import {
  INSTRUMENT_PERMISSION_PREFIX,
  PRICE_POINT_PERMISSION_PREFIX,
} from './meta.ts'
import type {
  MarketInstrument,
  MarketPricePoint,
  MarketService,
  PriceSeries,
} from './service.ts'

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

const instrumentCreateSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    sourceType: z.string().min(1),
    defaultPriceKind: z.string().min(1),
    active: z.boolean().optional(),
    fetchEnabled: z.boolean().optional(),
    externalLastCode: z.string().nullable().optional(),
    externalProductGroup: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    currencyId: z.string().uuid(),
    unitId: z.string().uuid(),
  })
  .strict()

const instrumentUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    defaultPriceKind: z.string().min(1).optional(),
    active: z.boolean().optional(),
    fetchEnabled: z.boolean().optional(),
    externalLastCode: z.string().nullable().optional(),
    externalProductGroup: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .strict()

const pricePointCreateSchema = z
  .object({
    instrumentId: z.string().uuid(),
    observedAt: z.string().min(1),
    price: z.string().min(1),
    priceKind: z.string().optional(),
    note: z.string().nullable().optional(),
  })
  .strict()

const priceSeriesSchema = z
  .object({
    instrumentIds: z.array(z.string().uuid()),
    priceKind: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict()

const refreshSchema = z
  .object({
    instrumentId: z.string().uuid().nullable().optional(),
  })
  .strict()

function present(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
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

/** 对齐 Go time.RFC3339：整秒无毫秒后缀 */
function rfc3339(d: Date): string {
  if (d.getUTCMilliseconds() === 0) {
    return d.toISOString().replace('.000Z', 'Z')
  }
  return d.toISOString()
}

function instrumentDto(item: MarketInstrument) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    sourceType: item.sourceType,
    defaultPriceKind: item.defaultPriceKind,
    active: item.active,
    fetchEnabled: item.fetchEnabled,
    externalLastCode: item.externalLastCode,
    externalProductGroup: item.externalProductGroup,
    note: item.note,
    currencyId: item.currencyId,
    unitId: item.unitId,
    insertedAt: rfc3339(item.insertedAt),
    updatedAt: rfc3339(item.updatedAt),
  }
}

function pricePointDto(item: MarketPricePoint) {
  return {
    id: item.id,
    observedAt: rfc3339(item.observedAt),
    price: item.price,
    priceKind: item.priceKind,
    source: item.source,
    isVoided: item.isVoided,
    note: item.note,
    instrumentId: item.instrumentId,
    currencyId: item.currencyId,
    unitId: item.unitId,
    insertedAt: rfc3339(item.insertedAt),
    updatedAt: rfc3339(item.updatedAt),
  }
}

function priceSeriesDto(result: PriceSeries) {
  return {
    priceKind: result.priceKind,
    from: rfc3339(result.from),
    to: rfc3339(result.to),
    series: result.series.map((item) => ({
      id: item.id,
      instrumentId: item.instrumentId,
      code: item.code,
      name: item.name,
      currencyId: item.currencyId,
      unitId: item.unitId,
      currencyCode: item.currencyCode,
      unitName: item.unitName,
      defaultPriceKind: item.defaultPriceKind,
      points: item.points.map((p) => ({
        observedAt: rfc3339(p.observedAt),
        price: p.price,
      })),
    })),
  }
}

function parseDateTime(value: string, field: string): Date {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw ApiError.validation('时间格式不合法', { [field]: ['必须是 RFC3339 时间'] })
  }
  return d
}

/** 挂载于 `/base/market-instruments` */
export function marketInstrumentRoutes(deps: {
  auth: AuthService
  market: MarketService
}) {
  const { auth, market } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm(`${INSTRUMENT_PERMISSION_PREFIX}:read`),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await market.listInstruments(toListQuery(c.req.valid('json')))
        return c.json({
          count: result.count,
          results: result.results.map(instrumentDto),
        })
      },
    )
    .post(
      '/',
      requirePerm(`${INSTRUMENT_PERMISSION_PREFIX}:create`),
      zValidator('json', instrumentCreateSchema, validationHook),
      async (c) => {
        const actor = c.get('actor')!
        const body = c.req.valid('json')
        const item = await market.createInstrument(actor, body)
        return c.json(instrumentDto(item), 201)
      },
    )
    .get(
      '/:id',
      requirePerm(`${INSTRUMENT_PERMISSION_PREFIX}:read`),
      zValidator('param', idParam, validationHook),
      async (c) => {
        return c.json(instrumentDto(await market.getInstrument(c.req.valid('param').id)))
      },
    )
    .patch(
      '/:id',
      requirePerm(`${INSTRUMENT_PERMISSION_PREFIX}:update`),
      zValidator('param', idParam, validationHook),
      zValidator('json', instrumentUpdateSchema, validationHook),
      async (c) => {
        const actor = c.get('actor')!
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await market.updateInstrument(actor, c.req.valid('param').id, {
          name: body.name,
          defaultPriceKind: body.defaultPriceKind,
          active: body.active,
          fetchEnabled: body.fetchEnabled,
          externalLastCode: body.externalLastCode,
          externalLastCodePresent: present(raw, 'externalLastCode'),
          externalProductGroup: body.externalProductGroup,
          externalProductGroupPresent: present(raw, 'externalProductGroup'),
          note: body.note,
          notePresent: present(raw, 'note'),
        })
        return c.json(instrumentDto(item))
      },
    )
    .delete(
      '/:id',
      requirePerm(`${INSTRUMENT_PERMISSION_PREFIX}:delete`),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const actor = c.get('actor')!
        await market.deleteInstrument(actor, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

/** 挂载于 `/base/market-price-points` */
export function marketPricePointRoutes(deps: {
  auth: AuthService
  market: MarketService
}) {
  const { auth, market } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm(`${PRICE_POINT_PERMISSION_PREFIX}:read`),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await market.listPricePoints(toListQuery(c.req.valid('json')))
        return c.json({
          count: result.count,
          results: result.results.map(pricePointDto),
        })
      },
    )
    .get(
      '/chart-instruments',
      requirePerm(`${PRICE_POINT_PERMISSION_PREFIX}:read`),
      async (c) => {
        return c.json(await market.chartInstruments())
      },
    )
    .post(
      '/price-series',
      requirePerm(`${PRICE_POINT_PERMISSION_PREFIX}:read`),
      zValidator('json', priceSeriesSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const result = await market.priceSeries(
          body.instrumentIds,
          body.priceKind,
          parseDateTime(body.from, 'from'),
          parseDateTime(body.to, 'to'),
        )
        return c.json(priceSeriesDto(result))
      },
    )
    .post(
      '/refresh',
      requirePerm(`${PRICE_POINT_PERMISSION_PREFIX}:create`),
      zValidator('json', refreshSchema, validationHook),
      async (c) => {
        const actor = c.get('actor')!
        const body = c.req.valid('json')
        const result = await market.refresh(actor, body.instrumentId ?? null)
        return c.json(result)
      },
    )
    .post(
      '/',
      requirePerm(`${PRICE_POINT_PERMISSION_PREFIX}:create`),
      zValidator('json', pricePointCreateSchema, validationHook),
      async (c) => {
        const actor = c.get('actor')!
        const body = c.req.valid('json')
        const item = await market.createPricePoint(actor, {
          instrumentId: body.instrumentId,
          observedAt: parseDateTime(body.observedAt, 'observedAt'),
          price: body.price,
          priceKind: body.priceKind,
          source: 'MANUAL',
          note: body.note,
        })
        return c.json(pricePointDto(item), 201)
      },
    )
    .get(
      '/:id',
      requirePerm(`${PRICE_POINT_PERMISSION_PREFIX}:read`),
      zValidator('param', idParam, validationHook),
      async (c) => {
        return c.json(pricePointDto(await market.getPricePoint(c.req.valid('param').id)))
      },
    )
    .post(
      '/:id/void',
      requirePerm(`${PRICE_POINT_PERMISSION_PREFIX}:void`),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const actor = c.get('actor')!
        const item = await market.voidPricePoint(actor, c.req.valid('param').id)
        return c.json(pricePointDto(item))
      },
    )
}

/** 兼容旧命名 */
export function marketInstrumentRoutesLegacy(deps: {
  auth: AuthService
  instruments: MarketService
}) {
  return marketInstrumentRoutes({ auth: deps.auth, market: deps.instruments })
}
