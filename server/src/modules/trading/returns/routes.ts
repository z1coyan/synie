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
  draftValidationHook,
  listQuerySchema,
  toListQuery,
  validationHook,
} from '~/platform/http/zod.ts'
import { aggregateReplaceGuard, idParam } from '~/platform/standard/routes.ts'
import { deriveDraftObject, deriveDraftSchemas } from '~/platform/standard/wire.ts'
import type { ReturnsService } from './service.ts'
import { returnHeadMeta, returnItemMeta, returnSpec, type ReturnKind } from './spec.ts'

export interface ReturnsRouteDeps {
  auth: AuthService
  authz: AuthzEnforcer
  returns: ReturnsService
}

// 草稿 zod 自 meta 派生（类型/格式约束唯一事实源）；三侧共享金额单 meta 键集，
// 条目来源锚点并集与 readonly 编号手填为草稿专属字面量，enum 放宽 string 为逐字段补丁。
const DRAFT_HEAD_META = returnHeadMeta('sales')
const DRAFT_ITEM_META = returnItemMeta('sales')

export const draftItemSchema = deriveDraftObject(DRAFT_ITEM_META, [
  ['id', z.string().uuid().optional()],
  'idx',
  'qty',
  // 源单行锚点（销售=发货 / 采购=入库 / 委外=委外入库条目）；留空即手工行
  ['deliveryItemId', { nullable: true }],
  ['receiptItemId', z.string().uuid().nullable().optional()],
  ['outsourcedReceiptItemId', z.string().uuid().nullable().optional()],
  ['materialId', { nullable: true }],
  ['orderPrice', { nullable: true }],
  ['orderTaxRate', { nullable: true }],
  ['unitId', { nullable: true }],
  ['warehouseId', { nullable: true, optional: false }],
  ['remarks', { nullable: true }],
])

const draftSchemas = deriveDraftSchemas(
  DRAFT_HEAD_META,
  [
    'companyId',
    ['returnNo', z.string().nullable().optional()],
    ['returnDate', { nullable: true, optional: true }],
    ['postingDate', { nullable: true }],
    ['partyType', { schema: z.string().min(1) }],
    'partyId',
    ['currencyId', { nullable: true }],
    ['exchangeRate', { nullable: true }],
    ['remarks', { nullable: true }],
    ['warehouseId', { nullable: true }],
    ['debitAccountId', { nullable: true, optional: true }],
    ['creditAccountId', { nullable: true, optional: true }],
  ],
  {
    items: {
      create: z.array(draftItemSchema).default([]),
      replace: z.array(draftItemSchema),
    },
  },
)

export const draftCreateSchema = draftSchemas.create
export const draftReplaceSchema = draftSchemas.replace

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
    debitAccountId: body.debitAccountId ?? null,
    creditAccountId: body.creditAccountId ?? null,
    items: body.items,
  }
}

export function returnHeadRoutes(deps: ReturnsRouteDeps & { side: ReturnKind }) {
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

/** 销售退货头路由：基线路由 + 「生成补货需求单」（同一链式装配，ApiType 推导完整） */
export function salesReturnHeadRoutes(deps: ReturnsRouteDeps) {
  const { auth, authz, returns } = deps
  const RESOURCE = returnSpec('sales').headResource
  return returnHeadRoutes({ ...deps, side: 'sales' }).post(
    '/:id/generate-replenishment',
    authz.guard(RESOURCE, 'read', {
      allOf: [`${authz.targetOf('mfgDemands').prefix}:create`],
    }),
    zValidator('param', idParam, validationHook),
    async (c) => c.json(await returns.generateReplenishment(permitOf(c), c.req.valid('param').id)),
  )
}

export function returnItemRoutes(deps: ReturnsRouteDeps & { side: ReturnKind }) {
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
