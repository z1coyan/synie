/**
 * 应收应付往来明细：总账余额口径不变，展示按来源单据压行、履约按条目拆。
 */
import { decimal, roundAmount } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { ident } from '~/db/ident.ts'
import { companyInPermitScope } from '~/db/load.ts'
import { toDateOnly } from '~/db/dates.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Permit } from '~/platform/authz/core/index.ts'

export type LedgerSide = 'ar' | 'ap'

export const DISPLAY_ROLES = {
  ar: ['unbilled_receivable', 'receivable'] as const,
  ap: ['unbilled_payable', 'payable', 'other_payable'] as const,
}

const DEBIT_ROLES = new Set(['unbilled_receivable', 'receivable', 'advance_paid'])

export const EXPLODE_TYPES = new Set([
  'sales.delivery',
  'sales.return',
  'purchase.receipt',
  'purchase.return',
  'purchase.outsourced_receipt',
])

const EXPLODE_SPEC: Record<
  string,
  { table: string; parentCol: string; primaryRole: string; sign: 1 | -1 }
> = {
  'sales.delivery': {
    table: 'sal_delivery_item',
    parentCol: 'delivery_id',
    primaryRole: 'unbilled_receivable',
    sign: 1,
  },
  'sales.return': {
    table: 'sal_return_item',
    parentCol: 'return_id',
    primaryRole: 'unbilled_receivable',
    sign: -1,
  },
  'purchase.receipt': {
    table: 'pur_receipt_item',
    parentCol: 'receipt_id',
    primaryRole: 'unbilled_payable',
    sign: 1,
  },
  'purchase.return': {
    table: 'pur_return_item',
    parentCol: 'return_id',
    primaryRole: 'unbilled_payable',
    sign: -1,
  },
  'purchase.outsourced_receipt': {
    table: 'pur_outsourced_receipt_item',
    parentCol: 'receipt_id',
    primaryRole: 'unbilled_payable',
    sign: 1,
  },
}

const VOUCHER_RESOURCE: Record<string, string> = {
  'sales.delivery': 'salDeliveries',
  'sales.return': 'salReturns',
  'purchase.receipt': 'purReceipts',
  'purchase.return': 'purReturns',
  'purchase.outsourced_receipt': 'purOutsourcedReceipts',
  'acc.vat_invoice': 'accVatInvoices',
  'acc.gl_journal': 'accGlJournals',
  'acc.bill_transaction': 'accBillTransactions',
  'acc.expense_report': 'accExpenseReports',
  'sales.reconciliation': 'salReconciliations',
  'purchase.reconciliation': 'purReconciliations',
}

const BILL_TYPE_LABEL: Record<string, string> = {
  RECEIVE: '承兑接收',
  ENDORSE: '承兑转让',
  DISCOUNT: '承兑贴现',
  SETTLE: '承兑兑付',
  REALLOCATE: '承兑调拨',
}

export interface PartyLedgerQuery {
  companyId: string
  asOf: string
  side: LedgerSide
  partyType?: string | null
  partyId?: string | null
  partyNil?: boolean
}

export interface PartyLedgerRow {
  id: string
  postingDate: string
  seq: number
  voucherType: string
  voucherTypeLabel: string
  voucherId: string
  voucherNo: string
  voucherResource: string | null
  isReversal: boolean
  itemId: string | null
  materialLabel: string | null
  qty: string | null
  unitLabel: string | null
  amount: string
  balances: Record<string, string>
  remarks: string | null
}

export interface PartyLedger {
  asOf: string
  side: LedgerSide
  partyType: string | null
  partyId: string | null
  rows: PartyLedgerRow[]
}

