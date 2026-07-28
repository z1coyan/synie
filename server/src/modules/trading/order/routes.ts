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
import { orderSpec } from './spec.ts'
import type { OrderService } from './service.ts'

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

export function orderHeadRoutes(deps: {
  auth: AuthService
  orders: OrderService
  side: TradingSide
}) {
  const { auth, orders, side } = deps
  const prefix = orderSpec(side).prefix
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm(`${prefix}:read`), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orders.listHeads(c.get('actor'), side, toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      requirePerm(`${prefix}:create`),
      zValidator(
        'json',
        z
          .object({
            companyId: z.string().uuid(),
            orderNo: z.string().nullable().optional(),
            orderDate: z.string().nullable().optional(),
            orderType: z.string().optional(),
            isOutsourced: z.boolean().optional(),
            partyType: z.string().min(1),
            partyId: z.string().uuid(),
            currencyId: z.string().uuid().nullable().optional(),
            exchangeRate: z.string().nullable().optional(),
            terms: z.string().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await orders.createHead(c.get('actor'), side, c.req.valid('json')), 201),
    )
    .get('/:id', requirePerm(`${prefix}:read`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm(`${prefix}:update`),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            orderNo: z.string().optional(),
            orderDate: z.string().optional(),
            orderType: z.string().optional(),
            isOutsourced: z.boolean().optional(),
            partyType: z.string().optional(),
            partyId: z.string().uuid().optional(),
            currencyId: z.string().uuid().optional(),
            exchangeRate: z.string().optional(),
            terms: z.string().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        return c.json(
          await orders.updateHead(c.get('actor'), side, c.req.valid('param').id, {
            ...body,
            termsPresent: presentKey(raw, 'terms'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', requirePerm(`${prefix}:delete`), zValidator('param', idParam, validationHook), async (c) => {
      await orders.deleteHead(c.get('actor'), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', requirePerm(`${prefix}:audit`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.audit(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post('/:id/close', requirePerm(`${prefix}:close`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.close(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post('/:id/void', requirePerm(`${prefix}:void`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.void(c.get('actor'), side, c.req.valid('param').id)),
    )
    .get('/:id/history', requirePerm(`${prefix}:read`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.history(c.get('actor'), side, c.req.valid('param').id)),
    )
}

export function orderItemRoutes(deps: {
  auth: AuthService
  orders: OrderService
  side: TradingSide
}) {
  const { auth, orders, side } = deps
  const prefix = orderSpec(side).prefix
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm(`${prefix}:read`), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orders.listItems(c.get('actor'), side, toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      requirePerm(`${prefix}:create`),
      zValidator(
        'json',
        z
          .object({
            orderId: z.string().uuid(),
            idx: z.number().int(),
            qty: z.string().min(1),
            materialId: z.string().uuid(),
            unitId: z.string().uuid(),
            price: z.string().nullable().optional(),
            taxRate: z.string().nullable().optional(),
            remarks: z.string().nullable().optional(),
            quotationItemId: z.string().uuid().nullable().optional(),
            bomId: z.string().uuid().nullable().optional(),
            demandLineId: z.string().uuid().nullable().optional(),
            demandDate: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await orders.createItem(c.get('actor'), side, c.req.valid('json')), 201),
    )
    .get('/:id', requirePerm(`${prefix}:read`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getItem(c.get('actor'), side, c.req.valid('param').id)),
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
            qty: z.string().optional(),
            materialId: z.string().uuid().optional(),
            unitId: z.string().uuid().optional(),
            price: z.string().optional(),
            taxRate: z.string().optional(),
            remarks: z.string().nullable().optional(),
            quotationItemId: z.string().uuid().nullable().optional(),
            bomId: z.string().uuid().nullable().optional(),
            demandLineId: z.string().uuid().nullable().optional(),
            demandDate: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        return c.json(
          await orders.updateItem(c.get('actor'), side, c.req.valid('param').id, {
            ...body,
            remarksPresent: presentKey(raw, 'remarks'),
            quotationItemIdPresent: presentKey(raw, 'quotationItemId'),
            bomIdPresent: presentKey(raw, 'bomId'),
            demandLineIdPresent: presentKey(raw, 'demandLineId'),
            demandDatePresent: presentKey(raw, 'demandDate'),
          }),
        )
      },
    )
    .delete('/:id', requirePerm(`${prefix}:delete`), zValidator('param', idParam, validationHook), async (c) => {
      await orders.deleteItem(c.get('actor'), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function purchaseOrderExtraRoutes(deps: { auth: AuthService; orders: OrderService }) {
  const { auth, orders } = deps
  const material = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('purchase.order:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orders.listMaterials(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      requirePerm('purchase.order:create'),
      zValidator(
        'json',
        z
          .object({
            orderItemId: z.string().uuid(),
            materialId: z.string().uuid(),
            unitId: z.string().uuid(),
            quantity: z.string().min(1),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await orders.createMaterial(c.get('actor'), c.req.valid('json')), 201),
    )
    .get('/:id', requirePerm('purchase.order:read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getMaterial(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.order:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            materialId: z.string().uuid().optional(),
            unitId: z.string().uuid().optional(),
            quantity: z.string().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await orders.updateMaterial(c.get('actor'), c.req.valid('param').id, {
            ...c.req.valid('json'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', requirePerm('purchase.order:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await orders.deleteMaterial(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })

  const byproduct = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('purchase.order:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orders.listByproducts(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      requirePerm('purchase.order:create'),
      zValidator(
        'json',
        z
          .object({
            orderItemId: z.string().uuid(),
            materialId: z.string().uuid(),
            unitId: z.string().uuid(),
            quantity: z.string().min(1),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await orders.createByproduct(c.get('actor'), c.req.valid('json')), 201),
    )
    .get('/:id', requirePerm('purchase.order:read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getByproduct(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.order:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            materialId: z.string().uuid().optional(),
            unitId: z.string().uuid().optional(),
            quantity: z.string().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await orders.updateByproduct(c.get('actor'), c.req.valid('param').id, {
            ...c.req.valid('json'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', requirePerm('purchase.order:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await orders.deleteByproduct(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })

  const demand = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('purchase.order:read'),
      zValidator(
        'json',
        z
          .object({
            companyId: z.string().uuid(),
            isOutsourced: z.boolean().optional(),
            limit: z.number().int().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await orders.queryDemandPool(c.get('actor'), c.req.valid('json'))),
    )

  const bom = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/expand',
      requirePerm('purchase.order:read'),
      zValidator(
        'json',
        z
          .object({
            bomId: z.string().uuid(),
            quantity: z.string().min(1).optional(),
            qty: z.string().min(1).optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const quantity = body.quantity ?? body.qty
        if (!quantity) {
          const { ApiError } = await import('~/platform/http/errors.ts')
          throw ApiError.validation('BOM 展开参数不合法', { quantity: ['必填'] })
        }
        return c.json(await orders.expandBom(c.get('actor'), { bomId: body.bomId, quantity }))
      },
    )

  return { material, byproduct, demand, bom }
}
