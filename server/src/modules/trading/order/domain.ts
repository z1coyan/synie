/**
 * 订单领域不变量：头/条目形状、条目派生、审核报价复核、作废下游闸、采购占量。
 * 供 service 装配钩子调用；报错文案字节冻结。
 */
import { decimal, type Decimal } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'
import { recomputeDemandItemProjections } from '~/modules/manufacturing/arrangement.ts'
import { ApiError } from '~/platform/http/errors.ts'
import {
  asDate,
  asOptionalString,
  convertToBaseQty,
  guardCustomerMaterial,
  guardMaterialType,
  ident,
  loadMaterialSnap,
  lowerParty,
  runeLen,
  toDateOnly,
  type TradingSide,
  upperStatus,
  wireRequiredDecimal,
} from '../common.ts'
import type { QuotationService } from '../quotation/service.ts'
import { deriveItemAmounts } from './amounts.ts'
import type { OrderDraftInput } from './types.ts'
import { orderSpec, type OrderSideSpec } from './spec.ts'

export const ORDER_WRITE_ERRORS = [
  { code: '23505', constraint: 'order_unique_order_no', message: '订单号已存在' },
  { code: '23505', message: '订单数据已存在' },
  { code: '23503', message: '订单数据已被业务引用,不可删除' },
] as const

