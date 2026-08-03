import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { CompanyAccountDefaultService } from './company-account-default.ts'

const idParam = z.object({ id: z.string().uuid() })
const companyParam = z.object({ companyId: z.string().uuid() })

const createSchema = z
  .object({
    companyId: z.string().uuid(),
    deliveryDebitAccountId: z.string().uuid().nullable().optional(),
    deliveryCreditAccountId: z.string().uuid().nullable().optional(),
    receiptDebitAccountId: z.string().uuid().nullable().optional(),
    receiptCreditAccountId: z.string().uuid().nullable().optional(),
  })
  .strict()

const updateSchema = z
  .object({
    deliveryDebitAccountId: z.string().uuid().nullable().optional(),
    deliveryCreditAccountId: z.string().uuid().nullable().optional(),
    receiptDebitAccountId: z.string().uuid().nullable().optional(),
    receiptCreditAccountId: z.string().uuid().nullable().optional(),
  })
  .strict()

function present(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key)
}

export function companyAccountDefaultRoutes(deps: {
  auth: AuthService
  defaults: CompanyAccountDefaultService
}) {
  const { auth, defaults } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await defaults.list(c.get('actor'), {
        limit: c.req.valid('json').limit,
        offset: c.req.valid('json').offset,
        search: c.req.valid('json').search,
        sort: c.req.valid('json').sort,
        filter: c.req.valid('json').filter as ListQuery['filter'],
      })
      return c.json({ count: result.count, results: result.results.map(dto) })
    })
    .post('/', zValidator('json', createSchema, validationHook), async (c) => {
      const item = await defaults.create(c.get('actor'), c.req.valid('json'))
      return c.json(dto(item), 201)
    })
    .get(
      '/by-company/:companyId',
      zValidator('param', companyParam, validationHook),
      async (c) => {
        const item = await defaults.getByCompany(
          c.get('actor'),
          c.req.valid('param').companyId,
        )
        return c.json(dto(item))
      },
    )
    .get('/:id', zValidator('param', idParam, validationHook), async (c) => {
      return c.json(dto(await defaults.get(c.get('actor'), c.req.valid('param').id)))
    })
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', updateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await defaults.update(c.get('actor'), c.req.valid('param').id, {
          deliveryDebitAccountId: body.deliveryDebitAccountId,
          deliveryDebitPresent: present(raw, 'deliveryDebitAccountId'),
          deliveryCreditAccountId: body.deliveryCreditAccountId,
          deliveryCreditPresent: present(raw, 'deliveryCreditAccountId'),
          receiptDebitAccountId: body.receiptDebitAccountId,
          receiptDebitPresent: present(raw, 'receiptDebitAccountId'),
          receiptCreditAccountId: body.receiptCreditAccountId,
          receiptCreditPresent: present(raw, 'receiptCreditAccountId'),
        })
        return c.json(dto(item))
      },
    )
}

function dto(item: Awaited<ReturnType<CompanyAccountDefaultService['get']>>) {
  return {
    id: item.id,
    companyId: item.companyId,
    deliveryDebitAccountId: item.deliveryDebitAccountId,
    deliveryCreditAccountId: item.deliveryCreditAccountId,
    receiptDebitAccountId: item.receiptDebitAccountId,
    receiptCreditAccountId: item.receiptCreditAccountId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}
