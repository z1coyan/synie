/**
 * 销售/采购对账 REST（双边同构，资源名由 spec 按 side 给出）。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后、zValidator 之前），
 * handler 用 `permitOf(c)` 取凭证。工作流动作逐个挂自己的码
 * （confirm / unconfirm / audit=结单 / void）。
 * 条目是 via 子资源：`guard(itemResource, 'create'|'update'|'delete')` 由平台解析到母资源动作码。
 * 整单草稿三连（POST 创建草稿 / GET :id/draft / PUT :id 全量替换）与报价/订单/履约先例同形；
 * PUT 聚合写要求 update ∧ create ∧ delete（子树差异天然含增删）。
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
import { ApiError } from '~/platform/http/errors.ts'
import { decimalStringSchema, draftValidationHook, listQuerySchema, toListQuery, validationHook } from '~/platform/http/zod.ts'
import { idParam } from '~/platform/standard/routes.ts'
import type { TradingSide } from '../common.ts'
import { presentKey } from '../common.ts'
import type { ReconciliationService } from './service.ts'
import { reconciliationSpec } from './spec.ts'

const reconciliationDraftItemSchema = z
  .object({
    id: z.string().uuid().optional(),
    idx: z.number().int(),
    qty: decimalStringSchema,
    deliveryItemId: z.string().uuid().nullable().optional(),
    returnItemId: z.string().uuid().nullable().optional(),
    receiptItemId: z.string().uuid().nullable().optional(),
    outsourcedReceiptItemId: z.string().uuid().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const reconciliationDraftHeadFields = {
  companyId: z.string().uuid(),
  reconciliationNo: z.string().nullable().optional(),
  reconciliationType: z.string().min(1),
  partyType: z.string().min(1),
  partyId: z.string().uuid(),
  debitAccountId: z.string().uuid().nullable().optional(),
  creditAccountId: z.string().uuid().nullable().optional(),
  remarks: z.string().nullable().optional(),
}

const reconciliationDraftCreateSchema = z
  .object({
    ...reconciliationDraftHeadFields,
    // 兼容仍只创建空表头的领域调用；聚合抽屉始终显式发送完整 items。
    items: z.array(reconciliationDraftItemSchema).default([]),
  })
  .strict()

// PUT 是全量替换：顶层 items 必须显式提交。
const reconciliationDraftReplaceSchema = z
  .object({
    ...reconciliationDraftHeadFields,
    items: z.array(reconciliationDraftItemSchema),
  })
  .strict()

export function reconciliationHeadRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  reconciliations: ReconciliationService
  side: TradingSide
}) {
  const { auth, authz, reconciliations, side } = deps
  const resource = reconciliationSpec(side).headResource
  const headGuard = (action: string) => authz.guard(resource, action)
  const prefix = authz.targetOf(resource).prefix
  /**
   * 整单 PUT 是聚合写：子树差异可能新增/删除条目，
   * 故在 update 之外叠加同前缀的 create/delete。
   */
  const replaceGuard = authz.guard(resource, 'update', {
    allOf: [`${prefix}:create`, `${prefix}:delete`],
  })
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      headGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await reconciliations.listHeads(permitOf(c), side, toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      headGuard('create'),
      zValidator('json', reconciliationDraftCreateSchema, draftValidationHook()),
      async (c) =>
        c.json(await reconciliations.createDraft(permitOf(c), side, c.req.valid('json')), 201),
    )
    // 完整聚合草稿读取（无分页截断）；须在 /:id 之前注册更具体路径
    .get(
      '/:id/draft',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await reconciliations.getDraft(permitOf(c), side, c.req.valid('param').id)),
    )
    .get(
      '/:id',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.getHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .put(
      '/:id',
      replaceGuard,
      zValidator('param', idParam, validationHook),
      zValidator('json', reconciliationDraftReplaceSchema, draftValidationHook()),
      async (c) =>
        c.json(
          await reconciliations.replaceDraft(
            permitOf(c),
            side,
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
        ),
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
      headGuard('audit'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await reconciliations.confirm(permitOf(c), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/unconfirm',
      headGuard('update'),
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
        const r = await reconciliations.listItems(permitOf(c), side, toListQuery(c.req.valid('json')))
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
            returnItemId: z.string().uuid().nullable().optional(),
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
            returnItemId: z.string().uuid().nullable().optional(),
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
            returnItemId: body.returnItemId,
            returnItemIdPresent: presentKey(raw, 'returnItemId'),
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
