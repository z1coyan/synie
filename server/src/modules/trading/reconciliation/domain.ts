/**
 * 对账单领域：校验、来源快照、占量投影、待办、赠样总账。
 * 跨资源效果（投影/待办/GL/发票互锁）由 workflow effect 与 invoice 接缝调用。
 */
import { decimal, roundAmount, roundBaseQty } from '@synie/shared'
import { sql } from 'kysely'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'
import type { GlEngine } from '~/engines/gl/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { accountCurrencies } from '~/platform/posting/account-currency.ts'
import { adjustReconciledProjection } from '~/platform/posting/controlled-projection.ts'
import {
  asDate,
  ident,
  lowerParty,
  partyExists,
  runeLen,
  type TradingSide,
  wireRequiredDecimal,
} from '../common.ts'
import {
  reconciliationSpec,
  type ReconciliationKind,
  type ReconciliationSideSpec,
} from './spec.ts'

export const RECON_WRITE_ERRORS = [
  { code: '23505', message: '对账单号已存在' },
] as const

export interface SourceItem {
  id: string
  companyId: string
  partyType: string
  partyId: string
  status: string
  no: string
  sourceDate: string
  materialName: string
  unitName: string
  currencyCode: string
  qty: ReturnType<typeof decimal>
  baseQty: ReturnType<typeof decimal>
  reconciledQty: ReturnType<typeof decimal>
  price: ReturnType<typeof decimal>
  exchangeRate: ReturnType<typeof decimal>
  orderType: string
  orderId: string
  outsourced: boolean
  /** 销售退货条目来源：行金额/本币金额取负（数量仍为正，同池净额） */
  isReturn: boolean
}

export function parseKind(value: string): ReconciliationKind {
  const v = value.trim().toLowerCase()
  if (v === 'regular' || v === 'gift_sample') return v
  throw ApiError.validation('对账类型不合法', {
    reconciliationType: ['只允许 REGULAR 或 GIFT_SAMPLE'],
  })
}