export function validateOrderShape(
  spec: OrderSideSpec,
  v: {
    orderNo: string
    orderDate: string
    orderType: string
    partyType: string
    partyId: string
    companyId: string
    currencyId: string
    exchangeRate: Decimal
    remarks: string | null
    requireOrderNo?: boolean
  },
): void {
  const fields: Record<string, string[]> = {}
  const requireNo = v.requireOrderNo !== false
  if (requireNo) {
    if (!v.orderNo.trim() || runeLen(v.orderNo) > 32) {
      fields.orderNo = ['不能为空且最多 32 个字符']
    }
  } else if (v.orderNo && v.orderNo !== 'x' && runeLen(v.orderNo) > 32) {
    fields.orderNo = ['不能为空且最多 32 个字符']
  }
  if (!v.orderDate) fields.orderDate = ['必填']
  const ot = v.orderType.toUpperCase()
  if (ot !== 'REGULAR' && ot !== spec.nonRegularType) fields.orderType = ['订单类型不合法']
  if (!spec.allowedParty.has(lowerParty(v.partyType))) fields.partyType = ['对手类型不合法']
  if (!v.partyId) fields.partyId = ['必填']
  if (!v.companyId) fields.companyId = ['必填']
  if (!v.currencyId) fields.currencyId = ['必填']
  if (lowerParty(v.partyType) === 'company' && v.partyId === v.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!v.exchangeRate.gt(0)) fields.exchangeRate = ['必须大于 0']
  if (v.remarks && runeLen(v.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

export async function normalizeCurrency(
  db: DbHandle,
  companyId: string,
  currencyId: string | null,
  exchangeRate: string | null,
): Promise<{ currencyId: string; exchangeRate: Decimal }> {
  const company = await db
    .selectFrom('bas_company')
    .select('base_currency_id')
    .where('id', '=', companyId)
    .executeTakeFirst()
  if (!company) {
    throw ApiError.validation('订单参数不合法', { companyId: ['公司不存在'] })
  }
  const chosen = currencyId ?? company.base_currency_id
  if (chosen === company.base_currency_id) {
    return { currencyId: chosen, exchangeRate: decimal(1) }
  }
  if (exchangeRate === null || exchangeRate === undefined || exchangeRate === '') {
    throw ApiError.validation('订单参数不合法', { exchangeRate: ['外币订单必须填写汇率'] })
  }
  const rate = decimal(exchangeRate)
  if (!rate.gt(0)) {
    throw ApiError.validation('订单参数不合法', { exchangeRate: ['必须大于 0'] })
  }
  return { currencyId: chosen, exchangeRate: rate }
}

export interface DerivedItem {
  idx: number
  qty: Decimal
  baseQty: Decimal
  price: Decimal
  amount: Decimal
  basePrice: Decimal
  baseAmount: Decimal
  taxRate: Decimal
  materialId: string
  unitId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  remarks: string | null
  quotationItemId: string | null
  bomId: string | null
  demandLineId: string | null
  demandDate: string | null
}

/**
 * 条目派生：parent 为头 wire 形（camelCase；枚举大写）。
 * taxExplicit=false 时常规订单税率取自报价套档。
 */
export async function deriveAndValidateItem(
  db: DbHandle,
  quotations: QuotationService,
  spec: OrderSideSpec,
  parent: Record<string, unknown>,
  draft: {
    idx: number
    qty: Decimal
    materialId: string
    unitId: string
    price: Decimal
    taxRate: Decimal
    taxExplicit: boolean
    remarks: string | null
    quotationItemId: string | null
    bomId: string | null
    demandLineId: string | null
    demandDate: string | null
  },
): Promise<DerivedItem> {
  const fields: Record<string, string[]> = {}
  if (!draft.qty.gt(0)) fields.qty = ['必须大于 0']
  if (draft.remarks && runeLen(draft.remarks) > 512) fields.remarks = ['最多 512 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('订单条目参数不合法', fields)
  }
  let materialId = draft.materialId
  let unitId = draft.unitId
  let price = draft.price
  let taxRate = draft.taxRate
  const orderType = String(parent.orderType ?? parent.order_type ?? '').toLowerCase()
  const orderDate = asDate(parent.orderDate ?? parent.order_date)
  const companyId = String(parent.companyId ?? parent.company_id)
  const partyType = String(parent.partyType ?? parent.party_type)
  const partyId = String(parent.partyId ?? parent.party_id)
  const currencyId = String(parent.currencyId ?? parent.currency_id)
  const exchangeRate = String(parent.exchangeRate ?? parent.exchange_rate ?? '1')
  const isOutsourced = Boolean(parent.isOutsourced ?? parent.is_outsourced ?? false)

  if (orderType === 'regular') {
    if (!draft.quotationItemId) {
      throw ApiError.validation('订单条目参数不合法', {
        quotationItemId: ['常规订单条目必须选择报价条目'],
      })
    }
    const resolved = await quotations.resolveForOrder(db, spec.side, {
      quotationItemId: draft.quotationItemId,
      orderDate,
      companyId,
      partyType,
      partyId,
      currencyId,
      qty: draft.qty,
    })
    materialId = resolved.materialId
    unitId = resolved.unitId
    price = resolved.price
    if (!draft.taxExplicit) taxRate = resolved.taxRate
  } else {
    if (draft.quotationItemId) {
      throw ApiError.validation('订单条目参数不合法', {
        quotationItemId: ['非常规订单不得选择报价条目'],
      })
    }
    const maxRows = await sql<{ m: string }>`
      SELECT ${sql.raw(spec.nonRegularSetting)}::text AS m FROM sal_setting LIMIT 1
    `.execute(db)
    const maximum = decimal(maxRows.rows[0]?.m ?? '100')
    if (draft.qty.gt(maximum)) {
      throw ApiError.validation('订单条目参数不合法', {
        qty: ['超过非常规订单单行数量上限'],
      })
    }
  }
  if (!materialId) fields.materialId = ['必填']
  if (!unitId) fields.unitId = ['必填']
  if (price.isNegative()) fields.price = ['不能小于 0']
  if (taxRate.isNegative() || taxRate.gte(1)) fields.taxRate = ['必须在 0(含)与 1 之间']
  if (spec.side === 'sales' && (draft.bomId || draft.demandLineId || draft.demandDate)) {
    fields.orderItem = ['销售订单条目不支持采购扩展字段']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('订单条目参数不合法', fields)
  }
  const snap = await loadMaterialSnap(db, materialId, unitId)
  guardCustomerMaterial(spec.side, partyType, partyId, snap)
  if (spec.side === 'sales') {
    guardMaterialType(snap, ['STOCK', 'VIRTUAL'], '订单条目')
  } else if (isOutsourced) {
    guardMaterialType(snap, ['STOCK'], '委外订单条目')
  }
  if (spec.side === 'purchase' && draft.bomId) {
    const bom = await sql<{ material_id: string }>`
      SELECT material_id FROM mfg_bom WHERE id=${draft.bomId}::uuid
    `.execute(db)
    if (!bom.rows[0]) {
      throw ApiError.validation('订单条目参数不合法', { bomId: ['BOM 不存在'] })
    }
    if (bom.rows[0].material_id !== materialId) {
      throw ApiError.validation('订单条目参数不合法', {
        bomId: ['BOM 必须是条目物料自身的 BOM'],
      })
    }
  }
  const baseQty = convertToBaseQty(draft.qty, unitId, snap)
  const amounts = deriveItemAmounts(draft.qty, price, exchangeRate)
  return {
    idx: draft.idx,
    qty: draft.qty,
    baseQty,
    price,
    amount: amounts.amount,
    basePrice: amounts.basePrice,
    baseAmount: amounts.baseAmount,
    taxRate,
    materialId,
    unitId,
    materialCode: snap.code,
    materialName: snap.name,
    materialSpec: snap.spec,
    customerPartNo: snap.customerPartNo,
    unitName: snap.unitName,
    remarks: draft.remarks,
    quotationItemId: draft.quotationItemId,
    bomId: draft.bomId,
    demandLineId: draft.demandLineId,
    demandDate: draft.demandDate ? toDateOnly(draft.demandDate) : null,
  }
}

/** 审核 effect：常规订单报价复核 / 非常规数量上限 */
export async function verifyItems(
  db: DbHandle,
  quotations: QuotationService,
  spec: OrderSideSpec,
  parent: Record<string, unknown>,
): Promise<void> {
  const orderId = String(parent.id)
  const rows = await sql<{
    id: string
    idx: number
    qty: string
    material_id: string
    unit_id: string
    price: string
    quotation_item_id: string | null
  }>`
    SELECT id, idx, qty::text AS qty, material_id, unit_id, price::text AS price, quotation_item_id
    FROM ${ident(spec.itemTable)} WHERE order_id=${orderId}::uuid ORDER BY idx, id
  `.execute(db)
  if (rows.rows.length === 0) {
    throw new ApiError('conflict', '订单至少需要一条条目')
  }
  const orderType = String(parent.orderType ?? parent.order_type ?? '').toLowerCase()
  const orderDate = asDate(parent.orderDate ?? parent.order_date)
  const companyId = String(parent.companyId ?? parent.company_id)
  const partyType = String(parent.partyType ?? parent.party_type)
  const partyId = String(parent.partyId ?? parent.party_id)
  const currencyId = String(parent.currencyId ?? parent.currency_id)

  for (const row of rows.rows) {
    if (orderType === 'regular') {
      if (!row.quotation_item_id) {
        throw new ApiError('conflict', `第${row.idx}行:缺少报价条目`)
      }
      try {
        const resolved = await quotations.resolveForOrder(db, spec.side, {
          quotationItemId: row.quotation_item_id,
          orderDate,
          companyId,
          partyType,
          partyId,
          currencyId,
          qty: row.qty,
        })
        if (
          resolved.materialId !== row.material_id ||
          resolved.unitId !== row.unit_id ||
          !resolved.price.equals(decimal(row.price))
        ) {
          throw new ApiError('conflict', `第${row.idx}行:单价或报价派生信息与当前报价不一致`)
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'conflict') {
          const msg = err.message.startsWith('第') ? err.message : `第${row.idx}行:${err.message}`
          throw new ApiError('conflict', msg)
        }
        throw err
      }
    } else {
      if (row.quotation_item_id) {
        throw new ApiError('conflict', `第${row.idx}行:非常规订单不得引用报价条目`)
      }
      const maxRows = await sql<{ m: string }>`
        SELECT ${sql.raw(spec.nonRegularSetting)}::text AS m FROM sal_setting LIMIT 1
      `.execute(db)
      if (decimal(row.qty).gt(decimal(maxRows.rows[0]?.m ?? '100'))) {
        throw new ApiError('conflict', `第${row.idx}行:数量超过当前上限`)
      }
    }
  }
}

export async function ensureVoidable(
  db: DbHandle,
  side: TradingSide,
  orderId: string,
): Promise<void> {
  let blocked = false
  if (side === 'sales') {
    const r = await sql<{ e: boolean }>`
      SELECT EXISTS(
        SELECT 1 FROM sal_delivery_item i
        JOIN sal_delivery d ON d.id=i.delivery_id
        JOIN sal_order_item oi ON oi.id=i.order_item_id
        WHERE oi.order_id=${orderId}::uuid AND d.status IN ('draft','audited')
      ) AS e
    `.execute(db)
    blocked = Boolean(r.rows[0]?.e)
  } else {
    const r = await sql<{ e: boolean }>`
      SELECT EXISTS(
        SELECT 1 FROM pur_receipt_item i
        JOIN pur_receipt d ON d.id=i.receipt_id
        JOIN pur_order_item oi ON oi.id=i.order_item_id
        WHERE oi.order_id=${orderId}::uuid AND d.status IN ('draft','audited')
      ) AS e
    `.execute(db)
    blocked = Boolean(r.rows[0]?.e)
  }
  if (blocked) {
    throw new ApiError('conflict', '订单存在未删除或已审核的下游单据,不可作废')
  }
}

/** 采购审核占量 / 作废释放（含需求安排倒写） */
export async function adjustDemandOnAudit(
  db: DbHandle,
  orderId: string,
  occupy: boolean,
): Promise<void> {
  const head = await sql<{ is_outsourced: boolean; company_id: string }>`
    SELECT is_outsourced, company_id::text AS company_id
    FROM pur_order WHERE id=${orderId}::uuid
  `.execute(db)
  const isOut = Boolean(head.rows[0]?.is_outsourced)
  const companyId = head.rows[0]?.company_id
  const arrangementType = isOut ? 'outsource' : 'purchase'
  const rows = await sql<{
    id: string
    demand_line_id: string | null
    base_qty: string
    qty: string
  }>`
    SELECT id::text AS id, demand_line_id::text AS demand_line_id,
      base_qty::text AS base_qty, qty::text AS qty
    FROM pur_order_item WHERE order_id=${orderId}::uuid AND demand_line_id IS NOT NULL
  `.execute(db)
  const touched = new Set<string>()
  for (const row of rows.rows) {
    if (!row.demand_line_id || !companyId) continue
    const delta = occupy ? decimal(row.base_qty) : decimal(row.base_qty).neg()
    await sql`
      UPDATE mfg_demand_item
      SET ordered_qty = ordered_qty + ${wireRequiredDecimal(delta)},
          updated_at=(now() AT TIME ZONE 'utc')
      WHERE id=${row.demand_line_id}::uuid
    `.execute(db)
    if (occupy) {
      const cap = await sql<{
        base_qty: string
        arranged_qty: string
        ratio: string
      }>`
        SELECT di.base_qty::text AS base_qty, di.arranged_qty::text AS arranged_qty,
          s.demand_overorder_ratio::text AS ratio
        FROM mfg_demand_item di
        CROSS JOIN sal_setting s
        WHERE di.id=${row.demand_line_id}::uuid
        FOR UPDATE OF di
      `.execute(db)
      const c = cap.rows[0]
      if (c) {
        const max = decimal(c.base_qty).mul(decimal(1).add(decimal(c.ratio)))
        const nextArranged = decimal(c.arranged_qty).add(decimal(row.base_qty))
        if (nextArranged.gt(max)) {
          throw new ApiError('conflict', '已安排数量超过需求超安排比例允许上限')
        }
      }
      await sql`
        INSERT INTO mfg_demand_arrangement(
          demand_item_id, company_id, arrangement_type, qty, base_qty, purchase_order_item_id
        ) VALUES (
          ${row.demand_line_id}::uuid, ${companyId}::uuid, ${arrangementType},
          ${wireRequiredDecimal(row.qty)}, ${wireRequiredDecimal(row.base_qty)}, ${row.id}::uuid
        )
      `.execute(db)
    } else {
      await sql`
        DELETE FROM mfg_demand_arrangement
        WHERE purchase_order_item_id=${row.id}::uuid
      `.execute(db)
    }
    touched.add(row.demand_line_id)
  }
  for (const lineId of [...touched].sort()) {
    await recomputeDemandItemProjections(db, lineId)
  }
}

export function validateSalesOrderDraftHasNoOutsourcedLines(
  side: TradingSide,
  input: OrderDraftInput,
): void {
  if (side !== 'sales') return
  const fields: Record<string, string[]> = {}
  input.items.forEach((item, index) => {
    if (item.issueLines.length > 0) {
      fields[`items[${index}].issueLines`] = ['销售订单不支持委外发料清单']
    }
    if (item.byproductLines.length > 0) {
      fields[`items[${index}].byproductLines`] = ['销售订单不支持委外副产物清单']
    }
  })
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('订单草稿参数不合法', fields)
  }
}

export function validateNewOrderDraftIdentities(
  side: TradingSide,
  input: OrderDraftInput,
): void {
  validateSalesOrderDraftHasNoOutsourcedLines(side, input)
  const fields: Record<string, string[]> = {}
  input.items.forEach((item, itemIndex) => {
    if (item.id !== undefined) {
      fields[`items[${itemIndex}].id`] = ['新记录不能包含 id']
    }
    for (const [name, lines] of [
      ['issueLines', item.issueLines],
      ['byproductLines', item.byproductLines],
    ] as const) {
      lines.forEach((line, lineIndex) => {
        if (line.id !== undefined) {
          fields[`items[${itemIndex}].${name}[${lineIndex}].id`] = ['新记录不能包含 id']
        }
      })
    }
  })
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('订单草稿参数不合法', fields)
  }
}

export function validateOrderDraftIdentities(
  input: OrderDraftInput,
  existingItems: ReadonlySet<string>,
  issueLineOwner: ReadonlyMap<string, string>,
  byproductLineOwner: ReadonlyMap<string, string>,
): void {
  const fields: Record<string, string[]> = {}
  const seenItems = new Set<string>()
  const seenIssueLines = new Set<string>()
  const seenByproductLines = new Set<string>()
  input.items.forEach((item, itemIndex) => {
    if (item.id !== undefined) {
      const field = `items[${itemIndex}].id`
      if (seenItems.has(item.id)) fields[field] = ['同一草稿中不能重复']
      else if (!existingItems.has(item.id)) fields[field] = ['不属于该订单']
      seenItems.add(item.id)
    }
    for (const [name, lines, owner, seen] of [
      ['issueLines', item.issueLines, issueLineOwner, seenIssueLines],
      ['byproductLines', item.byproductLines, byproductLineOwner, seenByproductLines],
    ] as const) {
      lines.forEach((line, lineIndex) => {
        if (line.id === undefined) return
        const field = `items[${itemIndex}].${name}[${lineIndex}].id`
        if (seen.has(line.id)) fields[field] = ['同一草稿中不能重复']
        else if (item.id === undefined || owner.get(line.id) !== item.id) {
          fields[field] = ['不属于该订单条目']
        }
        seen.add(line.id)
      })
    }
  })
  if (Object.keys(fields).length > 0) {
    // 有意收敛：与报价/入库一致用「参数不合法」；委外行身份仍保留「不属于该订单条目」字段文案
    throw ApiError.validation('订单草稿参数不合法', fields)
  }
}

export function groupDraftLinesByItem<T extends { orderItemId: string }>(
  lines: T[],
): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const line of lines) {
    const itemId = String(line.orderItemId)
    result.set(itemId, [...(result.get(itemId) ?? []), line])
  }
  return result
}

