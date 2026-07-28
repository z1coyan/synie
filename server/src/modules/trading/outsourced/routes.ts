import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { OutsourcedService } from './service.ts'

const listQuerySchema = z.object({
  limit: z.number().int().min(0).max(200).optional(),
  offset: z.number().int().min(0).optional(),
  search: z.string().optional(),
  sort: z.object({ column: z.string(), direction: z.enum(['ascending', 'descending']) }).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
}).strict()
const idParam = z.object({ id: z.string().uuid() })

function requirePerm(code: string) {
  return async (c: { get: (k: 'actor') => AppEnv['Variables']['actor'] }, next: () => Promise<void>) => {
    requirePermission(c.get('actor'), code)
    await next()
  }
}

export function outsourcedIssueRoutes(deps: { auth: AuthService; outsourced: OutsourcedService }) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('purchase.outsourced_issue:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await outsourced.listEmpty(c.get('actor'), 'purchase.outsourced_issue')
      return c.json(r)
    })
    .post(
      '/',
      requirePerm('purchase.outsourced_issue:create'),
      zValidator(
        'json',
        z.object({
          companyId: z.string().uuid(),
          issueNo: z.string().nullable().optional(),
          issueDate: z.string().nullable().optional(),
          partyType: z.string(),
          partyId: z.string().uuid(),
          remarks: z.string().nullable().optional(),
        }).strict(),
        validationHook,
      ),
      async (c) => c.json(await outsourced.createIssue(c.get('actor'), c.req.valid('json')), 201),
    )
    .get('/:id', requirePerm('purchase.outsourced_issue:read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await outsourced.getIssue(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.outsourced_issue:update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', z.object({ remarks: z.string().nullable().optional() }).strict(), validationHook),
      async (c) => c.json(await outsourced.updateIssue(c.get('actor'), c.req.valid('param').id, c.req.valid('json'))),
    )
    .delete('/:id', requirePerm('purchase.outsourced_issue:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await outsourced.deleteIssue(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function outsourcedIssueItemRoutes(deps: { auth: AuthService; outsourced: OutsourcedService }) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('purchase.outsourced_issue:read'), zValidator('json', listQuerySchema, validationHook), async (c) =>
      c.json(await outsourced.listEmpty(c.get('actor'), 'purchase.outsourced_issue')),
    )
}

export function outsourcedReceiptRoutes(deps: { auth: AuthService; outsourced: OutsourcedService }) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('purchase.outsourced_receipt:read'), zValidator('json', listQuerySchema, validationHook), async (c) =>
      c.json(await outsourced.listEmpty(c.get('actor'), 'purchase.outsourced_receipt')),
    )
    .post(
      '/',
      requirePerm('purchase.outsourced_receipt:create'),
      zValidator(
        'json',
        z.object({
          companyId: z.string().uuid(),
          receiptNo: z.string().nullable().optional(),
          receiptDate: z.string().nullable().optional(),
          partyType: z.string(),
          partyId: z.string().uuid(),
          remarks: z.string().nullable().optional(),
          debitAccountId: z.string().uuid(),
          creditAccountId: z.string().uuid(),
        }).strict(),
        validationHook,
      ),
      async (c) => c.json(await outsourced.createReceipt(c.get('actor'), c.req.valid('json')), 201),
    )
    .get('/:id', requirePerm('purchase.outsourced_receipt:read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await outsourced.getReceipt(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.outsourced_receipt:update'),
      zValidator('param', idParam, validationHook),
      zValidator('json', z.object({ remarks: z.string().nullable().optional() }).strict(), validationHook),
      async (c) => c.json(await outsourced.updateReceipt(c.get('actor'), c.req.valid('param').id, c.req.valid('json'))),
    )
    .delete('/:id', requirePerm('purchase.outsourced_receipt:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await outsourced.deleteReceipt(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function outsourcedReceiptItemRoutes(deps: { auth: AuthService; outsourced: OutsourcedService }) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('purchase.outsourced_receipt:read'), zValidator('json', listQuerySchema, validationHook), async (c) =>
      c.json(await outsourced.listEmpty(c.get('actor'), 'purchase.outsourced_receipt')),
    )
}

export function outsourcedReceiptChildRoutes(deps: { auth: AuthService; outsourced: OutsourcedService }) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('purchase.outsourced_receipt:read'), zValidator('json', listQuerySchema, validationHook), async (c) =>
      c.json(await outsourced.listEmpty(c.get('actor'), 'purchase.outsourced_receipt')),
    )
}
