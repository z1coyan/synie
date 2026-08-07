/**
 * 报价领域不变量：头/条目/价格档形状校验、审核前置、梯度→固定价清档、订单套档。
 * 供 service 装配钩子调用；报错文案字节冻结。
 */
import { decimal, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'
import { auditDestroyed, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { snapshot } from '~/platform/standard/fields.ts'
import type { StandardChildService } from '~/platform/standard/child.ts'
import {
  asDate,
  ident,
  lowerParty,
  runeLen,
  toDateOnly,
  type TradingSide,
  wireRequiredDecimal,
} from '../common.ts'
import { quotationSpec, type QuotationSideSpec } from './spec.ts'
import type { ResolveOrderInput, ResolveOrderResult } from './types.ts'

/** purge 只需 id/minQty/companyId；避免 domain↔service 环依赖 */
type TierRow = { id: string; minQty: string; companyId: string; [key: string]: unknown }

export const QUOTATION_WRITE_ERRORS = [
  { code: '23505', constraint: 'quotation_unique_quotation_no', message: '报价单号已存在' },
  {
    code: '23505',
    constraint: 'quotation_item_unique_material_unit',
    message: '同一物料与单位在本报价单已有报价行',
  },
  {
    code: '23505',
    constraint: 'quotation_tier_unique_item_min_qty',
    message: '同一起订量档已存在',
  },
  { code: '23505', message: '报价数据已存在' },
  { code: '23503', message: '报价数据已被业务引用,不可删除' },
] as const

export async function assertAuditable(
  trx: TrxHandle,
  spec: QuotationSideSpec,
  id: string,
): Promise<void> {
  const count = await sql<{ c: string }>`
    SELECT count(*)::text AS c FROM ${ident(spec.itemTable)} WHERE quotation_id=${id}::uuid
  `.execute(trx)
  if (Number(count.rows[0]?.c ?? 0) === 0) {
    throw new ApiError('conflict', '审核前必须至少填写一行条目')
  }
  const missing = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM ${ident(spec.itemTable)} i
      WHERE i.quotation_id=${id}::uuid AND i.pricing_mode='qty_tiered'
        AND NOT EXISTS(SELECT 1 FROM ${ident(spec.tierTable)} t WHERE t.item_id=i.id)
    ) AS e
  `.execute(trx)
  if (missing.rows[0]?.e) {
    throw new ApiError('conflict', '数量梯度条目必须至少填写一个价格档')
  }
}

export function validateHeadShape(
  spec: QuotationSideSpec,
  v: {
    quotationNo: string
    quotationDate: string
    validUntil: string
    partyType: string
    partyId: string
    companyId: string
    currencyId: string
    remarks: string | null
    requireQuotationNo?: boolean
    requireCurrency?: boolean
  },
): void {
  const fields: Record<string, string[]> = {}
  const requireNo = v.requireQuotationNo !== false
  if (requireNo) {
    if (!v.quotationNo || runeLen(v.quotationNo) > 32) {
      fields.quotationNo = ['不能为空且最多 32 个字符']
    }
  } else if (v.quotationNo && v.quotationNo !== 'x' && runeLen(v.quotationNo) > 32) {
    fields.quotationNo = ['不能为空且最多 32 个字符']
  }
  if (!v.quotationDate) fields.quotationDate = ['必填']
  if (!v.validUntil) fields.validUntil = ['必填']
  else if (v.quotationDate && v.validUntil < v.quotationDate) {
    fields.validUntil = ['报价截止不得早于报价日期']
  }
  if (!spec.allowedParty.has(lowerParty(v.partyType))) {
    fields.partyType =
      spec.side === 'sales'
        ? ['对手类型只能为客户或内部公司']
        : ['对手类型只能为供应商或内部公司']
  }
  if (!v.partyId) fields.partyId = ['必填']
  if (!v.companyId) fields.companyId = ['必填']
  if (v.requireCurrency !== false && !v.currencyId) fields.currencyId = ['必填']
  if (lowerParty(v.partyType) === 'company' && v.partyId === v.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (v.remarks && runeLen(v.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

export function normalizeItemShape(
  modeRaw: string | undefined,
  priceRaw: string | null | undefined,
  taxRateRaw: string | null | undefined,
  materialId: string,
  unitId: string,
  remarks: string | null | undefined,
): { mode: string; price: Decimal | null; taxRate: Decimal } {
  let mode = (modeRaw ?? 'FIXED').trim().toUpperCase()
  if (!mode) mode = 'FIXED'
  let taxRate = decimal('0.13')
  if (taxRateRaw !== null && taxRateRaw !== undefined && taxRateRaw !== '') {
    taxRate = decimal(taxRateRaw)
  }
  const fields: Record<string, string[]> = {}
  let price: Decimal | null = null
  if (mode === 'FIXED') {
    if (priceRaw === null || priceRaw === undefined || priceRaw === '') {
      fields.price = ['固定价条目必须填写含税单价']
    } else {
      price = decimal(priceRaw)
      if (price.isNegative()) fields.price = ['含税单价不能为负']
    }
  } else if (mode === 'QTY_TIERED') {
    price = null
  } else {
    fields.pricingMode = ['只能为 FIXED 或 QTY_TIERED']
  }
  if (taxRate.isNegative() || taxRate.gte(1)) {
    fields.taxRate = ['税率必须在 0(含)与 1 之间']
  }
  if (!materialId) fields.materialId = ['必填']
  if (!unitId) fields.unitId = ['必填']
  if (remarks && runeLen(remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('报价条目参数不合法', fields)
  }
  return { mode, price, taxRate }
}

export function validateTierShape(minQty: Decimal, price: Decimal): void {
  const fields: Record<string, string[]> = {}
  if (!minQty.gt(0)) fields.minQty = ['起订量必须大于零']
  if (price.isNegative()) fields.price = ['含税档价不能为负']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('报价价格档参数不合法', fields)
  }
}

/** 孙级写前：母条目须为数量梯度；祖父头须为草稿（文案逐字冻结） */
export async function assertTierEditable(
  trx: TrxHandle,
  spec: QuotationSideSpec,
  itemParent: Record<string, unknown>,
): Promise<void> {
  const mode = String(itemParent.pricingMode ?? '').toLowerCase()
  if (mode !== 'qty_tiered') {
    throw ApiError.validation('报价价格档参数不合法', {
      itemId: ['仅数量梯度条目可维护价格档'],
    })
  }
  const quotationId = String(itemParent.quotationId)
  const head = await sql<{ status: string }>`
    SELECT status FROM ${ident(spec.headTable)} WHERE id=${quotationId}::uuid FOR UPDATE
  `.execute(trx)
  if (!head.rows[0]) throw new ApiError('not_found', `${spec.label}不存在`)
  if (String(head.rows[0].status).toLowerCase() !== 'draft') {
    throw new ApiError('conflict', '仅草稿报价单可编辑价格档')
  }
}

/** 定价模式由数量梯度改回固定价：清档并逐行留审计（actionName=purge） */
export async function purgeTiersForItem(
  handle: DbHandle,
  permit: Permit,
  ctx: {
    spec: QuotationSideSpec
    tierMeta: ResourceMeta
    tierAudit: readonly string[]
    tiers: StandardChildService<TierRow>
  },
  itemId: string,
): Promise<void> {
  const rows = await ctx.tiers.listByParentOn(handle, itemId)
  if (rows.length === 0) return
  await sql`DELETE FROM ${ident(ctx.spec.tierTable)} WHERE item_id=${itemId}::uuid`.execute(handle)
  for (const item of rows) {
    await writeAudit(handle, permit.actor, {
      resource: ctx.tierMeta.table,
      recordId: item.id,
      recordLabel: item.minQty,
      companyId: item.companyId,
      actionType: 'destroy',
      actionName: 'purge',
      changes: auditDestroyed(snapshot(ctx.tierMeta, item, ctx.tierAudit), ctx.tierAudit),
    })
  }
}

/** wire 形条目字段归一（钩子 validate/beforeWrite 共用） */
export function readItemWire(draft: Record<string, unknown>): {
  pricingMode: string | undefined
  price: string | null | undefined
  taxRate: string | undefined
  materialId: string
  unitId: string
  remarks: string | null | undefined
} {
  return {
    pricingMode: draft.pricingMode == null ? undefined : String(draft.pricingMode),
    price:
      draft.price === undefined
        ? undefined
        : draft.price === null
          ? null
          : String(draft.price),
    taxRate: draft.taxRate == null ? undefined : String(draft.taxRate),
    materialId: String(draft.materialId ?? ''),
    unitId: String(draft.unitId ?? ''),
    remarks:
      draft.remarks === undefined
        ? undefined
        : draft.remarks === null
          ? null
          : String(draft.remarks),
  }
}

/** 订单行套档：调用方已持订单头锁；本函数锁定报价头并校验有效期/公司/对手/币种。 */
export async function resolveForOrder(
  trx: DbHandle,
  side: TradingSide,
  input: ResolveOrderInput,
): Promise<ResolveOrderResult> {
  const spec = quotationSpec(side)
  const rows = await sql<{
    material_id: string
    unit_id: string
    pricing_mode: string
    price: string | null
    tax_rate: string
    quotation_date: string
    valid_until: string
    status: string
    company_id: string
    party_type: string
    party_id: string
    currency_id: string
  }>`
    SELECT i.material_id,i.unit_id,i.pricing_mode,i.price::text AS price,i.tax_rate::text AS tax_rate,
      q.quotation_date::text AS quotation_date,q.valid_until::text AS valid_until,q.status,
      q.company_id,q.party_type,q.party_id,q.currency_id
    FROM ${ident(spec.itemTable)} i
    JOIN ${ident(spec.headTable)} q ON q.id=i.quotation_id
    WHERE i.id=${input.quotationItemId}::uuid
    FOR UPDATE OF q
  `.execute(trx)
  const row = rows.rows[0]
  if (!row) {
    throw ApiError.validation('订单条目参数不合法', {
      quotationItemId: ['报价条目不存在'],
    })
  }
  const orderDate = toDateOnly(input.orderDate)
  if (row.status.toLowerCase() !== 'audited') {
    throw new ApiError('conflict', '报价单须为已审核状态')
  }
  const qDate = asDate(row.quotation_date)
  const vUntil = asDate(row.valid_until)
  if (orderDate < qDate || orderDate > vUntil) {
    throw new ApiError('conflict', '订单日期不在报价有效期内')
  }
  if (row.company_id !== input.companyId) {
    throw new ApiError('conflict', '报价公司与订单不一致')
  }
  if (row.party_type !== lowerParty(input.partyType) || row.party_id !== input.partyId) {
    throw new ApiError('conflict', '报价对手与订单不一致')
  }
  if (row.currency_id !== input.currencyId) {
    throw new ApiError('conflict', '报价币种与订单不一致')
  }
  const taxRate = decimal(row.tax_rate)
  const mode = row.pricing_mode.toLowerCase()
  if (mode === 'fixed') {
    if (row.price === null) throw new ApiError('conflict', '固定价报价缺少单价')
    return {
      materialId: row.material_id,
      unitId: row.unit_id,
      price: decimal(row.price),
      taxRate,
    }
  }
  if (mode === 'qty_tiered') {
    const tier = await sql<{ price: string }>`
      SELECT price::text AS price FROM ${ident(spec.tierTable)}
      WHERE item_id=${input.quotationItemId}::uuid AND min_qty <= ${wireRequiredDecimal(input.qty)}
      ORDER BY min_qty DESC LIMIT 1
    `.execute(trx)
    if (!tier.rows[0]) {
      throw new ApiError('conflict', '数量低于首档起订量,无可用报价')
    }
    return {
      materialId: row.material_id,
      unitId: row.unit_id,
      price: decimal(tier.rows[0].price),
      taxRate,
    }
  }
  throw new ApiError('conflict', '报价定价模式不合法')
}
