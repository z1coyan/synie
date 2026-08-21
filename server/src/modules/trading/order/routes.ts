/**
 * 销售/采购订单 REST：逐端点挂 `guard(资源, 动作)`（requireAuth 之后），
 * handler 用 `permitOf(c)` 取凭证。资源名按 side 从 spec 取（`orderSpec(side).headResource`），
 * 动作码唯一事实源是 meta 的 actions——不再由 `orderSpec(side).prefix` 动态拼码。
 * 聚合 PUT（整单替换）声明式要求 update ∧ create ∧ delete：替换语义天然含子树增删。
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
import { dateOnlySchema, decimalStringSchema, draftValidationHook, listQuerySchema, toListQuery, validationHook } from '~/platform/http/zod.ts'
import { aggregateReplaceGuard, idParam } from '~/platform/standard/routes.ts'
import type { TradingSide } from '../common.ts'
import { presentKey } from '../common.ts'
import {
  ORDER_BYPRODUCT_RESOURCE,
  ORDER_MATERIAL_RESOURCE,
  type OutsourcedConfigService,
} from './outsourced-config.ts'
import type { OrderService } from './service.ts'
import { orderSpec } from './spec.ts'

const orderDraftLineSchema = z
  .object({
    id: z.string().uuid().optional(),
    materialId: z.string().uuid(),
    unitId: z.string().uuid(),
    quantity: decimalStringSchema,
    remarks: z.string().nullable().optional(),
  })
  .strict()

const orderDraftItemFields = {
  id: z.string().uuid().optional(),
  idx: z.number().int(),
  qty: decimalStringSchema,
  materialId: z.string().uuid(),
  unitId: z.string().uuid(),
  price: decimalStringSchema.nullable().optional(),
  taxRate: decimalStringSchema.nullable().optional(),
  remarks: z.string().nullable().optional(),
  quotationItemId: z.string().uuid().nullable().optional(),
  bomId: z.string().uuid().nullable().optional(),
  demandLineId: z.string().uuid().nullable().optional(),
  demandDate: dateOnlySchema.nullable().optional(),
}

const orderDraftCreateItemSchema = z
  .object({
    ...orderDraftItemFields,
    issueLines: z.array(orderDraftLineSchema).default([]),
    byproductLines: z.array(orderDraftLineSchema).default([]),
  })
  .strict()

const orderDraftReplaceItemSchema = z
  .object({
    ...orderDraftItemFields,
    issueLines: z.array(orderDraftLineSchema),
    byproductLines: z.array(orderDraftLineSchema),
  })
  .strict()

const orderDraftHeadFields = {
  companyId: z.string().uuid(),
  orderNo: z.string().nullable().optional(),
  orderDate: dateOnlySchema.nullable().optional(),
  orderType: z.string().optional(),
  isOutsourced: z.boolean().optional(),
  partyType: z.string().min(1),
  partyId: z.string().uuid(),
  currencyId: z.string().uuid().nullable().optional(),
  exchangeRate: decimalStringSchema.nullable().optional(),
  terms: z.string().nullable().optional(),
  remarks: z.string().nullable().optional(),
}

const orderDraftCreateSchema = z
  .object({
    ...orderDraftHeadFields,
    // 兼容仍只创建空表头的领域调用；聚合抽屉始终发送完整 items。
    items: z.array(orderDraftCreateItemSchema).default([]),
  })
  .strict()

// PUT 是全量替换：顶层 items 与每个条目的两类委外子树必须显式提交。
const orderDraftReplaceSchema = z
  .object({
    ...orderDraftHeadFields,
    items: z.array(orderDraftReplaceItemSchema),
  })
  .strict()

export function orderHeadRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  orders: OrderService
  side: TradingSide
}) {
  const { auth, authz, orders, side } = deps
  const resource = orderSpec(side).headResource
  const guard = (action: string) => authz.guard(resource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orders.listHeads(permitOf(c), side, toListQuery(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      guard('create'),
      zValidator('json', orderDraftCreateSchema, draftValidationHook()),
      async (c) => c.json(await orders.createDraft(permitOf(c), side, c.req.valid('json')), 201),
    )
    .get('/:id/draft', guard('read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getDraft(permitOf(c), side, c.req.valid('param').id)),
    )
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .put(
      '/:id',
      aggregateReplaceGuard(authz, resource),
      zValidator('param', idParam, validationHook),
      zValidator('json', orderDraftReplaceSchema, draftValidationHook()),
      async (c) =>
        c.json(
          await orders.replaceDraft(
            permitOf(c),
            side,
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
        ),
    )
    .patch(
      '/:id',
      guard('update'),
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
          await orders.updateHead(permitOf(c), side, c.req.valid('param').id, {
            ...body,
            termsPresent: presentKey(raw, 'terms'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await orders.deleteHead(permitOf(c), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', guard('audit'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.audit(permitOf(c), side, c.req.valid('param').id)),
    )
    .post('/:id/close', guard('audit'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.close(permitOf(c), side, c.req.valid('param').id)),
    )
    .post('/:id/void', guard('void'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.void(permitOf(c), side, c.req.valid('param').id)),
    )
    .get('/:id/history', guard('read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.history(permitOf(c), side, c.req.valid('param').id)),
    )
}

export function orderItemRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  orders: OrderService
  side: TradingSide
}) {
  const { auth, authz, orders, side } = deps
  // 条目是 via(母单) 子资源：动作码解析到订单头（子资源无独立权限点）
  const guard = (action: string) => authz.guard(orderSpec(side).itemResource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orders.listItems(permitOf(c), side, toListQuery(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      guard('create'),
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
      async (c) => c.json(await orders.createItem(permitOf(c), side, c.req.valid('json')), 201),
    )
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getItem(permitOf(c), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      guard('update'),
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
          await orders.updateItem(permitOf(c), side, c.req.valid('param').id, {
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
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await orders.deleteItem(permitOf(c), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function purchaseOrderExtraRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  outsourcedConfig: OutsourcedConfigService
}) {
  const { auth, authz, outsourcedConfig: cfg } = deps
  // 发料/副产物清单是 via(purOrderItems → purOrders) 子资源；
  // 需求池与 BOM 展开是采购订单录入的读侧辅助，沿用订单头 read（不新增权限码）
  const materialGuard = (action: string) => authz.guard(ORDER_MATERIAL_RESOURCE, action)
  const byproductGuard = (action: string) => authz.guard(ORDER_BYPRODUCT_RESOURCE, action)
  const orderReadGuard = () => authz.guard(orderSpec('purchase').headResource, 'read')
  const material = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', materialGuard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await cfg.listMaterials(permitOf(c), toListQuery(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      materialGuard('create'),
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
      async (c) => c.json(await cfg.createMaterial(permitOf(c), c.req.valid('json')), 201),
    )
    .get('/:id', materialGuard('read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await cfg.getMaterial(permitOf(c), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      materialGuard('update'),
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
          await cfg.updateMaterial(permitOf(c), c.req.valid('param').id, {
            ...c.req.valid('json'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', materialGuard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await cfg.deleteMaterial(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })

  const byproduct = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', byproductGuard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await cfg.listByproducts(permitOf(c), toListQuery(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      byproductGuard('create'),
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
      async (c) => c.json(await cfg.createByproduct(permitOf(c), c.req.valid('json')), 201),
    )
    .get('/:id', byproductGuard('read'), zValidator('param', idParam, validationHook), async (c) =>
      c.json(await cfg.getByproduct(permitOf(c), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      byproductGuard('update'),
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
          await cfg.updateByproduct(permitOf(c), c.req.valid('param').id, {
            ...c.req.valid('json'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', byproductGuard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await cfg.deleteByproduct(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })

  const demand = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      orderReadGuard(),
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
      async (c) => c.json(await cfg.queryDemandPool(permitOf(c), c.req.valid('json'))),
    )

  const bom = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/expand',
      orderReadGuard(),
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
        return c.json(await cfg.expandBom(permitOf(c), { bomId: body.bomId, quantity }))
      },
    )

  return { material, byproduct, demand, bom }
}