export function orderSpecOf(side: TradingSide): OrderSideSpec {
  return orderSpec(side)
}

/** 订单收发货历史（销售读发货；采购读入库） */
export async function loadOrderHistory(
  db: DbHandle,
  side: TradingSide,
  orderId: string,
): Promise<{
  results: Array<{
    flowType: string
    documentNo: string
    documentDate: string
    status: string
    companyId: string
    orderId: string
    orderItemId: string
    materialCode: string
    materialName: string
    materialSpec: string | null
    customerPartNo: string | null
    unitName: string
    quantity: string
  }>
}> {
  if (side === 'sales') {
    const rows = await sql<Record<string, unknown>>`
      SELECT 'sales.delivery' AS flow_type, d.delivery_no AS document_no, d.delivery_date AS document_date,
        d.status, di.company_id, oi.order_id, di.order_item_id, di.material_code, di.material_name,
        di.material_spec, di.customer_part_no, di.unit_name, di.qty AS quantity
      FROM sal_delivery_item di
      JOIN sal_delivery d ON d.id=di.delivery_id
      JOIN sal_order_item oi ON oi.id=di.order_item_id
      WHERE oi.order_id=${orderId}::uuid
      ORDER BY d.delivery_date DESC, di.idx, di.id
    `.execute(db)
    return {
      results: rows.rows.map((r) => ({
        flowType: String(r.flow_type),
        documentNo: String(r.document_no),
        documentDate: asDate(r.document_date),
        status: upperStatus(String(r.status)),
        companyId: String(r.company_id),
        orderId: String(r.order_id),
        orderItemId: String(r.order_item_id),
        materialCode: String(r.material_code),
        materialName: String(r.material_name),
        materialSpec: asOptionalString(r.material_spec),
        customerPartNo: asOptionalString(r.customer_part_no),
        unitName: String(r.unit_name),
        quantity: wireRequiredDecimal(String(r.quantity)),
      })),
    }
  }
  const rows = await sql<Record<string, unknown>>`
    SELECT 'purchase.receipt' AS flow_type, d.receipt_no AS document_no, d.receipt_date AS document_date,
      d.status, di.company_id, oi.order_id, di.order_item_id, di.material_code, di.material_name,
      di.material_spec, di.customer_part_no, di.unit_name, di.qty AS quantity
    FROM pur_receipt_item di
    JOIN pur_receipt d ON d.id=di.receipt_id
    JOIN pur_order_item oi ON oi.id=di.order_item_id
    WHERE oi.order_id=${orderId}::uuid
    ORDER BY d.receipt_date DESC, di.idx, di.id
  `.execute(db)
  return {
    results: rows.rows.map((r) => ({
      flowType: String(r.flow_type),
      documentNo: String(r.document_no),
      documentDate: asDate(r.document_date),
      status: upperStatus(String(r.status)),
      companyId: String(r.company_id),
      orderId: String(r.order_id),
      orderItemId: String(r.order_item_id),
      materialCode: String(r.material_code),
      materialName: String(r.material_name),
      materialSpec: asOptionalString(r.material_spec),
      customerPartNo: asOptionalString(r.customer_part_no),
      unitName: String(r.unit_name),
      quantity: wireRequiredDecimal(String(r.quantity)),
    })),
  }
}
