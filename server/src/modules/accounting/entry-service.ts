/**
 * 总账分录只读面 + 应收应付报表。
 * 分录写入只经 engines/gl；本模块不写 acc_gl_entry。
 */
import { decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import {
  canAccessCompany,
  hasPermission,
  type Actor,
} from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { glEntryResourceMeta } from './meta.ts'

export interface GlEntry {
  id: string
  seq: number
  postingDate: string
  debit: string
  credit: string
  partyType: string | null
  partyId: string | null
  voucherType: string
  voucherId: string
  voucherNo: string
  isCancelled: boolean
  isReversed: boolean
  isReversal: boolean
  remarks: string | null
  insertedAt: Date
  companyId: string
  accountId: string
  currencyId: string | null
}

export interface RoleAccount {
  id: string
  code: string
  name: string
}

export interface ArApReportRow {
  partyType: string | null
  partyId: string | null
  partyLabel: string
  balances: Record<string, string>
  netReceivable: string
  netPayable: string
}

export interface ArApReport {
  asOf: string
  roleAccounts: Record<string, RoleAccount[]>
  rows: ArApReportRow[]
}

const PARTY_ROLES = [
  'unbilled_receivable',
  'receivable',
  'advance_received',
  'unbilled_payable',
  'payable',
  'advance_paid',
  'other_payable',
] as const

const DEBIT_ROLES = new Set([
  'unbilled_receivable',
  'receivable',
  'advance_paid',
])

export type EntryService = ReturnType<typeof createEntryService>

export function createEntryService(db: Kysely<Database>) {
  async function get(actor: Actor, id: string): Promise<GlEntry> {
    requireRead(actor)
    const row = await db
      .selectFrom('acc_gl_entry')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row || !canAccessCompany(actor, row.company_id)) {
      throw new ApiError('not_found', '总账分录不存在')
    }
    return mapEntry(row)
  }

  async function list(
    actor: Actor,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: GlEntry[] }> {
    requireRead(actor)
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] }
    return listFromSource({
      db,
      resource: glEntryResourceMeta(),
      source: sql` FROM acc_gl_entry`,
      select: sql`SELECT id, seq, posting_date, debit, credit, party_type, party_id,
voucher_type, voucher_id, voucher_no, is_cancelled, remarks, inserted_at, company_id,
account_id, currency_id, is_reversed, is_reversal`,
      defaultOrder: sql`"seq" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapEntry(r as never),
    })
  }

  async function report(
    actor: Actor,
    query: { companyId: string; asOf: string },
  ): Promise<ArApReport> {
    requireRead(actor)
    if (!query.companyId || !query.asOf) {
      throw ApiError.validation('应收应付报表参数不合法', {
        companyId: ['必填'],
        asOf: ['必填'],
      })
    }
    if (!canAccessCompany(actor, query.companyId)) {
      throw new ApiError('forbidden', '无权查看该公司数据')
    }
    const asOf = query.asOf.trim().slice(0, 10)

    const accounts = await db
      .selectFrom('bas_account')
      .select(['id', 'code', 'name', 'role'])
      .where('company_id', '=', query.companyId)
      .where('role', 'in', [...PARTY_ROLES])
      .orderBy('role', 'asc')
      .orderBy('code', 'asc')
      .orderBy('id', 'asc')
      .execute()

    const result: ArApReport = {
      asOf,
      roleAccounts: {},
      rows: [],
    }
    if (accounts.length === 0) return result

    const roleByAccount = new Map<string, string>()
    const accountIds: string[] = []
    for (const account of accounts) {
      const role = account.role ?? ''
      roleByAccount.set(account.id, role)
      accountIds.push(account.id)
      const key = camelRole(role)
      if (!result.roleAccounts[key]) result.roleAccounts[key] = []
      result.roleAccounts[key]!.push({
        id: account.id,
        code: account.code,
        name: account.name,
      })
    }

    const balances = await db
      .selectFrom('acc_gl_entry')
      .select([
        'party_type',
        'party_id',
        'account_id',
        sql<string>`sum(debit)::text`.as('debit'),
        sql<string>`sum(credit)::text`.as('credit'),
      ])
      .where('company_id', '=', query.companyId)
      .where(sql<boolean>`posting_date <= ${asOf}::date`)
      .where('is_cancelled', '=', false)
      .where('account_id', 'in', accountIds)
      .groupBy(['party_type', 'party_id', 'account_id'])
      .execute()

    type PartyKey = { kind: string; id: string; nil: boolean }
    const keyOf = (k: PartyKey) => (k.nil ? 'nil' : `${k.kind}:${k.id}`)
    const grouped = new Map<string, { key: PartyKey; sums: Record<string, ReturnType<typeof decimal>> }>()

    for (const balance of balances) {
      const key: PartyKey = {
        nil: balance.party_id == null,
        kind: balance.party_type ?? '',
        id: balance.party_id ?? '',
      }
      const mapKey = keyOf(key)
      let bucket = grouped.get(mapKey)
      if (!bucket) {
        bucket = { key, sums: zeroBalances() }
        grouped.set(mapKey, bucket)
      }
      const role = roleByAccount.get(balance.account_id) ?? ''
      let value = decimal(balance.debit).minus(decimal(balance.credit))
      if (!DEBIT_ROLES.has(role)) value = value.neg()
      const camel = camelRole(role)
      bucket.sums[camel] = (bucket.sums[camel] ?? decimal(0)).plus(value)
    }

    const labels = await loadPartyLabels(
      db,
      [...grouped.values()].map((g) => g.key),
    )

    for (const { key, sums } of grouped.values()) {
      let allZero = true
      for (const value of Object.values(sums)) {
        if (!value.isZero()) {
          allZero = false
          break
        }
      }
      if (allZero) continue

      const balancesWire: Record<string, string> = {}
      for (const [k, v] of Object.entries(sums)) {
        balancesWire[k] = v.toFixed()
      }
      const row: ArApReportRow = {
        partyType: null,
        partyId: null,
        partyLabel: '未指定对手',
        balances: balancesWire,
        netReceivable: decimal(0).toFixed(),
        netPayable: decimal(0).toFixed(),
      }
      if (!key.nil) {
        row.partyType = key.kind
        row.partyId = key.id
        const label = labels.get(keyOf(key))
        if (label) row.partyLabel = label
      }
      row.netReceivable = decimal(sums.unbilledReceivable ?? 0)
        .plus(sums.receivable ?? 0)
        .minus(sums.advanceReceived ?? 0)
        .toFixed()
      row.netPayable = decimal(sums.unbilledPayable ?? 0)
        .plus(sums.payable ?? 0)
        .plus(sums.otherPayable ?? 0)
        .minus(sums.advancePaid ?? 0)
        .toFixed()
      result.rows.push(row)
    }

    result.rows.sort((a, b) => {
      if (a.partyId === null) return 1
      if (b.partyId === null) return -1
      return a.partyLabel.localeCompare(b.partyLabel, 'zh')
    })
    return result
  }

  return { get, list, report }
}

function requireRead(actor: Actor | null): asserts actor is Actor {
  if (!hasPermission(actor, 'acc.gl_entry:read')) {
    throw new ApiError('forbidden', '无权查看总账分录')
  }
}

function mapEntry(row: {
  id: string
  seq: string | number | bigint
  posting_date: Date | string
  debit: unknown
  credit: unknown
  party_type: string | null
  party_id: string | null
  voucher_type: string
  voucher_id: string
  voucher_no: string
  is_cancelled: boolean
  is_reversed: boolean
  is_reversal: boolean
  remarks: string | null
  inserted_at: Date | string
  company_id: string
  account_id: string
  currency_id: string | null
}): GlEntry {
  return {
    id: row.id,
    seq: Number(row.seq),
    postingDate: dateOnly(row.posting_date),
    debit: decimal(String(row.debit)).toFixed(),
    credit: decimal(String(row.credit)).toFixed(),
    partyType: row.party_type,
    partyId: row.party_id,
    voucherType: row.voucher_type,
    voucherId: row.voucher_id,
    voucherNo: row.voucher_no,
    isCancelled: row.is_cancelled,
    isReversed: row.is_reversed,
    isReversal: row.is_reversal,
    remarks: row.remarks,
    insertedAt: row.inserted_at instanceof Date ? row.inserted_at : new Date(String(row.inserted_at)),
    companyId: row.company_id,
    accountId: row.account_id,
    currencyId: row.currency_id,
  }
}

function dateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.trim().slice(0, 10)
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function camelRole(role: string): string {
  return role.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function zeroBalances(): Record<string, ReturnType<typeof decimal>> {
  const result: Record<string, ReturnType<typeof decimal>> = {}
  for (const role of PARTY_ROLES) {
    result[camelRole(role)] = decimal(0)
  }
  return result
}

async function loadPartyLabels(
  db: Kysely<Database>,
  keys: Array<{ kind: string; id: string; nil: boolean }>,
): Promise<Map<string, string>> {
  const ids = {
    customer: [] as string[],
    supplier: [] as string[],
    company: [] as string[],
    employee: [] as string[],
  }
  for (const key of keys) {
    if (key.nil) continue
    const bucket = ids[key.kind as keyof typeof ids]
    if (bucket) bucket.push(key.id)
  }
  const result = new Map<string, string>()
  if (ids.customer.length > 0) {
    const rows = await db
      .selectFrom('sal_customers')
      .select(['id', 'name'])
      .where('id', 'in', ids.customer)
      .execute()
    for (const row of rows) result.set(`customer:${row.id}`, row.name)
  }
  if (ids.supplier.length > 0) {
    const rows = await db
      .selectFrom('pur_supplier')
      .select(['id', 'name'])
      .where('id', 'in', ids.supplier)
      .execute()
    for (const row of rows) result.set(`supplier:${row.id}`, row.name)
  }
  if (ids.company.length > 0) {
    const rows = await db
      .selectFrom('bas_company')
      .select(['id', 'name'])
      .where('id', 'in', ids.company)
      .execute()
    for (const row of rows) result.set(`company:${row.id}`, row.name)
  }
  if (ids.employee.length > 0) {
    const rows = await db
      .selectFrom('hr_employees')
      .select(['id', 'name'])
      .where('id', 'in', ids.employee)
      .execute()
    for (const row of rows) result.set(`employee:${row.id}`, row.name)
  }
  return result
}
