/**
 * 待办 REST：/todos/query、/todos/unread-count、/todos/{id}/read|dismiss
 * 权限码来自 TodoSourceRegistry（业务域注册），本层不硬编码业务权限。
 *
 * 待办无独立权限点：可读性 = 各源权限码的**析取**（D6），
 * 由 `todoPermit` 用封闭代数的 anyOf 组合子执行；服务只收 Permit。
 */
import { zValidator } from '@hono/zod-validator'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import { idParam } from '../standard/routes.ts'
import { todoPermit, type Todo, type TodoService } from './service.ts'
import { ApiError } from '~/platform/http/errors.ts'

const listQuerySchema = z
  .object({
    tab: z.enum(['active', 'history', 'recent']).optional().default('active'),
    includeDismissed: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().max(256).optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

function todoDto(item: Todo) {
  return {
    id: item.id,
    type: item.type,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    sourceNo: item.sourceNo,
    partyType: item.partyType,
    partyId: item.partyId,
    partyName: item.partyName,
    amount: item.amount,
    status: item.status,
    closedReason: item.closedReason,
    sourceChangedAt: item.sourceChangedAt,
    closedAt: item.closedAt,
    insertedAt: item.insertedAt,
    updatedAt: item.updatedAt,
    draftInvoiceLinked: item.draftInvoiceLinked,
    myReadAt: item.myReadAt,
    myDismissedAt: item.myDismissedAt,
    dismissed: item.dismissed,
    companyId: item.companyId,
    createdById: item.createdById,
    company: item.company,
    createdBy: item.createdBy,
  }
}

export function todoRoutes(deps: { auth: AuthService; todos: TodoService }) {
  const { auth, todos } = deps
  const permit = (c: Context<AppEnv>, kind: 'action' | 'unread') => {
    const actor = c.get('actor')
    if (!actor) throw new ApiError('unauthorized', '未登录或登录状态已失效')
    return todoPermit(actor, todos.sources, kind)
  }
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .get('/unread-count', async (c) => {
      const count = await todos.unreadCount(permit(c, 'unread'))
      return c.json({ count })
    })
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const result = await todos.list(permit(c, 'action'), {
        tab: body.tab,
        includeDismissed: body.includeDismissed,
        limit: body.limit,
        offset: body.offset,
        search: body.search,
        sort: body.sort,
        filter: body.filter as ListQuery['filter'],
      })
      return c.json({
        count: result.count,
        results: result.results.map(todoDto),
      })
    })
    .post('/:id/read', zValidator('param', idParam, validationHook), async (c) => {
      const item = await todos.markRead(permit(c, 'action'), c.req.valid('param').id)
      return c.json(todoDto(item))
    })
    .post('/:id/dismiss', zValidator('param', idParam, validationHook), async (c) => {
      const item = await todos.dismiss(permit(c, 'action'), c.req.valid('param').id)
      return c.json(todoDto(item))
    })
}
