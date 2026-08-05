/**
 * 销售/采购对账 REST（双边同构，资源名由 spec 按 side 给出）。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后、zValidator 之前），
 * handler 用 `permitOf(c)` 取凭证。工作流动作逐个挂自己的码
 * （confirm / unconfirm / audit=结单 / void）。
 * 条目是 via 子资源：`guard(itemResource, 'create'|'update'|'delete')` 由平台解析到母资源动作码。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { TradingSide } from '../common.ts'
import { presentKey } from '../common.ts'
import type { ReconciliationService } from './service.ts'
import { reconciliationSpec } from './spec.ts'

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
  authz: AuthzEnforcer
  reconciliations: ReconciliationService
  side: TradingSide
}) {
  const { auth, authz, reconciliations, side } = deps
  const headGuard = (action: string) => authz.guard(reconciliationSpec(side).headResource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      headGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await reconciliations.listHeads(permitOf(c), side, toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      headGuard('create'),
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
          await reconciliations.createHead(permitOf(c), side, {
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
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.getHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      headGuard('update'),
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
          await reconciliations.updateHead(permitOf(c), side, c.req.valid('param').id, {
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
      headGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await reconciliations.deleteHead(permitOf(c), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/confirm',
      headGuard('confirm'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.confirm(permitOf(c), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/unconfirm',
      headGuard('unconfirm'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await reconciliations.unconfirm(permitOf(c), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/audit',
      headGuard('audit'),
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
          await reconciliations.audit(permitOf(c), side, c.req.valid('param').id, {
            postingDate,
          }),
        )
      },
    )
    .post(
      '/:id/void',
      headGuard('void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.void(permitOf(c), side, c.req.valid('param').id)),
    )
}

export function reconciliationItemRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  reconciliations: ReconciliationService
  side: TradingSide
}) {
  const { auth, authz, reconciliations, side } = deps
  const itemGuard = (action: string) => authz.guard(reconciliationSpec(side).itemResource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      itemGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await reconciliations.listItems(permitOf(c), side, toList(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      itemGuard('create'),
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
      async (c) => c.json(await reconciliations.createItem(permitOf(c), side, c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      itemGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.getItem(permitOf(c), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      itemGuard('update'),
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
          await reconciliations.updateItem(permitOf(c), side, c.req.valid('param').id, {
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
      itemGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await reconciliations.deleteItem(permitOf(c), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}
