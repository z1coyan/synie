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
import { fulfillmentSpec } from './spec.ts'
import type { FulfillmentService } from './service.ts'

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

export function fulfillmentHeadRoutes(deps: {
  auth: AuthService
  fulfillment: FulfillmentService
  side: TradingSide
}) {
  const { auth, fulfillment, side } = deps
  const prefix = fulfillmentSpec(side).prefix
  const numberKey = side === 'sales' ? 'deliveryNo' : 'receiptNo'
  const dateKey = side === 'sales' ? 'deliveryDate' : 'receiptDate'
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm(`${prefix}:read`), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listHeads(c.get('actor'), side, toList(c.req.valid('json')))
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
            [numberKey]: z.string().nullable().optional(),
            [dateKey]: z.string().nullable().optional(),
            postingDate: z.string().nullable().optional(),
            partyType: z.string().min(1),
            partyId: z.string().uuid(),
            remarks: z.string().nullable().optional(),
            warehouseId: z.string().uuid().nullable().optional(),
            debitAccountId: z.string().uuid(),
            creditAccountId: z.string().uuid(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json') as Record<string, unknown>
        return c.json(
          await fulfillment.createHead(c.get('actor'), side, {
            companyId: body.companyId as string,
            no: body[numberKey] as string | null | undefined,
            documentDate: body[dateKey] as string | null | undefined,
            postingDate: body.postingDate as string | null | undefined,
            partyType: body.partyType as string,
            partyId: body.partyId as string,
            remarks: body.remarks as string | null | undefined,
            warehouseId: body.warehouseId as string | null | undefined,
            debitAccountId: body.debitAccountId as string,
            creditAccountId: body.creditAccountId as string,
          }),
          201,
        )
      },
    )
    .get('/:id', requirePerm(`${prefix}:read`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm(`${prefix}:update`),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            [numberKey]: z.string().optional(),
            [dateKey]: z.string().optional(),
            postingDate: z.string().nullable().optional(),
            partyType: z.string().optional(),
            partyId: z.string().uuid().optional(),
            remarks: z.string().nullable().optional(),
            warehouseId: z.string().uuid().nullable().optional(),
            debitAccountId: z.string().uuid().optional(),
            creditAccountId: z.string().uuid().optional(),
          })
          .passthrough(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json') as Record<string, unknown>
        return c.json(
          await fulfillment.updateHead(c.get('actor'), side, c.req.valid('param').id, {
            no: body[numberKey] as string | undefined,
            documentDate: body[dateKey] as string | undefined,
            postingDate: body.postingDate as string | null | undefined,
            postingDatePresent: presentKey(raw, 'postingDate'),
            partyType: body.partyType as string | undefined,
            partyId: body.partyId as string | undefined,
            remarks: body.remarks as string | null | undefined,
            remarksPresent: presentKey(raw, 'remarks'),
            warehouseId: body.warehouseId as string | null | undefined,
            warehouseIdPresent: presentKey(raw, 'warehouseId'),
            debitAccountId: body.debitAccountId as string | undefined,
            creditAccountId: body.creditAccountId as string | undefined,
          }),
        )
      },
    )
    .delete('/:id', requirePerm(`${prefix}:delete`), zValidator('param', idParam, validationHook), async (c) => {
      await fulfillment.deleteHead(c.get('actor'), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', requirePerm(`${prefix}:audit`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.auditHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post('/:id/void', requirePerm(`${prefix}:void`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.voidHead(c.get('actor'), side, c.req.valid('param').id)),
    )
}

export function fulfillmentItemRoutes(deps: {
  auth: AuthService
  fulfillment: FulfillmentService
  side: TradingSide
}) {
  const { auth, fulfillment, side } = deps
  const prefix = fulfillmentSpec(side).prefix
  const parentKey = side === 'sales' ? 'deliveryId' : 'receiptId'
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm(`${prefix}:read`), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listItems(c.get('actor'), side, toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      requirePerm(`${prefix}:create`),
      zValidator(
        'json',
        z
          .object({
            [parentKey]: z.string().uuid(),
            idx: z.number().int(),
            qty: z.string().min(1),
            orderItemId: z.string().uuid(),
            unitId: z.string().uuid().nullable().optional(),
            warehouseId: z.string().uuid(),
            remarks: z.string().nullable().optional(),
          })
          .passthrough(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json') as Record<string, unknown>
        return c.json(
          await fulfillment.createItem(c.get('actor'), side, {
            headId: body[parentKey] as string,
            idx: body.idx as number,
            qty: body.qty as string,
            orderItemId: body.orderItemId as string,
            unitId: body.unitId as string | null | undefined,
            warehouseId: body.warehouseId as string,
            remarks: body.remarks as string | null | undefined,
          }),
          201,
        )
      },
    )
    .get('/:id', requirePerm(`${prefix}:read`), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getItem(c.get('actor'), side, c.req.valid('param').id)),
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
            orderItemId: z.string().uuid().optional(),
            unitId: z.string().uuid().nullable().optional(),
            warehouseId: z.string().uuid().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await fulfillment.updateItem(c.get('actor'), side, c.req.valid('param').id, {
            ...c.req.valid('json'),
            unitIdPresent: presentKey(raw, 'unitId'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', requirePerm(`${prefix}:delete`), zValidator('param', idParam, validationHook), async (c) => {
      await fulfillment.deleteItem(c.get('actor'), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function packLineRoutes(deps: { auth: AuthService; fulfillment: FulfillmentService }) {
  const { auth, fulfillment } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('sales.delivery:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listPackLines(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      requirePerm('sales.delivery:create'),
      zValidator(
        'json',
        z
          .object({
            deliveryId: z.string().uuid(),
            idx: z.number().int(),
            boxNo: z.string().min(1),
            qty: z.string().min(1),
            materialId: z.string().uuid(),
            unitId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await fulfillment.createPackLine(c.get('actor'), c.req.valid('json')), 201),
    )
    .get('/:id', requirePerm('sales.delivery:read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getPackLine(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('sales.delivery:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            idx: z.number().int().optional(),
            boxNo: z.string().optional(),
            qty: z.string().optional(),
            materialId: z.string().uuid().optional(),
            unitId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await fulfillment.updatePackLine(c.get('actor'), c.req.valid('param').id, {
            ...c.req.valid('json'),
            unitIdPresent: presentKey(raw, 'unitId'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', requirePerm('sales.delivery:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await fulfillment.deletePackLine(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}
