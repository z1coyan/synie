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
import { RULE_RESOURCE_NAME } from './meta.ts'
import type { NumberingService, Segment } from './service.ts'

/**
 * 编号规则 REST：逐端点挂 `guard(资源, 动作)`（requireAuth 之后）。
 * 计数器 meta 无独立 actions 且与规则同前缀，故一律按规则资源取凭证
 * （与迁移前 `sys.numbering_rule:read/update` 的门控逐字一致）。
 */

const segmentSchema = z
  .object({
    type: z.enum(['text', 'seq', 'field']),
    value: z.string().optional().nullable(),
    field: z.string().optional().nullable(),
    label: z.string().optional().nullable(),
    format: z.string().optional().nullable(),
    padding: z.number().int().optional().nullable(),
  })
  .strict()

const createSchema = z
  .object({
    resource: z.string().min(1),
    name: z.string().min(1).max(64),
    segments: z.array(segmentSchema).min(1),
    perCompany: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

const updateSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    segments: z.array(segmentSchema).min(1).optional(),
    perCompany: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

const counterUpdateSchema = z.object({ value: z.number().int() }).strict()
const idParam = z.object({ id: z.string().uuid() })

export function numberingRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  numbering: NumberingService
}) {
  const { auth, authz, numbering } = deps
  const guard = (action: string) => authz.guard(RULE_RESOURCE_NAME, action)

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .get('/resources', guard('read'), async (c) => {
      const resources = await numbering.numberableResources(permitOf(c))
      return c.json({ resources })
    })
    .post('/rules/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await numbering.listRules(permitOf(c), toListQuery(c.req.valid('json')))
      return c.json({
        count: result.count,
        results: result.results.map(ruleDto),
      })
    })
    .post('/rules', guard('create'), zValidator('json', createSchema, validationHook), async (c) => {
      const body = c.req.valid('json')
      const rule = await numbering.create(permitOf(c), {
        resource: body.resource,
        name: body.name,
        segments: body.segments as Segment[],
        perCompany: body.perCompany,
        enabled: body.enabled,
      })
      return c.json(ruleDto(rule), 201)
    })
    .get('/rules/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const rule = await numbering.getRule(permitOf(c), c.req.valid('param').id)
      return c.json(ruleDto(rule))
    })
    .patch(
      '/rules/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', updateSchema, validationHook),
      async (c) => {
        const body = c.req.valid('json')
        const rule = await numbering.updateRule(permitOf(c), c.req.valid('param').id, {
          name: body.name,
          segments: body.segments as Segment[] | undefined,
          perCompany: body.perCompany,
          enabled: body.enabled,
        })
        return c.json(ruleDto(rule))
      },
    )
    .delete('/rules/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await numbering.deleteRule(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/counters/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await numbering.listCounters(permitOf(c), toListQuery(c.req.valid('json')))
      return c.json({
        count: result.count,
        results: result.results.map(counterDto),
      })
    })
    .get('/counters/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      const counter = await numbering.getCounter(permitOf(c), c.req.valid('param').id)
      return c.json(counterDto(counter))
    })
    .patch(
      '/counters/:id',
      guard('update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', counterUpdateSchema, validationHook),
      async (c) => {
        const counter = await numbering.updateCounter(
          permitOf(c),
          c.req.valid('param').id,
          c.req.valid('json').value,
        )
        return c.json(counterDto(counter))
      },
    )
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

function ruleDto(rule: {
  id: string
  resource: string
  name: string
  segments: Segment[]
  perCompany: boolean
  enabled: boolean
  insertedAt: Date
  updatedAt: Date
}) {
  return {
    id: rule.id,
    resource: rule.resource,
    name: rule.name,
    segments: rule.segments.map((s) => ({
      type: s.type,
      ...(s.value != null ? { value: s.value } : {}),
      ...(s.field != null ? { field: s.field } : {}),
      ...(s.label != null ? { label: s.label } : {}),
      ...(s.format != null ? { format: s.format } : {}),
      ...(s.padding != null ? { padding: s.padding } : {}),
    })),
    perCompany: rule.perCompany,
    enabled: rule.enabled,
    insertedAt: rule.insertedAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  }
}

function counterDto(counter: {
  id: string
  ruleId: string
  scopeKey: string
  value: number
  insertedAt: Date
  updatedAt: Date
}) {
  return {
    id: counter.id,
    ruleId: counter.ruleId,
    scopeKey: counter.scopeKey,
    value: counter.value,
    insertedAt: counter.insertedAt.toISOString(),
    updatedAt: counter.updatedAt.toISOString(),
  }
}
