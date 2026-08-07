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
import { dateOnlySchema, decimalStringSchema, draftValidationHook, listQuerySchema, toListQuery, validationHook } from '~/platform/http/zod.ts'
import { idParam } from '~/platform/standard/routes.ts'
import { presentKey } from '../common.ts'
import type { FulfillmentService } from './service.ts'
import { fulfillmentSpec, PACK_BOX_RESOURCE, PACK_LINE_RESOURCE } from './spec.ts'

export interface FulfillmentRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  fulfillment: FulfillmentService
}

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

const salesDraftItemSchema = z
  .object({
    id: z.string().uuid().optional(),
    idx: z.number().int(),
    qty: decimalStringSchema,
    orderItemId: z.string().uuid(),
    unitId: z.string().uuid().nullable().optional(),
    warehouseId: z.string().uuid().nullable(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const salesDraftPackLineSchema = z
  .object({
    id: z.string().uuid().optional(),
    idx: z.number().int(),
    qty: decimalStringSchema,
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

const salesDraftFields = {
  companyId: z.string().uuid(),
  deliveryNo: z.string().nullable().optional(),
  deliveryDate: dateOnlySchema.nullable().optional(),
  postingDate: dateOnlySchema.nullable().optional(),
  partyType: z.string().min(1),
  partyId: z.string().uuid(),
  remarks: z.string().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  debitAccountId: z.string().uuid(),
  creditAccountId: z.string().uuid(),
}

const salesDraftCreateSchema = z
  .object({
    ...salesDraftFields,
    items: z.array(salesDraftItemSchema),
    packBoxes: z.array(salesDraftPackBoxSchema),
  })
  .strict()

const salesDraftReplaceSchema = z
  .object({
    ...salesDraftFields,
    items: z.array(salesDraftItemSchema),
    packBoxes: z.array(salesDraftPackBoxSchema),
  })
  .strict()

const purchaseReceiptDraftFields = {
  companyId: z.string().uuid(),
  receiptNo: z.string().nullable().optional(),
  receiptDate: dateOnlySchema.nullable().optional(),
  postingDate: dateOnlySchema.nullable().optional(),
  partyType: z.string().min(1),
  partyId: z.string().uuid(),
  remarks: z.string().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  debitAccountId: z.string().uuid(),
  creditAccountId: z.string().uuid(),
}

const purchaseReceiptDraftCreateSchema = z
  .object({
    ...purchaseReceiptDraftFields,
    // 兼容仍只创建空表头的领域调用；聚合抽屉始终显式发送完整 items。
    items: z.array(salesDraftItemSchema).default([]),
  })
  .strict()

const purchaseReceiptDraftReplaceSchema = z
  .object({
    ...purchaseReceiptDraftFields,
    items: z.array(salesDraftItemSchema),
  })
  .strict()

function toSalesDraftInput(
  body: z.infer<typeof salesDraftCreateSchema> | z.infer<typeof salesDraftReplaceSchema>,
) {
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

function toPurchaseReceiptDraftInput(
  body:
    | z.infer<typeof purchaseReceiptDraftCreateSchema>
    | z.infer<typeof purchaseReceiptDraftReplaceSchema>,
) {
  return {
    companyId: body.companyId,
    no: body.receiptNo,
    documentDate: body.receiptDate,
    postingDate: body.postingDate,
    partyType: body.partyType,
    partyId: body.partyId,
    remarks: body.remarks,
    warehouseId: body.warehouseId,
    debitAccountId: body.debitAccountId,
    creditAccountId: body.creditAccountId,
    items: body.items,
  }
}

export function salesFulfillmentHeadRoutes(deps: FulfillmentRouteDeps) {
  const { auth, authz, fulfillment } = deps
  const RESOURCE = fulfillmentSpec('sales').headResource
  const headGuard = (action: string) => authz.guard(RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      headGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await fulfillment.listHeads(permitOf(c), 'sales', toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      headGuard('create'),
      zValidator('json', salesDraftCreateSchema, draftValidationHook(['items', 'packBoxes'])),
      async (c) =>
        c.json(
          await fulfillment.createSalesDraft(
            permitOf(c),
            toSalesDraftInput(c.req.valid('json')),
          ),
          201,
        ),
    )
    // 完整聚合草稿读取（无分页截断）；须在 /:id 之前注册更具体路径
    .get(
      '/:id/draft',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.getSalesDraft(permitOf(c), c.req.valid('param').id)),
    )
    .get(
      '/:id',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.getHead(permitOf(c), 'sales', c.req.valid('param').id)),
    )
    .put(
      '/:id',
      aggregateReplaceGuard(authz, RESOURCE),
      zValidator('param', idParam, validationHook),
      zValidator('json', salesDraftReplaceSchema, draftValidationHook(['items', 'packBoxes'])),
      async (c) =>
        c.json(
          await fulfillment.replaceSalesDraft(
            permitOf(c),
            c.req.valid('param').id,
            toSalesDraftInput(c.req.valid('json')),
          ),
        ),
    )
    .delete(
      '/:id',
      headGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await fulfillment.deleteHead(permitOf(c), 'sales', c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      headGuard('audit'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.auditHead(permitOf(c), 'sales', c.req.valid('param').id)),
    )
    .post(
      '/:id/void',
      headGuard('void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.voidHead(permitOf(c), 'sales', c.req.valid('param').id)),
    )
}

export function purchaseFulfillmentHeadRoutes(deps: FulfillmentRouteDeps) {
  const { auth, authz, fulfillment } = deps
  const side = 'purchase'
  const RESOURCE = fulfillmentSpec(side).headResource
  const headGuard = (action: string) => authz.guard(RESOURCE, action)
  const numberKey = 'receiptNo'
  const dateKey = 'receiptDate'
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      headGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await fulfillment.listHeads(permitOf(c), side, toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      headGuard('create'),
      zValidator('json', purchaseReceiptDraftCreateSchema, draftValidationHook(['items', 'packBoxes'])),
      async (c) =>
        c.json(
          await fulfillment.createPurchaseReceiptDraft(
            permitOf(c),
            toPurchaseReceiptDraftInput(c.req.valid('json')),
          ),
          201,
        ),
    )
    // 完整聚合草稿读取（无分页截断）
    .get(
      '/:id/draft',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await fulfillment.getPurchaseReceiptDraft(permitOf(c), c.req.valid('param').id)),
    )
    .get(
      '/:id',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.getHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .put(
      '/:id',
      aggregateReplaceGuard(authz, RESOURCE),
      zValidator('param', idParam, validationHook),
      zValidator('json', purchaseReceiptDraftReplaceSchema, draftValidationHook(['items', 'packBoxes'])),
      async (c) =>
        c.json(
          await fulfillment.replacePurchaseReceiptDraft(
            permitOf(c),
            c.req.valid('param').id,
            toPurchaseReceiptDraftInput(c.req.valid('json')),
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
          await fulfillment.updatePurchaseHead(permitOf(c), c.req.valid('param').id, {
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
    .delete(
      '/:id',
      headGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await fulfillment.deleteHead(permitOf(c), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      headGuard('audit'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.auditHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/void',
      headGuard('void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.voidHead(permitOf(c), side, c.req.valid('param').id)),
    )
}

export function purchaseFulfillmentItemRoutes(deps: FulfillmentRouteDeps) {
  const { auth, authz, fulfillment } = deps
  // 条目是 via 子资源：guard 解析到母资源（purReceipts）的动作码
  const itemGuard = (action: string) => authz.guard(fulfillmentSpec('purchase').itemResource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      itemGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await fulfillment.listItems(permitOf(c), 'purchase', toListQuery(c.req.valid('json')))
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
            qty: z.string().min(1),
            orderItemId: z.string().uuid(),
            unitId: z.string().uuid().nullable().optional(),
            warehouseId: z.string().uuid().nullable(),
            remarks: z.string().nullable().optional(),
          })
          .passthrough(),
        validationHook,
      ),
      async (c) => {
        const body = c.req.valid('json') as Record<string, unknown>
        return c.json(
          await fulfillment.createPurchaseItem(permitOf(c), {
            receiptId: body.receiptId as string,
            idx: body.idx as number,
            qty: body.qty as string,
            orderItemId: body.orderItemId as string,
            unitId: body.unitId as string | null | undefined,
            warehouseId: body.warehouseId as string | null,
            remarks: body.remarks as string | null | undefined,
          }),
          201,
        )
      },
    )
    .get(
      '/:id',
      itemGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await fulfillment.getItem(permitOf(c), 'purchase', c.req.valid('param').id)),
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
            orderItemId: z.string().uuid().optional(),
            unitId: z.string().uuid().nullable().optional(),
            warehouseId: z.string().uuid().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        return c.json(
          await fulfillment.updatePurchaseItem(permitOf(c), c.req.valid('param').id, {
            ...c.req.valid('json'),
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
        await fulfillment.deletePurchaseItem(permitOf(c), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function salesFulfillmentItemRoutes(deps: FulfillmentRouteDeps) {
  const { auth, authz, fulfillment } = deps
  // 聚合草稿的子资源只读：写由整单 PUT 承担
  const itemGuard = (action: string) => authz.guard(fulfillmentSpec('sales').itemResource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      itemGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await fulfillment.listItems(permitOf(c), 'sales', toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .get(
      '/:id',
      itemGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.getItem(permitOf(c), 'sales', c.req.valid('param').id)),
    )
}

export function packBoxRoutes(deps: FulfillmentRouteDeps) {
  const { auth, authz, fulfillment } = deps
  const boxGuard = (action: string) => authz.guard(PACK_BOX_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      boxGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await fulfillment.listPackBoxes(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .get(
      '/:id',
      boxGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.getPackBox(permitOf(c), c.req.valid('param').id)),
    )
}

export function packLineRoutes(deps: FulfillmentRouteDeps) {
  const { auth, authz, fulfillment } = deps
  const lineGuard = (action: string) => authz.guard(PACK_LINE_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      lineGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await fulfillment.listPackLines(permitOf(c), toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .get(
      '/:id',
      lineGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await fulfillment.getPackLine(permitOf(c), c.req.valid('param').id)),
    )
}