export function camelRole(role: string): string {
  return role.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

export function roleDelta(role: string, debit: string, credit: string) {
  let value = decimal(debit).minus(decimal(credit))
  if (!DEBIT_ROLES.has(role)) value = value.neg()
  return value
}

/** 本行金额：增加本侧挂账为正；开票取挂账侧价税合计，收款/冲回为负。 */
export function voucherAmount(side: LedgerSide, deltas: Record<string, ReturnType<typeof decimal>>) {
  if (side === 'ar') {
    const rec = deltas.receivable ?? decimal(0)
    const unb = deltas.unbilledReceivable ?? decimal(0)
    if (rec.gt(0)) return rec
    if (unb.gt(0)) return unb
    return rec.plus(unb)
  }
  const pay = deltas.payable ?? decimal(0)
  const other = deltas.otherPayable ?? decimal(0)
  const unb = deltas.unbilledPayable ?? decimal(0)
  if (pay.gt(0)) return pay
  if (other.gt(0)) return other
  if (unb.gt(0)) return unb
  return pay.plus(other).plus(unb)
}

export function typeLabel(input: {
  voucherType: string
  isReversal: boolean
  invoiceDirection?: string | null
  invoicePartyType?: string | null
  billTransactionType?: string | null
}): string {
  let label = baseTypeLabel(input)
  if (input.isReversal) label = `${label}（红冲）`
  return label
}

function baseTypeLabel(input: {
  voucherType: string
  invoiceDirection?: string | null
  invoicePartyType?: string | null
  billTransactionType?: string | null
}): string {
  switch (input.voucherType) {
    case 'sales.delivery':
      return '销售发货'
    case 'sales.return':
      return '销售退货'
    case 'purchase.receipt':
      return '采购入库'
    case 'purchase.return':
      return '采购退货'
    case 'purchase.outsourced_receipt':
      return '委外入库'
    case 'acc.gl_journal':
      return '手工凭证'
    case 'acc.expense_report':
      return '报销单'
    case 'sales.reconciliation':
      return '销售赠送样品对账'
    case 'purchase.reconciliation':
      return '采购赠送样品对账'
    case 'acc.vat_invoice': {
      const party = (input.invoicePartyType ?? '').toUpperCase()
      const dir = (input.invoiceDirection ?? '').toUpperCase()
      if (party === 'EMPLOYEE') return '费用报销发票'
      if (dir === 'OUTBOUND') return '发票开出'
      if (dir === 'INBOUND') return '发票开入'
      return '增值税发票'
    }
    case 'acc.bill_transaction': {
      const kind = (input.billTransactionType ?? '').toUpperCase()
      return BILL_TYPE_LABEL[kind] ?? '承兑交易'
    }
    default:
      return input.voucherType
  }
}

export interface LedgerItem {
  id: string
  idx: number
  parentId: string
  qty: string
  unitName: string | null
  materialCode: string | null
  materialName: string | null
  remarks: string | null
  lineAmount: ReturnType<typeof decimal>
}

export function lineAmountFromSnapshot(input: {
  orderBaseQty: string | null
  orderBaseAmount: string | null
  baseQty: string | null
}) {
  const orderBaseQty = decimal(input.orderBaseQty ?? 0)
  const orderBaseAmount = decimal(input.orderBaseAmount ?? 0)
  const baseQty = decimal(input.baseQty ?? 0)
  if (!orderBaseQty.isZero()) {
    return orderBaseAmount.mul(baseQty).div(orderBaseQty)
  }
  return orderBaseAmount
}

export function allocateExplodedItems(
  items: LedgerItem[],
  headerDeltas: Record<string, ReturnType<typeof decimal>>,
  spec: { primaryRole: string; sign: 1 | -1 },
  isReversal: boolean,
): Array<{ item: LedgerItem; amount: ReturnType<typeof decimal>; deltas: Record<string, ReturnType<typeof decimal>> }> {
  const sign = isReversal ? -spec.sign : spec.sign
  const primary = camelRole(spec.primaryRole)
  const headerPrimary = headerDeltas[primary] ?? decimal(0)
  const allocated: Array<{
    item: LedgerItem
    amount: ReturnType<typeof decimal>
    deltas: Record<string, ReturnType<typeof decimal>>
  }> = []
  let used = decimal(0)
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    const raw = decimal(roundAmount(item.lineAmount.mul(sign)))
    const isLast = i === items.length - 1
    const amount = isLast ? headerPrimary.minus(used) : raw
    used = used.plus(isLast ? amount : raw)
    const deltas: Record<string, ReturnType<typeof decimal>> = {}
    if (!amount.isZero()) deltas[primary] = amount
    allocated.push({ item, amount, deltas })
  }
  return allocated
}

