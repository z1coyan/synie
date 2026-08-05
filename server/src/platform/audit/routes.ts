import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { AuthzEnforcer } from '../authz/enforce.ts'
import { permitOf } from '../authz/enforce.ts'
import type { AppEnv } from '../http/context.ts'
import { listQuerySchema, validationHook } from '../http/zod.ts'
import { AUDIT_LOG_RESOURCE_NAME } from './meta.ts'
import type { AuditService } from './service.ts'

/** 审计查询 REST：逐端点挂 guard（requireAuth 之后），handler 用 permitOf(c) 取凭证 */

const idParam = z.object({ id: z.string().uuid() })

export function auditRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  audit: AuditService
}) {
  const { auth, authz, audit } = deps
  const guard = (action: string) => authz.guard(AUDIT_LOG_RESOURCE_NAME, action)

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const result = await audit.list(permitOf(c), {
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
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const value = await audit.get(permitOf(c), c.req.valid('param').id)
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
