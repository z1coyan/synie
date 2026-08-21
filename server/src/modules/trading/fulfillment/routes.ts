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
import { aggregateReplaceGuard, idParam } from '~/platform/standard/routes.ts'
import { deriveDraftObject, deriveDraftSchemas } from '~/platform/standard/wire.ts'
import { presentKey } from '../common.ts'
import type { FulfillmentService } from './service.ts'
import {
  fulfillmentHeadMeta,
  fulfillmentItemMeta,
  fulfillmentSpec,
  packBoxMeta,
  packLineMeta,
  PACK_BOX_RESOURCE,
  PACK_LINE_RESOURCE,
} from './spec.ts'

export interface FulfillmentRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  fulfillment: FulfillmentService
}

// 草稿 zod 自 meta 派生（类型/格式约束唯一事实源）；readonly 编号手填、子行 id、
// enum 放宽 string 为草稿专属字面量/逐字段补丁。
export const salesDraftItemSchema = deriveDraftObject(fulfillmentItemMeta('sales'), [
  ['id', z.string().uuid().optional()],
  'idx',
  'qty',
  'orderItemId',
  ['unitId', { nullable: true, optional: true }],
  ['warehouseId', { nullable: true, optional: false }],
  ['remarks', { nullable: true }],
])

export const salesDraftPackLineSchema = deriveDraftObject(packLineMeta(), [
  ['id', z.string().uuid().optional()],
  'idx',
  'qty',
  'materialId',
  ['unitId', { nullable: true, optional: true }],
  ['remarks', { nullable: true }],
])

export const salesDraftPackBoxSchema = deriveDraftObject(packBoxMeta(), [
  ['id', z.string().uuid().optional()],
  ['lines', z.array(salesDraftPackLineSchema)],
])

const salesDraftSchemas = deriveDraftSchemas(
  fulfillmentHeadMeta('sales'),
  [
    'companyId',
    ['deliveryNo', z.string().nullable().optional()],
    ['deliveryDate', { nullable: true, optional: true }],
    ['postingDate', { nullable: true }],
    ['partyType', { schema: z.string().min(1) }],
    'partyId',
    ['remarks', { nullable: true }],
    ['warehouseId', { nullable: true }],
    'debitAccountId',
    'creditAccountId',
  ],
  {
    items: {
      create: z.array(salesDraftItemSchema),
      replace: z.array(salesDraftItemSchema),
    },
    packBoxes: {
      create: z.array(salesDraftPackBoxSchema),
      replace: z.array(salesDraftPackBoxSchema),
    },
  },
)

export const salesDraftCreateSchema = salesDraftSchemas.create
export const salesDraftReplaceSchema = salesDraftSchemas.replace

const purchaseReceiptDraftSchemas = deriveDraftSchemas(
  fulfillmentHeadMeta('purchase'),
  [
    'companyId',
    ['receiptNo', z.string().nullable().optional()],
    ['receiptDate', { nullable: true, optional: true }],
    ['postingDate', { nullable: true }],
    ['partyType', { schema: z.string().min(1) }],
    'partyId',
    ['remarks', { nullable: true }],
    ['warehouseId', { nullable: true }],
    'debitAccountId',
    'creditAccountId',
  ],
  {
    items: {
      // 兼容仍只创建空表头的领域调用；聚合抽屉始终显式发送完整 items。
      create: z.array(salesDraftItemSchema).default([]),
      replace: z.array(salesDraftItemSchema),
    },
  },
)

export const purchaseReceiptDraftCreateSchema = purchaseReceiptDraftSchemas.create
export const purchaseReceiptDraftReplaceSchema = purchaseReceiptDraftSchemas.replace

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