export function emptyBalances(side: LedgerSide): Record<string, ReturnType<typeof decimal>> {
  const result: Record<string, ReturnType<typeof decimal>> = {}
  for (const role of DISPLAY_ROLES[side]) result[camelRole(role)] = decimal(0)
  return result
}

export function applyRunning(
  rows: Array<{ deltas: Record<string, ReturnType<typeof decimal>> }>,
  side: LedgerSide,
): Record<string, string>[] {
  const running = emptyBalances(side)
  return rows.map((row) => {
    for (const [key, value] of Object.entries(row.deltas)) {
      if (running[key] == null) running[key] = decimal(0)
      running[key] = running[key]!.plus(value)
    }
    const snap: Record<string, string> = {}
    for (const [key, value] of Object.entries(running)) snap[key] = value.toFixed()
    return snap
  })
}

interface GlHit {
  postingDate: string
  seq: number
  voucherType: string
  voucherId: string
  voucherNo: string
  isReversal: boolean
  role: string
  debit: string
  credit: string
}

interface GroupedVoucher {
  postingDate: string
  seq: number
  voucherType: string
  voucherId: string
  voucherNo: string
  isReversal: boolean
  deltas: Record<string, ReturnType<typeof decimal>>
}

export function groupGlHits(hits: GlHit[]): GroupedVoucher[] {
  const map = new Map<string, GroupedVoucher>()
  for (const hit of hits) {
    const key = `${hit.voucherType}:${hit.voucherId}:${hit.isReversal ? 1 : 0}`
    let group = map.get(key)
    if (!group) {
      group = {
        postingDate: hit.postingDate,
        seq: hit.seq,
        voucherType: hit.voucherType,
        voucherId: hit.voucherId,
        voucherNo: hit.voucherNo,
        isReversal: hit.isReversal,
        deltas: {},
      }
      map.set(key, group)
    }
    if (hit.seq < group.seq) group.seq = hit.seq
    const camel = camelRole(hit.role)
    group.deltas[camel] = (group.deltas[camel] ?? decimal(0)).plus(
      roleDelta(hit.role, hit.debit, hit.credit),
    )
  }
  return [...map.values()].sort((a, b) => {
    if (a.postingDate !== b.postingDate) return a.postingDate < b.postingDate ? -1 : 1
    if (a.seq !== b.seq) return a.seq - b.seq
    if (a.voucherNo !== b.voucherNo) return a.voucherNo.localeCompare(b.voucherNo, 'zh')
    return Number(a.isReversal) - Number(b.isReversal)
  })
}

