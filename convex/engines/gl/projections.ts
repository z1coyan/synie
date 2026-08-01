import type { Id } from '../../_generated/dataModel'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import type { QueryCtx } from '../../_generated/server'
import { checkedAdd, postingMonth } from '../shared'

export type GlProjectionDelta = {
  companyId: string
  accountId: Id<'accounts'>
  postingDate: string
  debit: bigint
  credit: bigint
  partyType: string | null
  partyId: string | null
}

export async function applyGlProjection(
  ctx: DomainMutationCtx,
  generation: number,
  delta: GlProjectionDelta,
): Promise<void> {
  const month = postingMonth(delta.postingDate)
  const daily = await ctx.db.query('glAccountDaily').withIndex('by_key_date', (query) =>
    query.eq('generation', generation).eq('companyId', delta.companyId).eq('accountId', delta.accountId)
      .eq('postingDate', delta.postingDate),
  ).unique()
  if (daily) await ctx.db.patch(daily._id, { debit: checkedAdd(daily.debit, delta.debit), credit: checkedAdd(daily.credit, delta.credit) })
  else await ctx.db.insert('glAccountDaily', {
    generation,
    companyId: delta.companyId,
    accountId: delta.accountId,
    postingDate: delta.postingDate,
    debit: delta.debit,
    credit: delta.credit,
  })
  const monthly = await ctx.db.query('glAccountMonthly').withIndex('by_key_month', (query) =>
    query.eq('generation', generation).eq('companyId', delta.companyId).eq('accountId', delta.accountId)
      .eq('postingMonth', month),
  ).unique()
  if (monthly) await ctx.db.patch(monthly._id, { debit: checkedAdd(monthly.debit, delta.debit), credit: checkedAdd(monthly.credit, delta.credit) })
  else await ctx.db.insert('glAccountMonthly', {
    generation,
    companyId: delta.companyId,
    accountId: delta.accountId,
    postingMonth: month,
    debit: delta.debit,
    credit: delta.credit,
  })

  if (!delta.partyType || !delta.partyId) return
  const partyDaily = await ctx.db.query('glPartyDaily').withIndex('by_key_date', (query) =>
    query.eq('generation', generation).eq('companyId', delta.companyId).eq('accountId', delta.accountId)
      .eq('partyType', delta.partyType!).eq('partyId', delta.partyId!).eq('postingDate', delta.postingDate),
  ).unique()
  if (partyDaily) await ctx.db.patch(partyDaily._id, { debit: checkedAdd(partyDaily.debit, delta.debit), credit: checkedAdd(partyDaily.credit, delta.credit) })
  else await ctx.db.insert('glPartyDaily', {
    generation,
    companyId: delta.companyId,
    accountId: delta.accountId,
    partyType: delta.partyType,
    partyId: delta.partyId,
    postingDate: delta.postingDate,
    debit: delta.debit,
    credit: delta.credit,
  })
  const partyMonthly = await ctx.db.query('glPartyMonthly').withIndex('by_key_month', (query) =>
    query.eq('generation', generation).eq('companyId', delta.companyId).eq('accountId', delta.accountId)
      .eq('partyType', delta.partyType!).eq('partyId', delta.partyId!).eq('postingMonth', month),
  ).unique()
  if (partyMonthly) await ctx.db.patch(partyMonthly._id, { debit: checkedAdd(partyMonthly.debit, delta.debit), credit: checkedAdd(partyMonthly.credit, delta.credit) })
  else await ctx.db.insert('glPartyMonthly', {
    generation,
    companyId: delta.companyId,
    accountId: delta.accountId,
    partyType: delta.partyType,
    partyId: delta.partyId,
    postingMonth: month,
    debit: delta.debit,
    credit: delta.credit,
  })
}

/** Reads month buckets before the target month and <=31 daily buckets in it. */
export async function glAccountAsOf(
  ctx: QueryCtx,
  generation: number,
  companyId: string,
  accountId: Id<'accounts'>,
  date: string,
) {
  const month = postingMonth(date)
  const [months, days] = await Promise.all([
    ctx.db.query('glAccountMonthly').withIndex('by_key_month', (q) =>
      q.eq('generation', generation).eq('companyId', companyId).eq('accountId', accountId).lt('postingMonth', month),
    ).take(2_400),
    ctx.db.query('glAccountDaily').withIndex('by_key_date', (q) =>
      q.eq('generation', generation).eq('companyId', companyId).eq('accountId', accountId)
        .gte('postingDate', `${month}-01`).lte('postingDate', date),
    ).take(31),
  ])
  let debit = 0n
  let credit = 0n
  for (const row of [...months, ...days]) {
    debit = checkedAdd(debit, row.debit)
    credit = checkedAdd(credit, row.credit)
  }
  return { debit, credit, scannedBuckets: months.length + days.length }
}
