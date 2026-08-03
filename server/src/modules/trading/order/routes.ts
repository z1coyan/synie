import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { dateOnlySchema, decimalStringSchema, listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { TradingSide } from '../common.ts'
import { presentKey } from '../common.ts'
import type { OutsourcedConfigService } from './outsourced-config.ts'
import type { OrderService } from './service.ts'

const idParam = z.object({ id: z.string().uuid() })

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

function orderDraftValidationHook(result: {
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
    else if (!key.startsWith('items')) key = `header.${key}`
    ;(fields[key] ??= []).push(issue.message)
  }
  throw ApiError.validation('请求参数错误', fields)
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

export function orderHeadRoutes(deps: {
  auth: AuthService
  orders: OrderService
  side: TradingSide
}) {
  const { auth, orders, side } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orders.listHeads(c.get('actor'), side, toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
      zValidator('json', orderDraftCreateSchema, orderDraftValidationHook),
      async (c) => c.json(await orders.createDraft(c.get('actor'), side, c.req.valid('json')), 201),
    )
    .get('/:id/draft', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getDraft(c.get('actor'), side, c.req.valid('param').id)),
    )
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .put(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', orderDraftReplaceSchema, orderDraftValidationHook),
      async (c) =>
        c.json(
          await orders.replaceDraft(
            c.get('actor'),
            side,
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
        ),
    )
    .patch(
      '/:id',
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
          await orders.updateHead(c.get('actor'), side, c.req.valid('param').id, {
            ...body,
            termsPresent: presentKey(raw, 'terms'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await orders.deleteHead(c.get('actor'), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.audit(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post('/:id/close', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.close(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post('/:id/void', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.void(c.get('actor'), side, c.req.valid('param').id)),
    )
    .get('/:id/history', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.history(c.get('actor'), side, c.req.valid('param').id)),
    )
}

export function orderItemRoutes(deps: {
  auth: AuthService
  orders: OrderService
  side: TradingSide
}) {
  const { auth, orders, side } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await orders.listItems(c.get('actor'), side, toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
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
      async (c) => c.json(await orders.createItem(c.get('actor'), side, c.req.valid('json')), 201),
    )
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await orders.getItem(c.get('actor'), side, c.req.valid('param').id)),
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
          await orders.updateItem(c.get('actor'), side, c.req.valid('param').id, {
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
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await orders.deleteItem(c.get('actor'), side, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function purchaseOrderExtraRoutes(deps: {
  auth: AuthService
  outsourcedConfig: OutsourcedConfigService
}) {
  const { auth, outsourcedConfig: cfg } = deps
  const material = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await cfg.listMaterials(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
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
      async (c) => c.json(await cfg.createMaterial(c.get('actor'), c.req.valid('json')), 201),
    )
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await cfg.getMaterial(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
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
          await cfg.updateMaterial(c.get('actor'), c.req.valid('param').id, {
            ...c.req.valid('json'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await cfg.deleteMaterial(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })

  const byproduct = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', zValidator('json', listQuerySchema, validationHook), async (c) => {
      const r = await cfg.listByproducts(c.get('actor'), toList(c.req.valid('json')))
      return c.json({ count: r.count, results: r.results })
    })
    .post(
      '/',
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
      async (c) => c.json(await cfg.createByproduct(c.get('actor'), c.req.valid('json')), 201),
    )
    .get('/:id', zValidator('param', idParam, validationHook), async (c) =>
      c.json(await cfg.getByproduct(c.get('actor'), c.req.valid('param').id)),
    )
    .patch(
      '/:id',
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
          await cfg.updateByproduct(c.get('actor'), c.req.valid('param').id, {
            ...c.req.valid('json'),
            remarksPresent: presentKey(raw, 'remarks'),
          }),
        )
      },
    )
    .delete('/:id', zValidator('param', idParam, validationHook), async (c) => {
      await cfg.deleteByproduct(c.get('actor'), c.req.valid('param').id)
      return c.body(null, 204)
    })

  const demand = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
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
      async (c) => c.json(await cfg.queryDemandPool(c.get('actor'), c.req.valid('json'))),
    )

  const bom = new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/expand',
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
        return c.json(await cfg.expandBom(c.get('actor'), { bomId: body.bomId, quantity }))
      },
    )

  return { material, byproduct, demand, bom }
}
