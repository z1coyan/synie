/**
 * 销售/采购报价 REST：头/条目/价格档三组路由（双边由 side 装配）。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后、zValidator 之前），handler 用 `permitOf(c)` 取凭证。
 * 资源名从 spec 取（不写字面量），动作码唯一事实源是 meta 的 actions——
 * 条目/价格档是 via 子资源，其 create/update/delete 由 guard 解析到母资源（报价头）的动作码。
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
import { dateOnlySchema, decimalStringSchema, listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import type { TradingSide } from '../common.ts'
import { presentKey } from '../common.ts'
import { quotationSpec } from './spec.ts'
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
  authz: AuthzEnforcer
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, authz, quotations, side } = deps
  const resource = quotationSpec(side).headResource
  const headGuard = (action: string) => authz.guard(resource, action)
  const prefix = authz.targetOf(resource).prefix
  /**
   * 整单 PUT 是聚合写：子树差异可能新增/删除条目与档位，
   * 故在 update 之外叠加同前缀的 create/delete（旧实现按差异在服务层动态判定并抛 403）。
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
        const result = await quotations.listHeads(permitOf(c), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      headGuard('create'),
      zValidator('json', quotationDraftCreateSchema, quotationDraftValidationHook),
      async (c) => {
        const item = await quotations.createDraft(permitOf(c), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id/draft',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(
          await quotations.getDraft(permitOf(c), side, c.req.valid('param').id),
        ),
    )
    .get(
      '/:id',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .put(
      '/:id',
      replaceGuard,
      zValidator('param', idParam, validationHook),
      zValidator('json', quotationDraftReplaceSchema, quotationDraftValidationHook),
      async (c) =>
        c.json(
          await quotations.replaceDraft(
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
        const item = await quotations.updateHead(permitOf(c), side, c.req.valid('param').id, {
          ...body,
          termsPresent: presentKey(raw, 'terms'),
          remarksPresent: presentKey(raw, 'remarks'),
        })
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      headGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteHead(permitOf(c), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      headGuard('audit'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.auditHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/void',
      headGuard('void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.voidHead(permitOf(c), side, c.req.valid('param').id)),
    )
}

export function quotationItemRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, authz, quotations, side } = deps
  const itemGuard = (action: string) => authz.guard(quotationSpec(side).itemResource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      itemGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await quotations.listItems(permitOf(c), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      itemGuard('create'),
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
        const item = await quotations.createItem(permitOf(c), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id',
      itemGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getItem(permitOf(c), side, c.req.valid('param').id)),
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
        const item = await quotations.updateItem(permitOf(c), side, c.req.valid('param').id, {
          ...body,
          pricePresent: presentKey(raw, 'price'),
          remarksPresent: presentKey(raw, 'remarks'),
        })
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      itemGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteItem(permitOf(c), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}

export function quotationTierRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  quotations: QuotationService
  side: TradingSide
}) {
  const { auth, authz, quotations, side } = deps
  const tierGuard = (action: string) => authz.guard(quotationSpec(side).tierResource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      tierGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const result = await quotations.listTiers(permitOf(c), side, toList(c.req.valid('json')))
        return c.json({ count: result.count, results: result.results })
      },
    )
    .post(
      '/',
      tierGuard('create'),
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
        const item = await quotations.createTier(permitOf(c), side, c.req.valid('json'))
        return c.json(item, 201)
      },
    )
    .get(
      '/:id',
      tierGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await quotations.getTier(permitOf(c), side, c.req.valid('param').id)),
    )
    .patch(
      '/:id',
      tierGuard('update'),
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
          permitOf(c),
          side,
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.json(item)
      },
    )
    .delete(
      '/:id',
      tierGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await quotations.deleteTier(permitOf(c), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
}