export function validateHeadShape(
  spec: ReconciliationSideSpec,
  input: {
    companyId: string
    no?: string | null
    kind: string
    partyType: string
    partyId: string
    debitAccountId: string
    creditAccountId: string
    remarks?: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (!input.companyId) fields.companyId = ['必填']
  if (input.kind !== 'regular' && input.kind !== 'gift_sample') {
    fields.reconciliationType = ['只允许 REGULAR 或 GIFT_SAMPLE']
  }
  const partyType = lowerParty(input.partyType)
  if (partyType !== spec.party && partyType !== 'company') {
    fields.partyType = ['对手类型不合法']
  }
  if (!input.partyId) fields.partyId = ['必填']
  if (partyType === 'company' && input.partyId === input.companyId) {
    fields.partyId = ['对手不能是本公司']
  }
  if (!input.debitAccountId) fields.debitAccountId = ['必填']
  if (!input.creditAccountId) fields.creditAccountId = ['必填']
  if (input.no != null && runeLen(String(input.no).trim()) > 32) {
    fields.reconciliationNo = ['最多 32 个字符']
  }
  if (input.remarks != null && runeLen(input.remarks) > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${spec.label}参数不合法`, fields)
  }
}

export async function fillDefaultAccounts(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  companyId: string,
  debitAccountId: string,
  creditAccountId: string,
): Promise<{ debitAccountId: string; creditAccountId: string }> {
  if (debitAccountId && creditAccountId) {
    return { debitAccountId, creditAccountId }
  }
  const debitCol =
    spec.side === 'sales' ? 'delivery_credit_account_id' : 'receipt_credit_account_id'
  const creditCol =
    spec.side === 'sales' ? 'delivery_debit_account_id' : 'receipt_debit_account_id'
  const rows = await sql<Record<string, string | null>>`
    SELECT ${sql.raw(debitCol)}::text AS debit, ${sql.raw(creditCol)}::text AS credit
    FROM sal_company_account_default WHERE company_id=${companyId}::uuid
  `.execute(db)
  const row = rows.rows[0]
  return {
    debitAccountId: debitAccountId || row?.debit || '',
    creditAccountId: creditAccountId || row?.credit || '',
  }
}

export async function validateReferences(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  companyId: string,
  partyType: string,
  partyId: string,
  debitId: string,
  creditId: string,
) {
  if (!(await partyExists(db, partyType, partyId))) {
    throw ApiError.validation(`${spec.label}参数不合法`, { partyId: ['对手不存在'] })
  }
  const rows = await sql<{
    id: string
    company_id: string
    is_group: boolean
    active: boolean
    role: string | null
  }>`
    SELECT id::text, company_id::text, is_group, active, role
    FROM bas_account WHERE id = ANY(${[debitId, creditId]}::uuid[])
  `.execute(db)
  const found = new Map(rows.rows.map((r) => [r.id, r]))
  for (const [field, accountId] of [
    ['debitAccountId', debitId],
    ['creditAccountId', creditId],
  ] as const) {
    const value = found.get(accountId)
    if (!value || value.company_id !== companyId || value.is_group || !value.active) {
      throw ApiError.validation(`${spec.label}参数不合法`, {
        [field]: ['科目须属于本公司、启用且非汇总'],
      })
    }
    const requiredRole =
      (field === 'creditAccountId' && spec.side === 'sales') ||
      (field === 'debitAccountId' && spec.side === 'purchase')
    const wantRole = spec.side === 'sales' ? 'unbilled_receivable' : 'unbilled_payable'
    if (requiredRole && (!value.role || value.role.toLowerCase() !== wantRole)) {
      throw ApiError.validation(`${spec.label}参数不合法`, {
        [field]: ['科目角色不符合对账要求'],
      })
    }
  }
}

export function validateItemShape(
  side: TradingSide,
  input: {
    reconciliationId?: string
    qty: string
    deliveryItemId?: string | null
    returnItemId?: string | null
    receiptItemId?: string | null
    outsourcedReceiptItemId?: string | null
    remarks?: string | null
  },
) {
  const fields: Record<string, string[]> = {}
  if (input.reconciliationId !== undefined && !input.reconciliationId) {
    fields.reconciliationId = ['必填']
  }
  const qty = decimal(input.qty || '0')
  if (!qty.gt(0)) fields.qty = ['必须大于 0']
  if (input.remarks != null && runeLen(input.remarks) > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (side === 'sales') {
    let count = 0
    if (input.deliveryItemId) count++
    if (input.returnItemId) count++
    if (count !== 1) {
      fields.source = ['发货条目与销售退货条目必须恰选一个']
    }
    if (input.receiptItemId || input.outsourcedReceiptItemId) {
      fields.source = ['销售对账不允许入库条目来源']
    }
  } else {
    let count = 0
    if (input.receiptItemId) count++
    if (input.outsourcedReceiptItemId) count++
    if (count !== 1) {
      fields.source = ['标准入库条目与委外入库条目必须恰选一个']
    }
    if (input.deliveryItemId) {
      fields.deliveryItemId = ['采购对账不允许发货条目来源']
    }
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('对账条目参数不合法', fields)
  }
}

export async function loadSource(
  db: DbHandle,
  side: TradingSide,
  input: {
    deliveryItemId?: string | null
    returnItemId?: string | null
    receiptItemId?: string | null
    outsourcedReceiptItemId?: string | null
  },
  lock: boolean,
): Promise<SourceItem> {
  const lockSql = lock ? sql` FOR UPDATE OF i` : sql``
  let rows: { rows: Record<string, unknown>[] }
  if (side === 'sales' && input.returnItemId) {
    // 销售退货条目：价税口径沿用退货条目快照（源单行=发货快照，手工行=手填价×单头汇率）；
    // 汇率：源单行取源订单汇率（经 order_item_id 桥接），手工行取退货单头汇率
    rows = await sql<Record<string, unknown>>`
      SELECT i.id::text, h.company_id::text, h.party_type, h.party_id::text, h.status,
        h.return_no AS no, h.return_date AS source_date, i.material_name, i.unit_name,
        i.order_currency_code AS currency_code, i.qty::text, i.base_qty::text,
        i.reconciled_qty::text, i.order_price::text,
        COALESCE(o.exchange_rate, h.exchange_rate, 1)::text AS exchange_rate,
        o.order_type, o.id::text AS order_id
      FROM sal_return_item i
      JOIN sal_return h ON h.id=i.return_id
      LEFT JOIN sal_order_item oi ON oi.id=i.order_item_id
      LEFT JOIN sal_order o ON o.id=oi.order_id
      WHERE i.id=${input.returnItemId}::uuid${lockSql}
    `.execute(db)
  } else if (side === 'sales') {
    rows = await sql<Record<string, unknown>>`
      SELECT i.id::text, h.company_id::text, h.party_type, h.party_id::text, h.status,
        h.delivery_no AS no, h.delivery_date AS source_date, i.material_name, i.unit_name,
        i.order_currency_code AS currency_code, i.qty::text, i.base_qty::text,
        i.reconciled_qty::text, i.order_price::text, o.exchange_rate::text,
        o.order_type, o.id::text AS order_id
      FROM sal_delivery_item i
      JOIN sal_delivery h ON h.id=i.delivery_id
      JOIN sal_order_item oi ON oi.id=i.order_item_id
      JOIN sal_order o ON o.id=oi.order_id
      WHERE i.id=${input.deliveryItemId!}::uuid${lockSql}
    `.execute(db)
  } else if (input.receiptItemId) {
    rows = await sql<Record<string, unknown>>`
      SELECT i.id::text, h.company_id::text, h.party_type, h.party_id::text, h.status,
        h.receipt_no AS no, h.receipt_date AS source_date, i.material_name, i.unit_name,
        i.order_currency_code AS currency_code, i.qty::text, i.base_qty::text,
        i.reconciled_qty::text, i.order_price::text, o.exchange_rate::text,
        o.order_type, o.id::text AS order_id
      FROM pur_receipt_item i
      JOIN pur_receipt h ON h.id=i.receipt_id
      JOIN pur_order_item oi ON oi.id=i.order_item_id
      JOIN pur_order o ON o.id=oi.order_id
      WHERE i.id=${input.receiptItemId}::uuid${lockSql}
    `.execute(db)
  } else {
    rows = await sql<Record<string, unknown>>`
      SELECT i.id::text, h.company_id::text, h.party_type, h.party_id::text, h.status,
        h.receipt_no AS no, h.receipt_date AS source_date, i.material_name, i.unit_name,
        i.order_currency_code AS currency_code, i.qty::text, i.base_qty::text,
        i.reconciled_qty::text, i.order_price::text, o.exchange_rate::text,
        o.order_type, o.id::text AS order_id
      FROM pur_outsourced_receipt_item i
      JOIN pur_outsourced_receipt h ON h.id=i.receipt_id
      JOIN pur_order_item oi ON oi.id=i.order_item_id
      JOIN pur_order o ON o.id=oi.order_id
      WHERE i.id=${input.outsourcedReceiptItemId!}::uuid${lockSql}
    `.execute(db)
  }
  const row = rows.rows[0]
  if (!row) {
    throw ApiError.validation('对账条目参数不合法', { source: ['来源条目不存在'] })
  }
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    partyType: String(row.party_type),
    partyId: String(row.party_id),
    status: String(row.status),
    no: String(row.no),
    sourceDate: asDate(row.source_date),
    materialName: String(row.material_name),
    unitName: String(row.unit_name),
    currencyCode: row.currency_code != null ? String(row.currency_code) : '',
    qty: decimal(String(row.qty)),
    baseQty: decimal(String(row.base_qty)),
    reconciledQty: decimal(String(row.reconciled_qty)),
    price: decimal(row.order_price != null ? String(row.order_price) : '0'),
    exchangeRate: decimal(String(row.exchange_rate ?? 1)),
    orderType: row.order_type != null ? String(row.order_type) : '',
    orderId: row.order_id != null ? String(row.order_id) : '',
    outsourced: side === 'purchase' && Boolean(input.outsourcedReceiptItemId),
    isReturn: side === 'sales' && Boolean(input.returnItemId),
  }
}

export async function validateSource(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  head: Record<string, unknown>,
  source: SourceItem,
  selfId: string | null,
  qty: ReturnType<typeof decimal>,
) {
  if (source.status !== 'audited') {
    throw new ApiError('conflict', '仅已审核且未作废的来源条目可对账')
  }
  const companyId = String(head.companyId ?? head.company_id)
  const partyType = lowerParty(String(head.partyType ?? head.party_type))
  const partyId = String(head.partyId ?? head.party_id)
  const headId = String(head.id)
  const kind = headKind(head)

  if (source.companyId !== companyId) {
    throw ApiError.validation('对账条目参数不合法', {
      source: ['来源公司与对账单不一致'],
    })
  }
  if (source.partyType !== partyType || source.partyId !== partyId) {
    throw ApiError.validation('对账条目参数不合法', {
      source: ['来源对手与对账单不一致'],
    })
  }
  const sibling = await sql<{ currency: string | null }>`
    SELECT CASE ${spec.side}::text
      WHEN 'sales' THEN (
        SELECT COALESCE(di.order_currency_code, ti.order_currency_code)
        FROM sal_reconciliation_item ri
        LEFT JOIN sal_delivery_item di ON di.id=ri.delivery_item_id
        LEFT JOIN sal_return_item ti ON ti.id=ri.return_item_id
        WHERE ri.reconciliation_id=${headId}::uuid
          AND (${selfId}::uuid IS NULL OR ri.id<>${selfId}::uuid)
        LIMIT 1
      )
      ELSE (
        SELECT COALESCE(si.order_currency_code, oi.order_currency_code)
        FROM pur_reconciliation_item ri
        LEFT JOIN pur_receipt_item si ON si.id=ri.receipt_item_id
        LEFT JOIN pur_outsourced_receipt_item oi ON oi.id=ri.outsourced_receipt_item_id
        WHERE ri.reconciliation_id=${headId}::uuid
          AND (${selfId}::uuid IS NULL OR ri.id<>${selfId}::uuid)
        LIMIT 1
      )
    END AS currency
  `.execute(db)
  const siblingCurrency = sibling.rows[0]?.currency
  if (siblingCurrency != null && siblingCurrency !== source.currencyCode) {
    throw ApiError.validation('对账条目参数不合法', {
      source: ['同一对账单内订单原币必须一致'],
    })
  }
  if (kind === 'regular') {
    if (!source.price.gt(0)) {
      throw ApiError.validation('对账条目参数不合法', {
        source: ['常规对账单不可勾选零金额条目'],
      })
    }
    if (spec.side === 'sales' && source.orderType === 'sample') {
      throw ApiError.validation('对账条目参数不合法', {
        source: ['常规销售对账单不可勾选样品订单来源'],
      })
    }
  }
  const snapped = snapshotAmounts(qty, source)
  const remaining = source.baseQty.sub(source.reconciledQty)
  if (decimal(snapped.baseQty).gt(remaining)) {
    throw new ApiError('conflict', `超出剩余可对账量(剩余 ${remaining.toFixed()})`)
  }
}

export function snapshotAmounts(qty: ReturnType<typeof decimal>, source: SourceItem) {
  let baseQty = qty
  if (!source.qty.isZero()) {
    baseQty = qty.mul(source.baseQty).div(source.qty)
  }
  const amount = qty.mul(source.price)
  const baseAmount = decimal(roundAmount(amount)).mul(source.exchangeRate)
  // 退货来源：行金额/本币金额取负（数量与折算数量仍为正），同池净额由头 SUM 自然得出
  const sign = source.isReturn ? decimal(-1) : decimal(1)
  return {
    baseQty: roundBaseQty(baseQty),
    amount: roundAmount(amount.mul(sign)),
    baseAmount: roundAmount(baseAmount.mul(sign)),
  }
}

export async function requireItems(db: DbHandle, spec: ReconciliationSideSpec, id: string) {
  const r = await sql<{ e: boolean }>`
    SELECT EXISTS(SELECT 1 FROM ${ident(spec.itemTable)} WHERE reconciliation_id=${id}::uuid) AS e
  `.execute(db)
  if (!r.rows[0]?.e) {
    throw new ApiError('conflict', '生效前必须至少填写一行对账条目')
  }
}

export async function adjustProjection(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  id: string,
  direction: number,
) {
  await adjustReconciledProjection(db, spec.side, id, direction)
}

export async function postGiftGL(
  db: TrxHandle,
  gl: Pick<GlEngine, 'post'>,
  spec: ReconciliationSideSpec,
  head: Record<string, unknown>,
  posting: string,
) {
  const debitAccountId = String(head.debitAccountId ?? head.debit_account_id)
  const creditAccountId = String(head.creditAccountId ?? head.credit_account_id)
  const { debit: debitCurrency, credit: creditCurrency } = await accountCurrencies(
    db,
    debitAccountId,
    creditAccountId,
  )
  const baseGross = wireRequiredDecimal(
    String(head.baseGrossTotal ?? head.base_gross_total ?? 0),
  )
  const partyType = String(head.partyType ?? head.party_type)
  const partyId = String(head.partyId ?? head.party_id)
  const debitParty =
    spec.side === 'purchase' ? { partyType, partyId } : { partyType: null, partyId: null }
  const creditParty =
    spec.side === 'sales' ? { partyType, partyId } : { partyType: null, partyId: null }
  await gl.post(
    db,
    {
      type: spec.voucher,
      id: String(head.id),
      no: String(head.reconciliationNo ?? head.reconciliation_no),
      companyId: String(head.companyId ?? head.company_id),
      postingDate: posting,
    },
    [
      {
        accountId: debitAccountId,
        currencyId: debitCurrency,
        debit: baseGross,
        credit: '0',
        partyType: debitParty.partyType,
        partyId: debitParty.partyId,
      },
      {
        accountId: creditAccountId,
        currencyId: creditCurrency,
        debit: '0',
        credit: baseGross,
        partyType: creditParty.partyType,
        partyId: creditParty.partyId,
      },
    ],
  )
}

export async function openTodo(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  head: Record<string, unknown>,
  userId: string | null,
) {
  await sql`
    INSERT INTO sys_todo(
      type, source_type, source_id, source_no, party_type, party_id, amount,
      status, source_changed_at, company_id, created_by_id
    ) VALUES (
      ${spec.todoType}, ${spec.voucher}, ${String(head.id)}::uuid,
      ${String(head.reconciliationNo ?? head.reconciliation_no)},
      ${String(head.partyType ?? head.party_type)},
      ${String(head.partyId ?? head.party_id)}::uuid,
      ${wireRequiredDecimal(String(head.baseGrossTotal ?? head.base_gross_total ?? 0))},
      'active', (now() AT TIME ZONE 'utc'),
      ${String(head.companyId ?? head.company_id)}::uuid,
      ${userId}::uuid
    )
  `.execute(db)
}

export async function closeTodos(
  db: DbHandle,
  spec: ReconciliationSideSpec,
  id: string,
  reason: string,
) {
  await sql`
    UPDATE sys_todo SET status='closed', closed_reason=${reason},
      closed_at=(now() AT TIME ZONE 'utc'), updated_at=(now() AT TIME ZONE 'utc')
    WHERE source_type=${spec.voucher} AND source_id=${id}::uuid AND status='active'
  `.execute(db)
}

/** wire/DB 均可：取对账类型小写 */
export function headKind(head: Record<string, unknown>): string {
  return String(head.reconciliationType ?? head.reconciliation_type).toLowerCase()
}

export function assertRegularAction(head: Record<string, unknown>) {
  if (headKind(head) !== 'regular') {
    throw new ApiError('conflict', '对账单当前状态不允许执行该动作')
  }
}

export function assertGiftAction(head: Record<string, unknown>, message: string) {
  if (headKind(head) !== 'gift_sample') {
    throw new ApiError('conflict', message)
  }
}

export { reconciliationSpec }