export async function loadPartyLedger(
  db: Kysely<Database>,
  permit: Permit,
  query: PartyLedgerQuery,
): Promise<PartyLedger> {
  if (!query.companyId || !query.asOf || (query.side !== 'ar' && query.side !== 'ap')) {
    throw ApiError.validation('往来明细参数不合法', {
      companyId: query.companyId ? [] : ['必填'],
      asOf: query.asOf ? [] : ['必填'],
      side: query.side === 'ar' || query.side === 'ap' ? [] : ['必须是 ar 或 ap'],
    })
  }
  const asOf = query.asOf.trim().slice(0, 10)
  const partyNil = query.partyNil === true
  if (!partyNil && (!query.partyType || !query.partyId)) {
    throw ApiError.validation('往来明细参数不合法', {
      partyType: ['对手类型与对手须同填，或声明未指定对手'],
      partyId: ['对手类型与对手须同填，或声明未指定对手'],
    })
  }
  if (!companyInPermitScope(permit, query.companyId)) {
    return {
      asOf,
      side: query.side,
      partyType: partyNil ? null : (query.partyType ?? null),
      partyId: partyNil ? null : (query.partyId ?? null),
      rows: [],
    }
  }

  const roles = [...DISPLAY_ROLES[query.side]]
  const accounts = await db
    .selectFrom('bas_account')
    .select(['id', 'role'])
    .where('company_id', '=', query.companyId)
    .where('role', 'in', roles)
    .execute()
  if (accounts.length === 0) {
    return emptyResult(query, asOf, partyNil)
  }
  const roleByAccount = new Map(accounts.map((a) => [a.id, a.role ?? '']))
  const accountIds = accounts.map((a) => a.id)
  const partyType = partyNil ? null : (query.partyType ?? '').toLowerCase()
  const partyId = partyNil ? null : query.partyId!

  let glQuery = db
    .selectFrom('acc_gl_entry')
    .select([
      'posting_date',
      'seq',
      'voucher_type',
      'voucher_id',
      'voucher_no',
      'is_reversal',
      'account_id',
      'debit',
      'credit',
    ])
    .where('company_id', '=', query.companyId)
    .where(sql<boolean>`posting_date <= ${asOf}::date`)
    .where('is_cancelled', '=', false)
    .where('account_id', 'in', accountIds)
  if (partyNil) {
    glQuery = glQuery.where('party_id', 'is', null)
  } else {
    glQuery = glQuery
      .where(sql<boolean>`lower(coalesce(party_type, '')) = ${partyType}`)
      .where('party_id', '=', partyId)
  }
  const glRows = await glQuery.execute()
  const hits: GlHit[] = glRows.map((row) => ({
    postingDate: toDateOnly(row.posting_date as Date | string),
    seq: Number(row.seq),
    voucherType: row.voucher_type,
    voucherId: row.voucher_id,
    voucherNo: row.voucher_no,
    isReversal: row.is_reversal,
    role: roleByAccount.get(row.account_id) ?? '',
    debit: String(row.debit),
    credit: String(row.credit),
  }))
  const groups = groupGlHits(hits)
  if (groups.length === 0) return emptyResult(query, asOf, partyNil)

  const extras = await loadVoucherExtras(
    db,
    groups.map((g) => ({ type: g.voucherType, id: g.voucherId })),
  )
  const exploded = await loadExplodedItems(
    db,
    groups.filter((g) => EXPLODE_TYPES.has(g.voucherType)).map((g) => g.voucherId),
  )

  type Built = {
    postingDate: string
    seq: number
    itemIdx: number
    voucherType: string
    voucherId: string
    voucherNo: string
    isReversal: boolean
    itemId: string | null
    materialLabel: string | null
    qty: string | null
    unitLabel: string | null
    amount: ReturnType<typeof decimal>
    deltas: Record<string, ReturnType<typeof decimal>>
    remarks: string | null
  }
  const built: Built[] = []
  for (const group of groups) {
    const spec = EXPLODE_SPEC[group.voucherType]
    const items = spec ? (exploded.get(group.voucherId) ?? []) : []
    if (spec && items.length > 0 && !partyNil) {
      const allocated = allocateExplodedItems(items, group.deltas, spec, group.isReversal)
      const primary = camelRole(spec.primaryRole)
      for (let i = 0; i < allocated.length; i += 1) {
        const row = allocated[i]!
        const deltas = { ...row.deltas }
        if (i === allocated.length - 1) {
          for (const [key, value] of Object.entries(group.deltas)) {
            if (key === primary || value.isZero()) continue
            deltas[key] = (deltas[key] ?? decimal(0)).plus(value)
          }
        }
        built.push({
          postingDate: group.postingDate,
          seq: group.seq,
          itemIdx: row.item.idx,
          voucherType: group.voucherType,
          voucherId: group.voucherId,
          voucherNo: group.voucherNo,
          isReversal: group.isReversal,
          itemId: row.item.id,
          materialLabel: formatMaterial(row.item.materialCode, row.item.materialName),
          qty: row.item.qty,
          unitLabel: row.item.unitName,
          amount: row.amount,
          deltas,
          remarks: row.item.remarks,
        })
      }
    } else {
      built.push({
        postingDate: group.postingDate,
        seq: group.seq,
        itemIdx: 0,
        voucherType: group.voucherType,
        voucherId: group.voucherId,
        voucherNo: group.voucherNo,
        isReversal: group.isReversal,
        itemId: null,
        materialLabel: null,
        qty: null,
        unitLabel: null,
        amount: voucherAmount(query.side, group.deltas),
        deltas: group.deltas,
        remarks: extras.get(group.voucherId)?.remarks ?? null,
      })
    }
  }

  built.sort((a, b) => {
    if (a.postingDate !== b.postingDate) return a.postingDate < b.postingDate ? -1 : 1
    if (a.seq !== b.seq) return a.seq - b.seq
    if (a.voucherNo !== b.voucherNo) return a.voucherNo.localeCompare(b.voucherNo, 'zh')
    if (a.itemIdx !== b.itemIdx) return a.itemIdx - b.itemIdx
    return (a.itemId ?? '').localeCompare(b.itemId ?? '')
  })
  const running = applyRunning(built, query.side)
  const rows: PartyLedgerRow[] = built.map((row, i) => {
    const extra = extras.get(row.voucherId)
    return {
      id: `${row.voucherType}:${row.voucherId}:${row.isReversal ? 1 : 0}:${row.itemId ?? 'doc'}`,
      postingDate: row.postingDate,
      seq: row.seq,
      voucherType: row.voucherType,
      voucherTypeLabel: typeLabel({
        voucherType: row.voucherType,
        isReversal: row.isReversal,
        invoiceDirection: extra?.invoiceDirection,
        invoicePartyType: extra?.invoicePartyType,
        billTransactionType: extra?.billTransactionType,
      }),
      voucherId: row.voucherId,
      voucherNo: row.voucherNo,
      voucherResource: VOUCHER_RESOURCE[row.voucherType] ?? null,
      isReversal: row.isReversal,
      itemId: row.itemId,
      materialLabel: row.materialLabel,
      qty: row.qty,
      unitLabel: row.unitLabel,
      amount: row.amount.toFixed(),
      balances: running[i]!,
      remarks: row.remarks,
    }
  })
  rows.reverse()
  return {
    asOf,
    side: query.side,
    partyType: partyNil ? null : (query.partyType ?? '').toUpperCase(),
    partyId: partyNil ? null : query.partyId!,
    rows,
  }
}

