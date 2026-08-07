/**
 * 委外发料 / 委外入库 REST。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后、zValidator 之前），handler 用 `permitOf(c)` 取凭证。
 * 动作码唯一事实源是 meta：子行/材料/副产物只声明 read，其余动作经 via 链解析到母资源动作码。
 * 整单草稿三连（POST 创建草稿 / GET :id/draft / PUT :id 全量替换）与报价/订单/履约先例同形；
 * PUT 聚合写要求 update ∧ create ∧ delete。委外入库草稿树只含成品行——材料/副产物行走独立 CRUD。
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
import { draftValidationHook, listQuerySchema, toListQuery, validationHook } from '~/platform/http/zod.ts'
import { idParam } from '~/platform/standard/routes.ts'
import { presentKey } from '../common.ts'
import {
  ISSUE_ITEM_RESOURCE,
  ISSUE_RESOURCE,
  RECEIPT_BYPRODUCT_RESOURCE,
  RECEIPT_ITEM_RESOURCE,
  RECEIPT_MATERIAL_RESOURCE,
  RECEIPT_RESOURCE,
  type OutsourcedService,
} from './service.ts'

export interface OutsourcedRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  outsourced: OutsourcedService
}

const decimalString = z.union([z.string(), z.number()]).transform((v) => String(v))

const issueDraftItemSchema = z
  .object({
    id: z.string().uuid().optional(),
    idx: z.number().int(),
    qty: decimalString,
    orderItemMaterialId: z.string().uuid(),
    fromWarehouseId: z.string().uuid().nullable().optional(),
    outsourcedWarehouseId: z.string().uuid().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const issueDraftHeadFields = {
  companyId: z.string().uuid(),
  issueNo: z.string().nullable().optional(),
  issueDate: z.string().nullable().optional(),
  partyType: z.string().min(1),
  partyId: z.string().uuid(),
  remarks: z.string().nullable().optional(),
  fromWarehouseId: z.string().uuid().nullable().optional(),
  outsourcedWarehouseId: z.string().uuid().nullable().optional(),
}

const issueDraftCreateSchema = z
  .object({
    ...issueDraftHeadFields,
    // 兼容仍只创建空表头的领域调用；聚合抽屉始终显式发送完整 items。
    items: z.array(issueDraftItemSchema).default([]),
  })
  .strict()

// PUT 是全量替换：顶层 items 必须显式提交。
const issueDraftReplaceSchema = z
  .object({
    ...issueDraftHeadFields,
    items: z.array(issueDraftItemSchema),
  })
  .strict()

const receiptDraftItemSchema = z
  .object({
    id: z.string().uuid().optional(),
    idx: z.number().int(),
    qty: decimalString,
    orderItemId: z.string().uuid(),
    unitId: z.string().uuid().nullable().optional(),
    warehouseId: z.string().uuid().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const receiptDraftHeadFields = {
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
}

const receiptDraftCreateSchema = z
  .object({
    ...receiptDraftHeadFields,
    // 兼容仍只创建空表头的领域调用；聚合抽屉始终显式发送完整 items。
    items: z.array(receiptDraftItemSchema).default([]),
  })
  .strict()

// PUT 是全量替换：顶层 items 必须显式提交。
const receiptDraftReplaceSchema = z
  .object({
    ...receiptDraftHeadFields,
    items: z.array(receiptDraftItemSchema),
  })
  .strict()

/**
 * 聚合草稿整单替换的码级门控：一次 PUT 可同时新增/修改/删除子树，
 * 故要求 `update` ∧ `create` ∧ `delete`（附加码由 prefix 拼，不写字面量）。
 */
function aggregateReplaceGuard(authz: AuthzEnforcer, headResource: string) {
  const { prefix } = authz.targetOf(headResource)
  return authz.guard(headResource, 'update', {
    allOf: [`${prefix}:create`, `${prefix}:delete`],
  })
}

