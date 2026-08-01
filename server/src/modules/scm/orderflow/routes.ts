import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { hasPermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { validationHook } from '~/platform/http/zod.ts'
import { ORDER_FLOW_SOURCE_READ_PERMISSIONS } from './meta.ts'
import type { OrderFlowService } from './service.ts'

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const idParam = z.object({ id: z.string().min(1) })

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

/** 鉴权先于 body 解码：权限拒绝必须 403（对齐 Go permission-first） */
function requireOrderFlowRead() {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    const actor = c.get('actor')
    const ok = ORDER_FLOW_SOURCE_READ_PERMISSIONS.some((p) => hasPermission(actor, p))
    if (!ok) throw new ApiError('forbidden', '无权限读取订单收发货历史')
    await next()
  }
}

export function orderFlowRoutes(deps: { auth: AuthService; orderFlow: OrderFlowService }) {
  const { auth, orderFlow } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requireOrderFlowRead(),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await orderFlow.list(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .get('/:id', requireOrderFlowRead(), zValidator('param', idParam, validationHook), async (c) => {
      const id = decodeURIComponent(c.req.valid('param').id)
      return c.json(await orderFlow.get(c.get('actor'), id))
    })
}