function emptyResult(query: PartyLedgerQuery, asOf: string, partyNil: boolean): PartyLedger {
  return {
    asOf,
    side: query.side,
    partyType: partyNil ? null : (query.partyType ?? null),
    partyId: partyNil ? null : (query.partyId ?? null),
    rows: [],
  }
}

function formatMaterial(code: string | null, name: string | null): string | null {
  const c = code?.trim() || ''
  const n = name?.trim() || ''
  if (!c && !n) return null
  if (c && n) return `${c} ${n}`
  return c || n
}

interface VoucherExtra {
  remarks: string | null
  invoiceDirection: string | null
  invoicePartyType: string | null
  billTransactionType: string | null
}

async function loadVoucherExtras(
  db: Kysely<Database>,
  refs: Array<{ type: string; id: string }>,
): Promise<Map<string, VoucherExtra>> {
  const result = new Map<string, VoucherExtra>()
  const byType = new Map<string, string[]>()
  for (const ref of refs) {
    const list = byType.get(ref.type) ?? []
    list.push(ref.id)
    byType.set(ref.type, list)
  }
  const put = (id: string, patch: Partial<VoucherExtra>) => {
    const prev = result.get(id) ?? {
      remarks: null,
      invoiceDirection: null,
      invoicePartyType: null,
      billTransactionType: null,
    }
    result.set(id, { ...prev, ...patch })
  }

  const invoiceIds = byType.get('acc.vat_invoice') ?? []
  if (invoiceIds.length > 0) {
    const rows = await db
      .selectFrom('acc_vat_invoice')
      .select(['id', 'remarks', 'direction', 'party_type'])
      .where('id', 'in', invoiceIds)
      .execute()
    for (const row of rows) {
      put(row.id, {
        remarks: row.remarks,
        invoiceDirection: row.direction,
        invoicePartyType: row.party_type,
      })
    }
  }
  const billIds = byType.get('acc.bill_transaction') ?? []
  if (billIds.length > 0) {
    const rows = await db
      .selectFrom('acc_bill_transaction')
      .select(['id', 'transaction_type', 'remarks'])
      .where('id', 'in', billIds)
      .execute()
    for (const row of rows) {
      put(row.id, { billTransactionType: row.transaction_type, remarks: row.remarks })
    }
  }
  const journalIds = byType.get('acc.gl_journal') ?? []
  if (journalIds.length > 0) {
    const rows = await db
      .selectFrom('acc_gl_journal')
      .select(['id', 'remarks'])
      .where('id', 'in', journalIds)
      .execute()
    for (const row of rows) put(row.id, { remarks: row.remarks })
  }
  const expenseIds = byType.get('acc.expense_report') ?? []
  if (expenseIds.length > 0) {
    const rows = await db
      .selectFrom('acc_expense_report')
      .select(['id', 'remarks'])
      .where('id', 'in', expenseIds)
      .execute()
    for (const row of rows) put(row.id, { remarks: row.remarks })
  }
  const salesReconIds = byType.get('sales.reconciliation') ?? []
  if (salesReconIds.length > 0) {
    const rows = await db
      .selectFrom('sal_reconciliation')
      .select(['id', 'remarks'])
      .where('id', 'in', salesReconIds)
      .execute()
    for (const row of rows) put(row.id, { remarks: row.remarks })
  }
  const purchaseReconIds = byType.get('purchase.reconciliation') ?? []
  if (purchaseReconIds.length > 0) {
    const rows = await db
      .selectFrom('pur_reconciliation')
      .select(['id', 'remarks'])
      .where('id', 'in', purchaseReconIds)
      .execute()
    for (const row of rows) put(row.id, { remarks: row.remarks })
  }
  return result
}

