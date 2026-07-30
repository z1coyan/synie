import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { validationHook } from '~/platform/http/zod.ts'
import { presentKey } from '../common.ts'
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

const salesDraftItemSchema = z
  .object({
    id: z.string().uuid().optional(),
    idx: z.number().int(),
    qty: z.string().min(1),
    orderItemId: z.string().uuid(),
    unitId: z.string().uuid().nullable().optional(),
    warehouseId: z.string().uuid(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const salesDraftPackLineSchema = z
  .object({
    id: z.string().uuid().optional(),
    idx: z.number().int(),
    qty: z.string().min(1),
    materialId: z.string().uuid(),
    unitId: z.string().uuid().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const salesDraftPackBoxSchema = z
  .object({
    id: z.string().uuid().optional(),
    lines: z.array(salesDraftPackLineSchema),
  })
  .strict()

const salesDraftSchema = z
  .object({
    companyId: z.string().uuid(),
    deliveryNo: z.string().nullable().optional(),
    deliveryDate: z.string().nullable().optional(),
    postingDate: z.string().nullable().optional(),
    partyType: z.string().min(1),
    partyId: z.string().uuid(),
    remarks: z.string().nullable().optional(),
    warehouseId: z.string().uuid().nullable().optional(),
    debitAccountId: z.string().uuid(),
    creditAccountId: z.string().uuid(),
    items: z.array(salesDraftItemSchema),
    packBoxes: z.array(salesDraftPackBoxSchema),
  })
  .strict()

function salesDraftValidationHook(result: {
  success: boolean
  error?: z.ZodError
}): void {
  if (result.success || !result.error) return
  const fields: Record<string, string[]> = {}
  for (const issue of result.error.issues) {
    let key = ''
    for (const part of issue.path) {
      if (typeof part === 'number') key += `[${part}]`
      else key += key ? `.${String(part)}` : String(part)
    }
    if (!key) key = '_'
    else if (!key.startsWith('items') && !key.startsWith('packBoxes')) key = `header.${key}`
    ;(fields[key] ??= []).push(issue.message)
  }
  throw ApiError.validation('请求参数错误', fields)
}

function toSalesDraftInput(body: z.infer<typeof salesDraftSchema>) {
  return {
    companyId: body.companyId,
    no: body.deliveryNo,
    documentDate: body.deliveryDate,
    postingDate: body.postingDate,
    partyType: body.partyType,
    partyId: body.partyId,
    remarks: body.remarks,
    warehouseId: body.warehouseId,
    debitAccountId: body.debitAccountId,
    creditAccountId: body.creditAccountId,
    items: body.items,
    packBoxes: body.packBoxes,
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

export function salesFulfillmentHeadRoutes(deps: {
  auth: AuthService
  fulfillment: FulfillmentService
}) {
  const { auth, fulfillment } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listHeads(c.get('actor'), 'sales', toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      zValidator('json', salesDraftSchema, salesDraftValidationHook),
      async (c) =>
        c.json(
          await fulfillment.createSalesDraft(
            c.get('actor'),
            toSalesDraftInput(c.req.valid('json')),
          ),
          201,
        ),
    )
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getHead(c.get('actor'), 'sales', c.req.valid('param').id)),
    )
    .put(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', salesDraftSchema, salesDraftValidationHook),
      async (c) =>
        c.json(
          await fulfillment.replaceSalesDraft(
            c.get('actor'),
            c.req.valid('param').id,
            toSalesDraftInput(c.req.valid('json')),
          ),
        ),
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await fulfillment.deleteHead(c.get('actor'), 'sales', c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.auditHead(c.get('actor'), 'sales', c.req.valid('param').id)),
    )
    .post('/:id/void', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.voidHead(c.get('actor'), 'sales', c.req.valid('param').id)),
    )
}

export function purchaseFulfillmentHeadRoutes(deps: {
  auth: AuthService
  fulfillment: FulfillmentService
}) {
  const { auth, fulfillment } = deps
  const side = 'purchase'
  const numberKey = 'receiptNo'
  const dateKey = 'receiptDate'
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listHeads(c.get('actor'), side, toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
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
          await fulfillment.createPurchaseHead(c.get('actor'), {
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
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
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
          await fulfillment.updatePurchaseHead(c.get('actor'), c.req.valid('param').id, {
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
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await fulfillment.deleteHead(c.get('actor'), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.auditHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post('/:id/void', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.voidHead(c.get('actor'), side, c.req.valid('param').id)),
    )
}

export function purchaseFulfillmentItemRoutes(deps: {
  auth: AuthService
  fulfillment: FulfillmentService
}) {
  const { auth, fulfillment } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listItems(c.get('actor'), 'purchase', toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            receiptId: z.string().uuid(),
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
          await fulfillment.createPurchaseItem(c.get('actor'), {
            receiptId: body.receiptId as string,
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
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getItem(c.get('actor'), 'purchase', c.req.valid('param').id)),
    )
    .patch(
      '/:id',
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
          await fulfillment.updatePurchaseItem(c.get('actor'), c.req.valid('param').id, {
            ...c.req.valid('json'),
            unitIdPresent: presentKey(raw, 'unitId'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await fulfillment.deletePurchaseItem(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function salesFulfillmentItemRoutes(deps: {
  auth: AuthService
  fulfillment: FulfillmentService
}) {
  const { auth, fulfillment } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listItems(c.get('actor'), 'sales', toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getItem(c.get('actor'), 'sales', c.req.valid('param').id)),
    )
}

export function packBoxRoutes(deps: { auth: AuthService; fulfillment: FulfillmentService }) {
  const { auth, fulfillment } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listPackBoxes(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getPackBox(c.get('actor'), c.req.valid('param').id)),
    )
}

export function packLineRoutes(deps: { auth: AuthService; fulfillment: FulfillmentService }) {
  const { auth, fulfillment } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await fulfillment.listPackLines(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await fulfillment.getPackLine(c.get('actor'), c.req.valid('param').id)),
    )
}
