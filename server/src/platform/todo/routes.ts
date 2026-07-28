/**
 * 待办 REST：/todos/query、/todos/unread-count、/todos/{id}/read|dismiss
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { Todo, TodoService } from './service.ts'

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

const idParam = z.object({ id: z.string().uuid() })

function requirePerm(code: string) {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    requirePermission(c.get('actor'), code)
    await next()
  }
}

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
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .get('/unread-count', requirePerm('acc.vat_invoice:read'), async (c) => {
      const count = await todos.unreadCount(c.get('actor')!)
      return c.json({ count })
    })
    .post(
      '/query',
      requirePerm('acc.vat_invoice:create'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const result = await todos.list(c.get('actor')!, {
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
      },
    )
    .post(
      '/:id/read',
      requirePerm('acc.vat_invoice:create'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await todos.markRead(c.get('actor')!, c.req.valid('param').id)
        return c.json(todoDto(item))
      },
    )
    .post(
      '/:id/dismiss',
      requirePerm('acc.vat_invoice:create'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        const item = await todos.dismiss(c.get('actor')!, c.req.valid('param').id)
        return c.json(todoDto(item))
      },
    )
}
