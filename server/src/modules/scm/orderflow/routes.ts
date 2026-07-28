import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
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

export function orderFlowRoutes(deps: { auth: AuthService; orderFlow: OrderFlowService }) {
  const { auth, orderFlow } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orderFlow.list(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      // path 可能含冒号，需 decode
      const id = decodeURIComponent(c.req.valid('param').id)
      return c.json(await orderFlow.get(c.get('actor'), id))
    })
}
