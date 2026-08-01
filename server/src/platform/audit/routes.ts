import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { AppEnv } from '../http/context.ts'
import { validationHook } from '../http/zod.ts'
import type { AuditService } from './service.ts'

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

export function auditRoutes(deps: { auth: AuthService; audit: AuditService }) {
  const { auth, audit } = deps

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const result = await audit.list(c.get('actor'), {
        limit: body.limit,
        offset: body.offset,
        search: body.search,
        sort: body.sort,
        filter: body.filter as ListQuery['filter'],
      })
      return c.json({
        count: result.count,
        results: result.results.map(dto),
      })
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      const value = await audit.get(c.get('actor'), c.req.valid('param').id)
      return c.json(dto(value))
    })
}

function dto(value: {
  id: string
  resource: string
  recordId: string
  recordLabel: string | null
  actionType: string
  actionName: string
  actorId: string | null
  actorName: string | null
  companyId: string | null
  changes: unknown
  insertedAt: Date
}) {
  return {
    id: value.id,
    resource: value.resource,
    recordId: value.recordId,
    recordLabel: value.recordLabel,
    actionType: value.actionType,
    actionName: value.actionName,
    actorId: value.actorId,
    actorName: value.actorName,
    companyId: value.companyId,
    changes: value.changes,
    insertedAt: value.insertedAt.toISOString(),
  }
}
