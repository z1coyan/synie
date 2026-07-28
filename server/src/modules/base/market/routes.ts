import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import { PERMISSION_PREFIX } from './meta.ts'
import type { MarketInstrument, MarketInstrumentService } from './service.ts'

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

function instrumentDto(item: MarketInstrument) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    sourceType: item.sourceType,
    defaultPriceKind: item.defaultPriceKind,
    active: item.active,
    fetchEnabled: item.fetchEnabled,
    currencyId: item.currencyId,
    unitId: item.unitId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
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

/** 挂载于 `/base/market-instruments` */
export function marketInstrumentRoutes(deps: {
  auth: AuthService
  instruments: MarketInstrumentService
}) {
  const { auth, instruments } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm(`${PERMISSION_PREFIX}:read`),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await instruments.list(toListQuery(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results.map(instrumentDto) })
      },
    )
    .get(
      '/:id',
      requirePerm(`${PERMISSION_PREFIX}:read`),
      zValidator('param', idParam, validationHook),
      async (c) => {
        return c.json(instrumentDto(await instruments.get(c.req.valid('param').id)))
      },
    )
}
