/** 退货路由：整单草稿三连 + 审核/作废；条目子资源只读（写由整单 PUT 承担）。销售/采购对称。 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import {
  dateOnlySchema,
  decimalStringSchema,
  draftValidationHook,
  listQuerySchema,
  toListQuery,
  validationHook,
} from '~/platform/http/zod.ts'
import { idParam } from '~/platform/standard/routes.ts'
import type { TradingSide } from '../common.ts'
import type { ReturnsService } from './service.ts'
import { returnSpec } from './spec.ts'

export interface ReturnsRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  returns: ReturnsService
}

/**
 * 聚合草稿整单替换的码级门控：一次 PUT 可同时新增/修改/删除条目，
 * 故要求 `update` ∧ `create` ∧ `delete`（附加码由 prefix 拼，不写字面量）。
 */
function aggregateReplaceGuard(authz: AuthzEnforcer, headResource: string) {
  const { prefix } = authz.targetOf(headResource)
  return authz.guard(headResource, 'update', {
    allOf: [`${prefix}:create`, `${prefix}:delete`],
  })
}

const draftItemSchema = z
  .object({
    id: z.string().uuid().optional(),
    idx: z.number().int(),
    qty: decimalStringSchema,
    // 源单行锚点（销售=发货条目 / 采购=入库条目）；留空即手工行（手填物料/价税）
    deliveryItemId: z.string().uuid().nullable().optional(),
    receiptItemId: z.string().uuid().nullable().optional(),
    materialId: z.string().uuid().nullable().optional(),
    orderPrice: decimalStringSchema.nullable().optional(),
    orderTaxRate: decimalStringSchema.nullable().optional(),
    unitId: z.string().uuid().nullable().optional(),
    warehouseId: z.string().uuid().nullable(),
    remarks: z.string().nullable().optional(),
  })
  .strict()

const draftFields = {
  companyId: z.string().uuid(),
  returnNo: z.string().nullable().optional(),
  returnDate: dateOnlySchema.nullable().optional(),
  postingDate: dateOnlySchema.nullable().optional(),
  partyType: z.string().min(1),
  partyId: z.string().uuid(),
  currencyId: z.string().uuid().nullable().optional(),
  exchangeRate: decimalStringSchema.nullable().optional(),
  remarks: z.string().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  debitAccountId: z.string().uuid(),
  creditAccountId: z.string().uuid(),
}

const draftCreateSchema = z
  .object({
    ...draftFields,
    items: z.array(draftItemSchema).default([]),
  })
  .strict()

const draftReplaceSchema = z
  .object({
    ...draftFields,
    items: z.array(draftItemSchema),
  })
  .strict()

function toDraftInput(
  body: z.infer<typeof draftCreateSchema> | z.infer<typeof draftReplaceSchema>,
) {
  return {
    companyId: body.companyId,
    no: body.returnNo,
    documentDate: body.returnDate,
    postingDate: body.postingDate,
    partyType: body.partyType,
    partyId: body.partyId,
    currencyId: body.currencyId,
    exchangeRate: body.exchangeRate,
    remarks: body.remarks,
    warehouseId: body.warehouseId,
    debitAccountId: body.debitAccountId,
    creditAccountId: body.creditAccountId,
    items: body.items,
  }
}

export function returnHeadRoutes(deps: ReturnsRouteDeps & { side: TradingSide }) {
  const { auth, authz, returns, side } = deps
  const RESOURCE = returnSpec(side).headResource
  const headGuard = (action: string) => authz.guard(RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      headGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await returns.listHeads(permitOf(c), side, toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .post(
      '/',
      headGuard('create'),
      zValidator('json', draftCreateSchema, draftValidationHook(['items'])),
      async (c) =>
        c.json(
          await returns.createDraft(permitOf(c), side, toDraftInput(c.req.valid('json'))),
          201,
        ),
    )
    // 完整聚合草稿读取（无分页截断）；须在 /:id 之前注册更具体路径
    .get(
      '/:id/draft',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await returns.getDraft(permitOf(c), side, c.req.valid('param').id)),
    )
    .get(
      '/:id',
      headGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await returns.getHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .put(
      '/:id',
      aggregateReplaceGuard(authz, RESOURCE),
      zValidator('param', idParam, validationHook),
      zValidator('json', draftReplaceSchema, draftValidationHook(['items'])),
      async (c) =>
        c.json(
          await returns.replaceDraft(
            permitOf(c),
            side,
            c.req.valid('param').id,
            toDraftInput(c.req.valid('json')),
          ),
        ),
    )
    .delete(
      '/:id',
      headGuard('delete'),
      zValidator('param', idParam, validationHook),
      async (c) => {
        await returns.deleteHead(permitOf(c), side, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    .post(
      '/:id/audit',
      headGuard('audit'),
      zValidator('param', idParam, validationHook),
      async (c) =>
        c.json(await returns.auditHead(permitOf(c), side, c.req.valid('param').id)),
    )
    .post(
      '/:id/void',
      headGuard('void'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await returns.voidHead(permitOf(c), side, c.req.valid('param').id)),
    )
}

export function returnItemRoutes(deps: ReturnsRouteDeps & { side: TradingSide }) {
  const { auth, authz, returns, side } = deps
  // 聚合草稿的子资源只读：写由整单 PUT 承担
  const itemGuard = (action: string) => authz.guard(returnSpec(side).itemResource, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post(
      '/query',
      itemGuard('read'),
      zValidator('json', listQuerySchema, validationHook),
      async (c) => {
        const r = await returns.listItems(permitOf(c), side, toListQuery(c.req.valid('json')))
        return c.json({ count: r.count, results: r.results })
      },
    )
    .get(
      '/:id',
      itemGuard('read'),
      zValidator('param', idParam, validationHook),
      async (c) => c.json(await returns.getItem(permitOf(c), side, c.req.valid('param').id)),
    )
}
