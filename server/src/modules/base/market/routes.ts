import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import { PRICE_POINT_RESOURCE_NAME } from './meta.ts'
import type { MarketPricePoint, MarketService, PriceSeries } from './service.ts'


const idParam = z.object({ id: z.string().uuid() })

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

/**
 * 挂载于 `/base/market-price-points`。
 * 图区（chart-instruments / price-series）与手动刷新沿用已声明动作：
 * 图区是 read，刷新是 create（meta 未声明 refresh 独立动作，不为好看新增权限码）。
 */
export function marketPricePointRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  market: MarketService
}) {
  const { auth, authz, market } = deps
  const pointGuard = (action: string) => authz.guard(PRICE_POINT_RESOURCE_NAME, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      pointGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await market.listPricePoints(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({
          count: result.count,
          results: result.results.map(pricePointDto),
        })
      },
    )
    .get(
      '/chart-instruments',
      pointGuard('read'),
      async (c) => {
        return c.json(await market.chartInstruments(permitOf(c)))
      },
    )
    .post(
      '/price-series',
      pointGuard('read'),
      zValidator('json', priceSeriesSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const result = await market.priceSeries(
          permitOf(c),
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
      pointGuard('create'),
      zValidator('json', refreshSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const result = await market.refresh(permitOf(c), body.instrumentId ?? null)
        return c.json(result)
      },
    )
    .post(
      '/',
      pointGuard('create'),
      zValidator('json', pricePointCreateSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const item = await market.createPricePoint(permitOf(c), {
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
      pointGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        return c.json(pricePointDto(await market.getPricePoint(permitOf(c), c.req.valid('param').id)))
      },
    )
    .post(
      '/:id/void',
      pointGuard('void'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await market.voidPricePoint(permitOf(c), c.req.valid('param').id)
        return c.json(pricePointDto(item))
      },
    )
}
