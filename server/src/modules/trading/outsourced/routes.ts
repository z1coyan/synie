import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import { presentKey } from '../common.ts'
import type { OutsourcedService } from './service.ts'

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
const decimalString = z.union([z.string(), z.number()]).transform((v) => String(v))

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

export function outsourcedIssueRoutes(deps: {
  auth: AuthService
  outsourced: OutsourcedService
}) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('purchase.outsourced_issue:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listIssues(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      requirePerm('purchase.outsourced_issue:create'),
      zValidator(
        'json',
        z
          .object({
            companyId: z.string().uuid(),
            issueNo: z.string().nullable().optional(),
            issueDate: z.string().nullable().optional(),
            partyType: z.string().min(1),
            partyId: z.string().uuid(),
            remarks: z.string().nullable().optional(),
            fromWarehouseId: z.string().uuid().nullable().optional(),
            outsourcedWarehouseId: z.string().uuid().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await outsourced.createIssue(c.get('actor'), c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      requirePerm('purchase.outsourced_issue:read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getIssue(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.outsourced_issue:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            issueNo: z.string().optional(),
            issueDate: z.string().optional(),
            partyType: z.string().optional(),
            partyId: z.string().uuid().optional(),
            remarks: z.string().nullable().optional(),
            fromWarehouseId: z.string().uuid().nullable().optional(),
            outsourcedWarehouseId: z.string().uuid().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await outsourced.updateIssue(c.get('actor'), c.req.valid('param').id, {
            ...body,
            remarksPresent: presentKey(raw, 'remarks'),
            fromWarehouseIdPresent: presentKey(raw, 'fromWarehouseId'),
            outsourcedWarehouseIdPresent: presentKey(raw, 'outsourcedWarehouseId'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      requirePerm('purchase.outsourced_issue:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteIssue(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      requirePerm('purchase.outsourced_issue:audit'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.auditIssue(c.get('actor'), c.req.valid('param').id)),
    )
    .post(
      '/:id/void',
      requirePerm('purchase.outsourced_issue:void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.voidIssue(c.get('actor'), c.req.valid('param').id)),
    )
}

export function outsourcedIssueItemRoutes(deps: {
  auth: AuthService
  outsourced: OutsourcedService
}) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('purchase.outsourced_issue:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listIssueItems(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      requirePerm('purchase.outsourced_issue:create'),
      zValidator(
        'json',
        z
          .object({
            issueId: z.string().uuid(),
            idx: z.number().int(),
            qty: decimalString,
            orderItemMaterialId: z.string().uuid(),
            fromWarehouseId: z.string().uuid().nullable().optional(),
            outsourcedWarehouseId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) =>
        c.json(await outsourced.createIssueItem(c.get('actor'), c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      requirePerm('purchase.outsourced_issue:read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getIssueItem(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.outsourced_issue:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            idx: z.number().int().optional(),
            qty: decimalString.optional(),
            orderItemMaterialId: z.string().uuid().optional(),
            fromWarehouseId: z.string().uuid().optional(),
            outsourcedWarehouseId: z.string().uuid().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await outsourced.updateIssueItem(c.get('actor'), c.req.valid('param').id, {
            ...body,
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      requirePerm('purchase.outsourced_issue:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteIssueItem(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function outsourcedReceiptRoutes(deps: {
  auth: AuthService
  outsourced: OutsourcedService
}) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('purchase.outsourced_receipt:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listReceipts(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      requirePerm('purchase.outsourced_receipt:create'),
      zValidator(
        'json',
        z
          .object({
            companyId: z.string().uuid(),
            receiptNo: z.string().nullable().optional(),
            receiptDate: z.string().nullable().optional(),
            postingDate: z.string().nullable().optional(),
            partyType: z.string().min(1),
            partyId: z.string().uuid(),
            remarks: z.string().nullable().optional(),
            warehouseId: z.string().uuid().nullable().optional(),
            outsourcedWarehouseId: z.string().uuid().nullable().optional(),
            debitAccountId: z.string().uuid().nullable().optional(),
            creditAccountId: z.string().uuid().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => c.json(await outsourced.createReceipt(c.get('actor'), c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      requirePerm('purchase.outsourced_receipt:read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getReceipt(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.outsourced_receipt:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            receiptNo: z.string().optional(),
            receiptDate: z.string().optional(),
            postingDate: z.string().nullable().optional(),
            partyType: z.string().optional(),
            partyId: z.string().uuid().optional(),
            remarks: z.string().nullable().optional(),
            warehouseId: z.string().uuid().nullable().optional(),
            outsourcedWarehouseId: z.string().uuid().nullable().optional(),
            debitAccountId: z.string().uuid().optional(),
            creditAccountId: z.string().uuid().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await outsourced.updateReceipt(c.get('actor'), c.req.valid('param').id, {
            ...body,
            postingDatePresent: presentKey(raw, 'postingDate'),
            remarksPresent: presentKey(raw, 'remarks'),
            warehouseIdPresent: presentKey(raw, 'warehouseId'),
            outsourcedWarehouseIdPresent: presentKey(raw, 'outsourcedWarehouseId'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      requirePerm('purchase.outsourced_receipt:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteReceipt(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      requirePerm('purchase.outsourced_receipt:audit'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        let postingDate: string | null | undefined
        try {
          const raw = (await c.req.json()) as Record<string, unknown>
          if (raw && typeof raw === 'object' && 'postingDate' in raw) {
            postingDate =
              raw.postingDate === null || raw.postingDate === undefined
                ? null
                : String(raw.postingDate)
          }
        } catch {
          // empty body is fine
        }
        return c.json(
          await outsourced.auditReceipt(c.get('actor'), c.req.valid('param').id, {
            postingDate,
          }),
        )
      },
    )
    .post(
      '/:id/void',
      requirePerm('purchase.outsourced_receipt:void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.voidReceipt(c.get('actor'), c.req.valid('param').id)),
    )
}

export function outsourcedReceiptItemRoutes(deps: {
  auth: AuthService
  outsourced: OutsourcedService
}) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('purchase.outsourced_receipt:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listReceiptItems(c.get('actor'), toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      requirePerm('purchase.outsourced_receipt:create'),
      zValidator(
        'json',
        z
          .object({
            receiptId: z.string().uuid(),
            idx: z.number().int(),
            qty: decimalString,
            orderItemId: z.string().uuid(),
            unitId: z.string().uuid().nullable().optional(),
            warehouseId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) =>
        c.json(await outsourced.createReceiptItem(c.get('actor'), c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      requirePerm('purchase.outsourced_receipt:read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getReceiptItem(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.outsourced_receipt:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            idx: z.number().int().optional(),
            qty: decimalString.optional(),
            orderItemId: z.string().uuid().optional(),
            unitId: z.string().uuid().nullable().optional(),
            warehouseId: z.string().uuid().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await outsourced.updateReceiptItem(c.get('actor'), c.req.valid('param').id, {
            ...body,
            unitIdPresent: presentKey(raw, 'unitId'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      requirePerm('purchase.outsourced_receipt:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteReceiptItem(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function outsourcedReceiptMaterialRoutes(deps: {
  auth: AuthService
  outsourced: OutsourcedService
}) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('purchase.outsourced_receipt:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listReceiptMaterials(
          c.get('actor'),
          toList(c.req.valid('json')),
        )
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      requirePerm('purchase.outsourced_receipt:create'),
      zValidator(
        'json',
        z
          .object({
            receiptItemId: z.string().uuid(),
            idx: z.number().int(),
            qty: decimalString,
            orderItemMaterialId: z.string().uuid(),
            outsourcedWarehouseId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) =>
        c.json(
          await outsourced.createReceiptMaterial(c.get('actor'), c.req.valid('json')),
          201,
        ),
    )
    .get(
      '/:id',
      requirePerm('purchase.outsourced_receipt:read'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await outsourced.getReceiptMaterial(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.outsourced_receipt:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            idx: z.number().int().optional(),
            qty: decimalString.optional(),
            orderItemMaterialId: z.string().uuid().optional(),
            outsourcedWarehouseId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await outsourced.updateReceiptMaterial(c.get('actor'), c.req.valid('param').id, {
            ...body,
            outsourcedWarehouseIdPresent: presentKey(raw, 'outsourcedWarehouseId'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      requirePerm('purchase.outsourced_receipt:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteReceiptMaterial(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function outsourcedReceiptByproductRoutes(deps: {
  auth: AuthService
  outsourced: OutsourcedService
}) {
  const { auth, outsourced } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      requirePerm('purchase.outsourced_receipt:read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listReceiptByproducts(
          c.get('actor'),
          toList(c.req.valid('json')),
        )
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      requirePerm('purchase.outsourced_receipt:create'),
      zValidator(
        'json',
        z
          .object({
            receiptItemId: z.string().uuid(),
            idx: z.number().int(),
            qty: decimalString,
            orderItemByproductId: z.string().uuid(),
            warehouseId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) =>
        c.json(
          await outsourced.createReceiptByproduct(c.get('actor'), c.req.valid('json')),
          201,
        ),
    )
    .get(
      '/:id',
      requirePerm('purchase.outsourced_receipt:read'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await outsourced.getReceiptByproduct(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      requirePerm('purchase.outsourced_receipt:update'),
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            idx: z.number().int().optional(),
            qty: decimalString.optional(),
            orderItemByproductId: z.string().uuid().optional(),
            warehouseId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json')
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await outsourced.updateReceiptByproduct(c.get('actor'), c.req.valid('param').id, {
            ...body,
            warehouseIdPresent: presentKey(raw, 'warehouseId'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      requirePerm('purchase.outsourced_receipt:delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteReceiptByproduct(c.get('actor'), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

/** @deprecated use dedicated material/byproduct route factories */
export function outsourcedReceiptChildRoutes(deps: {
  auth: AuthService
  outsourced: OutsourcedService
}) {
  return outsourcedReceiptMaterialRoutes(deps)
}
