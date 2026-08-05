/**
 * 订单收发货历史只读投影 REST（挂载于 /base/order-flow-items）。
 *
 * 该资源无独立权限点：read 的码级组合子由 meta 的 `authz.readAnyOf` 声明，
 * guard 直接编译成 anyOf（四种来源单据任一 read 即可读），路由不再手写析取。
 */
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
import { FLOW_RESOURCE, type OrderFlowService } from './service.ts'

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

export function orderFlowRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  orderFlow: OrderFlowService
}) {
  const { auth, authz, orderFlow } = deps
  const flowGuard = (action: string) => authz.guard(FLOW_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      flowGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await orderFlow.list(permitOf(c), toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .get('/:id', flowGuard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const id = decodeURIComponent(c.req.valid('param').id)
      return c.json(await orderFlow.get(permitOf(c), id))
    })
}
