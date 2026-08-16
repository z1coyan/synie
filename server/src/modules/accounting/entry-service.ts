/**
 * 总账分录只读面 + 应收应付报表。
 * 分录写入只经 engines/gl；本模块不写 acc_gl_entry。
 *
 * 授权全由平台承担：路由挂 `guard(accGlEntries, 'read')`，本服务只收 Permit。
 * 分录声明 `company` 而非 via：来源单据是多态的（voucher_type/voucher_id 跨资源），
 * 无法静态声明单一 parent——与 `invStockEntries` 同判据（见工单 08）。
 * 应收应付报表是单公司跨资源聚合：只做码级门控 + `companyInPermitScope` 的单公司边界，
 * 不套行过滤（会把 dept/self 谓词编到聚合投影里不存在的列上）。
 */
import { decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { listAuthorized } from '~/db/list.ts'
import { companyInPermitScope, loadAuthorized } from '~/db/load.ts'
import { mapRow } from '~/platform/standard/fields.ts'
import { GL_ENTRY_RESOURCE_NAME, glEntryResourceMeta } from './meta.ts'

export { GL_ENTRY_RESOURCE_NAME } from './meta.ts'

const GL_ENTRY_TABLE = 'acc_gl_entry'

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

export function createEntryService(db: Kysely<Database>, registry: Registry) {
  const entryTarget = registry.authzTarget(GL_ENTRY_RESOURCE_NAME)

  async function get(permit: Permit, id: string): Promise<GlEntry> {
    const row = await loadAuthorized({
      db,
      permit,
      target: entryTarget,
      table: GL_ENTRY_TABLE,
      id,
      notFoundMessage: '总账分录不存在',
    })
    return mapEntry(row as never)
  }

  async function list(
    permit: Permit,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: GlEntry[] }> {
    return listAuthorized({
      db,
      permit,
      target: entryTarget,
      alias: GL_ENTRY_TABLE,
      resource: glEntryResourceMeta(),
      source: sql` FROM acc_gl_entry`,
      select: sql`SELECT id, seq, posting_date, debit, credit, party_type, party_id,
voucher_type, voucher_id, voucher_no, is_cancelled, remarks, inserted_at, company_id,
account_id, currency_id, is_reversed, is_reversal`,
      defaultOrder: sql`"seq" ASC`,
      query,
      mapRow: (r) => mapEntry(r as never),
    })
  }

  async function report(
    permit: Permit,
    query: { companyId: string; asOf: string },
  ): Promise<ArApReport> {
    if (!query.companyId || !query.asOf) {
      throw ApiError.validation('应收应付报表参数不合法', {
        companyId: ['必填'],
        asOf: ['必填'],
      })
    }
    const asOf = query.asOf.trim().slice(0, 10)
    // 单公司聚合：公司未授权即空结果（不泄露存在性），不套逐行过滤
    if (!companyInPermitScope(permit, query.companyId)) {
      return { asOf, roleAccounts: {}, rows: [] }
    }

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
        row.partyType = key.kind ? key.kind.toUpperCase() : null
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

/** db 行 → wire。枚举经平台 mapRow（库内小写、wire 大写），供 list/get 与回归测试共用。 */
export function mapEntry(row: Record<string, unknown>): GlEntry {
  return mapRow(glEntryResourceMeta(), row) as unknown as GlEntry
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
