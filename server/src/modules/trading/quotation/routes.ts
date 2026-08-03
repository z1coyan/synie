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
import type { QuotationService } from './service.ts'

const idParam = z.object({ id: z.string().uuid() })

const quotationDraftTierSchema = z
  .object({
    id: z.string().uuid().optional(),
    minQty: decimalStringSchema,
    price: decimalStringSchema,
  })
  .strict()

const quotationDraftItemFields = {
  id: z.string().uuid().optional(),
  idx: z.number().int(),
  materialId: z.string().uuid(),
  unitId: z.string().uuid(),
  pricingMode: z.string().optional(),
  price: decimalStringSchema.nullable().optional(),
  taxRate: decimalStringSchema.nullable().optional(),
  remarks: z.string().nullable().optional(),
}

const quotationDraftCreateItemSchema = z
  .object({
    ...quotationDraftItemFields,
    tiers: z.array(quotationDraftTierSchema).default([]),
  })
  .strict()

const quotationDraftReplaceItemSchema = z
  .object({
    ...quotationDraftItemFields,
    tiers: z.array(quotationDraftTierSchema),
  })
  .strict()

const quotationDraftHeadFields = {
  companyId: z.string().uuid(),
  quotationNo: z.string().nullable().optional(),
  quotationDate: dateOnlySchema.nullable().optional(),
  validUntil: dateOnlySchema,
  partyType: z.string().min(1),
  partyId: z.string().uuid(),
  currencyId: z.string().uuid().nullable().optional(),
  terms: z.string().nullable().optional(),
  remarks: z.string().nullable().optional(),
}

const quotationDraftCreateSchema = z
  .object({
    ...quotationDraftHeadFields,
    // 兼容仍只创建空表头的领域调用；聚合抽屉始终显式发送完整 items。
    items: z.array(quotationDraftCreateItemSchema).default([]),
  })
  .strict()

// PUT 是全量替换：顶层 items 与每个条目的 tiers 必须显式提交。
const quotationDraftReplaceSchema = z
  .object({
    ...quotationDraftHeadFields,
    items: z.array(quotationDraftReplaceItemSchema),
  })
  .strict()

function quotationDraftValidationHook(result: {
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

export function quotationHeadRoutes(deps: {
  auth: AuthService
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, quotations, side } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await quotations.listHeads(c.get('actor'), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      zValidator('json', quotationDraftCreateSchema, quotationDraftValidationHook),
      async (c) => {
        const item = await quotations.createDraft(c.get('actor'), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id/draft',
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(
          await quotations.getDraft(c.get('actor'), side, c.req.valid('param').id),
        ),
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .put(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator('json', quotationDraftReplaceSchema, quotationDraftValidationHook),
      async (c) =>
        c.json(
          await quotations.replaceDraft(
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
            quotationNo: z.string().optional(),
            quotationDate: z.string().optional(),
            validUntil: z.string().optional(),
            partyType: z.string().optional(),
            partyId: z.string().uuid().optional(),
            currencyId: z.string().uuid().optional(),
            terms: z.string().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await quotations.updateHead(c.get('actor'), side, c.req.valid('param').id, {
          ...body,
          termsPresent: presentKey(raw, 'terms'),
          remarksPresent: presentKey(raw, 'remarks'),
        })
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteHead(c.get('actor'), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.auditHead(c.get('actor'), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/void',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.voidHead(c.get('actor'), side, c.req.valid('param').id)),
    )
}

export function quotationItemRoutes(deps: {
  auth: AuthService
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, quotations, side } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await quotations.listItems(c.get('actor'), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            quotationId: z.string().uuid(),
            idx: z.number().int(),
            materialId: z.string().uuid(),
            unitId: z.string().uuid(),
            pricingMode: z.string().optional(),
            price: z.string().nullable().optional(),
            taxRate: z.string().nullable().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await quotations.createItem(c.get('actor'), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getItem(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            idx: z.number().int().optional(),
            materialId: z.string().uuid().optional(),
            unitId: z.string().uuid().optional(),
            pricingMode: z.string().optional(),
            price: z.string().nullable().optional(),
            taxRate: z.string().optional(),
            remarks: z.string().nullable().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const item = await quotations.updateItem(c.get('actor'), side, c.req.valid('param').id, {
          ...body,
          pricePresent: presentKey(raw, 'price'),
          remarksPresent: presentKey(raw, 'remarks'),
        })
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteItem(c.get('actor'), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function quotationTierRoutes(deps: {
  auth: AuthService
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, quotations, side } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await quotations.listTiers(c.get('actor'), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      zValidator(
        'json',
        z
          .object({
            itemId: z.string().uuid(),
            minQty: z.string().min(1),
            price: z.string().min(1),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await quotations.createTier(c.get('actor'), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getTier(c.get('actor'), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      zValidator('param', idParam, validationHook),
      zValidator(
        'json',
        z
          .object({
            minQty: z.string().optional(),
            price: z.string().optional(),
          })
          .strict(),
        validationHook,
      ),
      async (c) => {
        const item = await quotations.updateTier(
          c.get('actor'),
          side,
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteTier(c.get('actor'), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}
