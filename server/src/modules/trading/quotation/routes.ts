import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { TradingSide } from '../common.ts'
import { presentKey } from '../common.ts'
import { quotationSpec } from './spec.ts'
import type { QuotationService } from './service.ts'

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

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

export function quotationHeadRoutes(deps: {
  auth: AuthService
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, quotations, side } = deps
  const prefix = quotationSpec(side).prefix
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm(`${prefix}:read`),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await quotations.listHeads(c.get('actor'), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      requirePerm(`${prefix}:create`),
      zValidator(
        'json',
        z
          .object({
            companyId: z.string().uuid(),
            quotationNo: z.string().nullable().optional(),
            quotationDate: z.string().nullable().optional(),
            validUntil: z.string().min(1),
            partyType: z.string().min(1),
            partyId: z.string().uuid(),
            currencyId: z.string().uuid().nullable().optional(),
            terms: z.string().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await quotations.createHead(c.get('actor'), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id',
      requirePerm(`${prefix}:read`),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm(`${prefix}:update`),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            quotationNo: z.string().optional(),
            quotationDate: z.string().optional(),
            validUntil: z.string().optional(),
            partyType: z.string().optional(),
            partyId: z.string().uuid().optional(),
            currencyId: z.string().uuid().optional(),
            terms: z.string().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await quotations.updateHead(c.get('actor'), side, c.req.valid('param').id, {
          ...body,
          termsPresent: presentKey(raw, 'terms'),
          remarksPresent: presentKey(raw, 'remarks'),
        })
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      requirePerm(`${prefix}:delete`),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteHead(c.get('actor'), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      requirePerm(`${prefix}:audit`),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.auditHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/void',
      requirePerm(`${prefix}:void`),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.voidHead(c.get('actor'), side, c.req.valid('param').id)),
    )
}

export function quotationItemRoutes(deps: {
  auth: AuthService
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, quotations, side } = deps
  const prefix = quotationSpec(side).prefix
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm(`${prefix}:read`),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await quotations.listItems(c.get('actor'), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      requirePerm(`${prefix}:create`),
      zValidator(
        'json',
        z
          .object({
            quotationId: z.string().uuid(),
            idx: z.number().int(),
            materialId: z.string().uuid(),
            unitId: z.string().uuid(),
            pricingMode: z.string().optional(),
            price: z.string().nullable().optional(),
            taxRate: z.string().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await quotations.createItem(c.get('actor'), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id',
      requirePerm(`${prefix}:read`),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getItem(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm(`${prefix}:update`),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            idx: z.number().int().optional(),
            materialId: z.string().uuid().optional(),
            unitId: z.string().uuid().optional(),
            pricingMode: z.string().optional(),
            price: z.string().nullable().optional(),
            taxRate: z.string().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await quotations.updateItem(c.get('actor'), side, c.req.valid('param').id, {
          ...body,
          pricePresent: presentKey(raw, 'price'),
          remarksPresent: presentKey(raw, 'remarks'),
        })
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      requirePerm(`${prefix}:delete`),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteItem(c.get('actor'), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function quotationTierRoutes(deps: {
  auth: AuthService
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, quotations, side } = deps
  const prefix = quotationSpec(side).prefix
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm(`${prefix}:read`),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await quotations.listTiers(c.get('actor'), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      requirePerm(`${prefix}:create`),
      zValidator(
        'json',
        z
          .object({
            itemId: z.string().uuid(),
            minQty: z.string().min(1),
            price: z.string().min(1),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await quotations.createTier(c.get('actor'), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id',
      requirePerm(`${prefix}:read`),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getTier(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm(`${prefix}:update`),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            minQty: z.string().optional(),
            price: z.string().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await quotations.updateTier(
          c.get('actor'),
          side,
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      requirePerm(`${prefix}:delete`),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteTier(c.get('actor'), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}
