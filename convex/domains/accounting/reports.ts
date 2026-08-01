import { v } from 'convex/values'
import type { Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { permissionedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { scaledInt64ToDecimal } from '../../lib/decimal'
import { synieError, validationError } from '../../lib/errors'
import { activeGenerationInQuery } from '../../engines/generation'
import { checkedAdd, postingMonth } from '../../engines/shared'

const PARTY_ROLES = [
  'unbilled_receivable', 'receivable', 'advance_received',
  'unbilled_payable', 'payable', 'advance_paid', 'other_payable',
] as const
const DEBIT_ROLES = new Set(['unbilled_receivable', 'receivable', 'advance_paid'])

function camelRole(role: string): string {
  return role.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

async function partyLabel(
  ctx: QueryCtx,
  partyType: string,
  partyId: string,
): Promise<string> {
  const normalized = partyType.toLocaleLowerCase()
  if (normalized.includes('customer')) {
    const row = await ctx.db.get(partyId as Id<'customers'>)
    if (row) return `${row.code} ${row.name}`
  }
  if (normalized.includes('supplier')) {
    const row = await ctx.db.get(partyId as Id<'suppliers'>)
    if (row) return `${row.code} ${row.name}`
  }
  if (normalized.includes('employee')) {
    const row = await ctx.db.get(partyId as Id<'employees'>)
    if (row) return `${row.code} ${row.name}`
  }
  if (normalized.includes('company')) {
    const row = await ctx.db.get(partyId as Id<'companies'>)
    if (row) return `${row.code} ${row.name}`
  }
  return partyId
}

export const arAp = permissionedQuery('acc.gl_entry:read')({
  args: { companyId: v.id('companies'), asOf: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.asOf)) {
      throw validationError('应收应付报表参数不合法', { asOf: ['须为 YYYY-MM-DD 日期'] })
    }
    if (!canAccessCompany(ctx.actor, args.companyId)) throw synieError('forbidden', '无权查看该公司数据')

    const accounts = await ctx.db.query('accounts')
      .withIndex('by_company_code_key', (q) => q.eq('companyId', args.companyId))
      .collect()
    const roleAccounts: Record<string, Array<{ id: string; code: string; name: string }>> = {}
    const reportAccounts = accounts.filter((row) => PARTY_ROLES.includes(row.role as typeof PARTY_ROLES[number]))
    for (const account of reportAccounts) {
      const key = camelRole(account.role!)
      ;(roleAccounts[key] ??= []).push({ id: account._id, code: account.code, name: account.name })
    }

    const generation = await activeGenerationInQuery(ctx, 'gl')
    const month = postingMonth(args.asOf)
    const grouped = new Map<string, {
      partyType: string
      partyId: string
      sums: Record<string, bigint>
    }>()
    for (const account of reportAccounts) {
      const [months, days] = await Promise.all([
        ctx.db.query('glPartyMonthly').withIndex('by_account_month', (q) =>
          q.eq('generation', generation).eq('companyId', args.companyId)
            .eq('accountId', account._id).lt('postingMonth', month),
        ).take(2_400),
        ctx.db.query('glPartyDaily').withIndex('by_account_date', (q) =>
          q.eq('generation', generation).eq('companyId', args.companyId)
            .eq('accountId', account._id).gte('postingDate', `${month}-01`).lte('postingDate', args.asOf),
        ).take(31_000),
      ])
      const role = account.role!
      const roleKey = camelRole(role)
      for (const fact of [...months, ...days]) {
        const partyKey = `${fact.partyType}:${fact.partyId}`
        const bucket = grouped.get(partyKey) ?? {
          partyType: fact.partyType,
          partyId: fact.partyId,
          sums: Object.fromEntries(PARTY_ROLES.map((value) => [camelRole(value), 0n])),
        }
        let amount = fact.debit - fact.credit
        if (!DEBIT_ROLES.has(role)) amount = -amount
        bucket.sums[roleKey] = checkedAdd(bucket.sums[roleKey] ?? 0n, amount)
        grouped.set(partyKey, bucket)
      }
    }

    const rows = []
    for (const bucket of grouped.values()) {
      if (Object.values(bucket.sums).every((value) => value === 0n)) continue
      const balances = Object.fromEntries(
        Object.entries(bucket.sums).map(([key, value]) => [key, scaledInt64ToDecimal(value, 2)]),
      )
      const netReceivable = checkedAdd(
        checkedAdd(bucket.sums.unbilledReceivable ?? 0n, bucket.sums.receivable ?? 0n),
        -(bucket.sums.advanceReceived ?? 0n),
      )
      const netPayable = checkedAdd(
        checkedAdd(
          checkedAdd(bucket.sums.unbilledPayable ?? 0n, bucket.sums.payable ?? 0n),
          bucket.sums.otherPayable ?? 0n,
        ),
        -(bucket.sums.advancePaid ?? 0n),
      )
      rows.push({
        partyType: bucket.partyType,
        partyId: bucket.partyId,
        partyLabel: await partyLabel(ctx, bucket.partyType, bucket.partyId),
        balances,
        netReceivable: scaledInt64ToDecimal(netReceivable, 2),
        netPayable: scaledInt64ToDecimal(netPayable, 2),
      })
    }
    rows.sort((left, right) => left.partyLabel.localeCompare(right.partyLabel, 'zh'))
    return { asOf: args.asOf, roleAccounts, rows }
  },
})