export function outsourcedIssueRoutes(deps: OutsourcedRouteDeps) {
  const { auth, authz, outsourced } = deps
  const issueGuard = (action: string) => authz.guard(ISSUE_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      issueGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listIssues(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      issueGuard('create'),
      zValidator('json', issueDraftCreateSchema, draftValidationHook()),
      async (c) => c.json(await outsourced.createIssueDraft(permitOf(c), c.req.valid('json')), 201),
    )
    // 完整聚合草稿读取（无分页截断）；须在 /:id 之前注册更具体路径
    .get(
      '/:id/draft',
      issueGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getIssueDraft(permitOf(c), c.req.valid('param').id)),
    )
    .get(
      '/:id',
      issueGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getIssue(permitOf(c), c.req.valid('param').id)),
    )
    .put(
      '/:id',
      aggregateReplaceGuard(authz, ISSUE_RESOURCE),
      zValidator('param', idParam, validationHook),
      zValidator('json', issueDraftReplaceSchema, draftValidationHook()),
      async (c) =>
        c.json(
          await outsourced.replaceIssueDraft(
            permitOf(c),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
        ),
    )
    .patch(
      '/:id',
      issueGuard('update'),
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
          await outsourced.updateIssue(permitOf(c), c.req.valid('param').id, {
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
      issueGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteIssue(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      issueGuard('audit'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.auditIssue(permitOf(c), c.req.valid('param').id)),
    )
    .post(
      '/:id/void',
      issueGuard('void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.voidIssue(permitOf(c), c.req.valid('param').id)),
    )
}

export function outsourcedIssueItemRoutes(deps: OutsourcedRouteDeps) {
  const { auth, authz, outsourced } = deps
  const itemGuard = (action: string) => authz.guard(ISSUE_ITEM_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      itemGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listIssueItems(permitOf(c), toListQuery(c.req.valid('json')))
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
        c.json(await outsourced.createIssueItem(permitOf(c), c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      itemGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getIssueItem(permitOf(c), c.req.valid('param').id)),
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
          await outsourced.updateIssueItem(permitOf(c), c.req.valid('param').id, {
            ...body,
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
        await outsourced.deleteIssueItem(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function outsourcedReceiptRoutes(deps: OutsourcedRouteDeps) {
  const { auth, authz, outsourced } = deps
  const receiptGuard = (action: string) => authz.guard(RECEIPT_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      receiptGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listReceipts(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      receiptGuard('create'),
      zValidator('json', receiptDraftCreateSchema, draftValidationHook()),
      async (c) =>
        c.json(await outsourced.createReceiptDraft(permitOf(c), c.req.valid('json')), 201),
    )
    // 完整聚合草稿读取（无分页截断）；须在 /:id 之前注册更具体路径
    .get(
      '/:id/draft',
      receiptGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getReceiptDraft(permitOf(c), c.req.valid('param').id)),
    )
    .get(
      '/:id',
      receiptGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getReceipt(permitOf(c), c.req.valid('param').id)),
    )
    .put(
      '/:id',
      aggregateReplaceGuard(authz, RECEIPT_RESOURCE),
      zValidator('param', idParam, validationHook),
      zValidator('json', receiptDraftReplaceSchema, draftValidationHook()),
      async (c) =>
        c.json(
          await outsourced.replaceReceiptDraft(
            permitOf(c),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
        ),
    )
    .patch(
      '/:id',
      receiptGuard('update'),
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
          await outsourced.updateReceipt(permitOf(c), c.req.valid('param').id, {
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
      receiptGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteReceipt(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      receiptGuard('audit'),
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
          await outsourced.auditReceipt(permitOf(c), c.req.valid('param').id, {
            postingDate,
          }),
        )
      },
    )
    .post(
      '/:id/void',
      receiptGuard('void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.voidReceipt(permitOf(c), c.req.valid('param').id)),
    )
}

export function outsourcedReceiptItemRoutes(deps: OutsourcedRouteDeps) {
  const { auth, authz, outsourced } = deps
  const itemGuard = (action: string) => authz.guard(RECEIPT_ITEM_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      itemGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listReceiptItems(permitOf(c), toListQuery(c.req.valid('json')))
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
        c.json(await outsourced.createReceiptItem(permitOf(c), c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      itemGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getReceiptItem(permitOf(c), c.req.valid('param').id)),
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
            qty: decimalString.optional(),
            orderItemId: z.string().uuid().optional(),
            unitId: z.string().uuid().nullable().optional(),
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
          await outsourced.updateReceiptItem(permitOf(c), c.req.valid('param').id, {
            ...body,
            unitIdPresent: presentKey(raw, 'unitId'),
            warehouseIdPresent: presentKey(raw, 'warehouseId'),
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
        await outsourced.deleteReceiptItem(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function outsourcedReceiptMaterialRoutes(deps: OutsourcedRouteDeps) {
  const { auth, authz, outsourced } = deps
  const materialGuard = (action: string) => authz.guard(RECEIPT_MATERIAL_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      materialGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listReceiptMaterials(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      materialGuard('create'),
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
        c.json(await outsourced.createReceiptMaterial(permitOf(c), c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      materialGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await outsourced.getReceiptMaterial(permitOf(c), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      materialGuard('update'),
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
          await outsourced.updateReceiptMaterial(permitOf(c), c.req.valid('param').id, {
            ...body,
            outsourcedWarehouseIdPresent: presentKey(raw, 'outsourcedWarehouseId'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      materialGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteReceiptMaterial(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function outsourcedReceiptByproductRoutes(deps: OutsourcedRouteDeps) {
  const { auth, authz, outsourced } = deps
  const byproductGuard = (action: string) => authz.guard(RECEIPT_BYPRODUCT_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      byproductGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await outsourced.listReceiptByproducts(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      byproductGuard('create'),
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
        c.json(await outsourced.createReceiptByproduct(permitOf(c), c.req.valid('json')), 201),
    )
    .get(
      '/:id',
      byproductGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await outsourced.getReceiptByproduct(permitOf(c), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      byproductGuard('update'),
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
          await outsourced.updateReceiptByproduct(permitOf(c), c.req.valid('param').id, {
            ...body,
            warehouseIdPresent: presentKey(raw, 'warehouseId'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete(
      '/:id',
      byproductGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await outsourced.deleteReceiptByproduct(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

/** @deprecated use dedicated material/byproduct route factories */
export function outsourcedReceiptChildRoutes(deps: OutsourcedRouteDeps) {
  return outsourcedReceiptMaterialRoutes(deps)
}