async function loadExplodedItems(
  db: Kysely<Database>,
  voucherIds: string[],
): Promise<Map<string, LedgerItem[]>> {
  const result = new Map<string, LedgerItem[]>()
  if (voucherIds.length === 0) return result
  const unique = [...new Set(voucherIds)]
  for (const spec of Object.values(EXPLODE_SPEC)) {
    const rows = await sql<{
      id: string
      idx: number
      parent_id: string
      qty: string
      unit_name: string | null
      material_code: string | null
      material_name: string | null
      remarks: string | null
      order_base_qty: string | null
      order_base_amount: string | null
      base_qty: string | null
    }>`
      SELECT i.id, i.idx, i.${ident(spec.parentCol)} AS parent_id, i.qty::text AS qty,
        i.unit_name, i.material_code, i.material_name, i.remarks,
        i.order_base_qty::text AS order_base_qty, i.order_base_amount::text AS order_base_amount,
        i.base_qty::text AS base_qty
      FROM ${ident(spec.table)} i
      WHERE i.${ident(spec.parentCol)} = ANY(${unique}::uuid[])
      ORDER BY i.idx, i.id
    `.execute(db)
    for (const row of rows.rows) {
      const item: LedgerItem = {
        id: row.id,
        idx: Number(row.idx),
        parentId: row.parent_id,
        qty: row.qty,
        unitName: row.unit_name,
        materialCode: row.material_code,
        materialName: row.material_name,
        remarks: row.remarks,
        lineAmount: lineAmountFromSnapshot({
          orderBaseQty: row.order_base_qty,
          orderBaseAmount: row.order_base_amount,
          baseQty: row.base_qty,
        }),
      }
      const list = result.get(item.parentId) ?? []
      list.push(item)
      result.set(item.parentId, list)
    }
  }
  return result
}
