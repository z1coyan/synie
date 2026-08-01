import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { TradingSide } from '../common.ts'
import { presentKey } from '../common.ts'
import type { ReconciliationService } from './service.ts'

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

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

export function reconciliationHeadRoutes(deps: {
  auth: AuthService
  reconciliations: ReconciliationService
  side: TradingSide
}) {
  const { auth, reconciliations, side } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await reconciliations.listHeads(c.get('actor'), side, toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            companyId: z.string().uuid(),
            reconciliationNo: z.string().nullable().optional(),
            reconciliationType: z.string().min(1),
            partyType: z.string().min(1),
            partyId: z.string().uuid(),
            debitAccountId: z.string().uuid().nullable().optional(),
            creditAccountId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        return c.json(
          await reconciliations.createHead(c.get('actor'), side, {
            companyId: body.companyId,
            no: body.reconciliationNo,
            kind: body.reconciliationType,
            partyType: body.partyType,
            partyId: body.partyId,
            debitAccountId: body.debitAccountId,
            creditAccountId: body.creditAccountId,
            remarks: body.remarks,
          }),
          201,
        )
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.getHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            reconciliationNo: z.string().optional(),
            reconciliationType: z.string().optional(),
            partyType: z.string().optional(),
            partyId: z.string().uuid().optional(),
            debitAccountId: z.string().uuid().optional(),
            creditAccountId: z.string().uuid().optional(),
            remarks: z.string().nullable().optional(),
          })
          .passthrough(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        return c.json(
          await reconciliations.updateHead(c.get('actor'), side, c.req.valid('param').id, {
            no: body.reconciliationNo,
            kind: body.reconciliationType,
            partyType: body.partyType,
            partyId: body.partyId,
            debitAccountId: body.debitAccountId,
            creditAccountId: body.creditAccountId,
            remarks: body.remarks,
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await reconciliations.deleteHead(c.get('actor'), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/confirm',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.confirm(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/unconfirm',
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await reconciliations.unconfirm(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/audit',
      zValidator('param', idParam, validationHook),
      async (c) => {
        let postingDate: string | null | undefined
        const cl = c.req.header('content-length')
        const ct = c.req.header('content-type') ?? ''
        if (cl !== '0' && ct.includes('json')) {
          try {
            const raw = (await c.req.json()) as { postingDate?: string | null }
            if (raw && typeof raw === 'object' && 'postingDate' in raw) {
              postingDate = raw.postingDate ?? null
            }
          } catch {
            // 空 body 允许
          }
        }
        return c.json(
          await reconciliations.audit(c.get('actor'), side, c.req.valid('param').id, {
            postingDate,
          }),
        )
      },
    )
    .post(
      '/:id/void',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.void(c.get('actor'), side, c.req.valid('param').id)),
    )
}

export function reconciliationItemRoutes(deps: {
  auth: AuthService
  reconciliations: ReconciliationService
  side: TradingSide
}) {
  const { auth, reconciliations, side } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await reconciliations.listItems(c.get('actor'), side, toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            reconciliationId: z.string().uuid(),
            idx: z.number().int(),
            qty: z.string().min(1),
            deliveryItemId: z.string().uuid().nullable().optional(),
            receiptItemId: z.string().uuid().nullable().optional(),
            outsourcedReceiptItemId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await reconciliations.createItem(c.get('actor'), side, c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.getItem(c.get('actor'), side, c.req.valid('param').id)),
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
            deliveryItemId: z.string().uuid().nullable().optional(),
            receiptItemId: z.string().uuid().nullable().optional(),
            outsourcedReceiptItemId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .passthrough(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        return c.json(
          await reconciliations.updateItem(c.get('actor'), side, c.req.valid('param').id, {
            idx: body.idx,
            qty: body.qty,
            deliveryItemId: body.deliveryItemId,
            deliveryItemIdPresent: presentKey(raw, 'deliveryItemId'),
            receiptItemId: body.receiptItemId,
            receiptItemIdPresent: presentKey(raw, 'receiptItemId'),
            outsourcedReceiptItemId: body.outsourcedReceiptItemId,
            outsourcedReceiptItemIdPresent: presentKey(raw, 'outsourcedReceiptItemId'),
            remarks: body.remarks,
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await reconciliations.deleteItem(c.get('actor'), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}
