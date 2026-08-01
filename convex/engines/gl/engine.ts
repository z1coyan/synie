import { assertMutationBudget } from '../../lib/budget'
import type { DomainMutationCtx } from '../../lib/mutationContext'
import { synieError } from '../../lib/errors'
import { activeGenerationInMutation } from '../generation'
import { normalizeGlLines, PARTY_REQUIRED_ROLES, validateGlVoucher, type GlLine, type GlVoucher } from './model'
import { applyGlProjection } from './projections'
import { replaceDomainQueryRows } from '../../domains/shared/queryProfiles'

function glBudget(lines: number, label: string) {
  return {
    label,
    reads: 2 * lines + 4,
    writes: 6 * lines + 2,
    estimatedReadBytes: (2 * lines + 4) * 1_024,
    estimatedWriteBytes: (6 * lines + 2) * 1_024,
  }
}

async function validateReferences(ctx: DomainMutationCtx, voucher: GlVoucher, lines: ReturnType<typeof normalizeGlLines>) {
  for (const line of lines) {
    const [account, currency] = await Promise.all([
      ctx.db.get(line.accountId),
      line.currencyId ? ctx.db.get(line.currencyId) : null,
    ])
    if (!account) throw synieError('validation', '科目不存在')
    if (account.companyId !== voucher.companyId) throw synieError('validation', '科目不属于凭证公司')
    if (account.isGroup) throw synieError('validation', '汇总科目不可过账')
    if (account.active === false) throw synieError('validation', '停用科目不可过账')
    if (line.currencyId && (!currency || !currency.active)) throw synieError('validation', '币种不存在或已停用')
    if (PARTY_REQUIRED_ROLES.has(account.role ?? '') && (!line.partyType || !line.partyId)) {
      throw synieError('validation', '往来科目必须填写对手')
    }
  }
}

export async function postGlInMutation(
  ctx: DomainMutationCtx,
  voucher: GlVoucher,
  input: readonly GlLine[],
): Promise<number> {
  validateGlVoucher(voucher)
  const lines = normalizeGlLines(input)
  assertMutationBudget(glBudget(lines.length, '总账过账'))
  await validateReferences(ctx, voucher, lines)
  const existing = await ctx.db.query('glEntries').withIndex('by_voucher', (query) =>
    query.eq('voucherType', voucher.type).eq('voucherId', voucher.id),
  ).take(1)
  if (existing.length) throw synieError('conflict', '凭证已经过账')
  const generation = await activeGenerationInMutation(ctx, 'gl')
  const now = Date.now()
  for (const [sequence, line] of lines.entries()) {
    const factId = await ctx.db.insert('glEntries', {
      voucherType: voucher.type,
      voucherId: voucher.id,
      voucherNo: voucher.no,
      companyId: voucher.companyId,
      accountId: line.accountId,
      currencyId: line.currencyId,
      postingDate: voucher.postingDate,
      debit: line.debitScaled,
      credit: line.creditScaled,
      partyType: line.partyType,
      partyId: line.partyId,
      sequence,
      reversal: false,
      reversedById: null,
      reversesId: null,
      cancelled: false,
      cancelledAt: null,
      createdAt: now,
    })
    const projectionId = await ctx.db.insert('accountingDocuments', {
      resource: 'accGlEntries',
      companyId: voucher.companyId,
      parentId: null,
      status: null,
      sortKey: `${voucher.postingDate}:${voucher.no}:${String(sequence).padStart(6, '0')}`,
      searchText: `${voucher.no} ${voucher.type}`.toLocaleLowerCase(),
      decimalValues: { debit: line.debitScaled, credit: line.creditScaled },
      data: {
        seq: sequence,
        postingDate: voucher.postingDate,
        partyType: line.partyType,
        partyId: line.partyId,
        voucherType: voucher.type,
        voucherId: voucher.id,
        voucherNo: voucher.no,
        isCancelled: false,
        isReversed: false,
        isReversal: false,
        remarks: null,
        companyId: voucher.companyId,
        accountId: line.accountId,
        currencyId: line.currencyId,
        factId,
      },
      insertedAt: now,
      updatedAt: now,
    })
    await replaceDomainQueryRows(ctx, 'accGlEntries', String(projectionId), {
      seq: sequence,
      postingDate: voucher.postingDate,
      companyId: voucher.companyId,
    }, { companyId: voucher.companyId, parentId: null, status: null })
    await ctx.db.patch(factId, { factProjectionId: projectionId })
    await applyGlProjection(ctx, generation, {
      companyId: voucher.companyId,
      accountId: line.accountId,
      postingDate: voucher.postingDate,
      debit: line.debitScaled,
      credit: line.creditScaled,
      partyType: line.partyType,
      partyId: line.partyId,
    })
  }
  return lines.length
}

export async function reverseGlInMutation(
  ctx: DomainMutationCtx,
  voucherType: string,
  voucherId: string,
  postingDate?: string,
): Promise<number> {
  const facts = await ctx.db.query('glEntries').withIndex('by_voucher', (q) =>
    q.eq('voucherType', voucherType).eq('voucherId', voucherId),
  ).take(5_000)
  const originals = facts.filter((fact) => !fact.cancelled && !fact.reversal)
  if (!originals.length) throw synieError('conflict', '总账分录不存在')
  if (originals.some((fact) => fact.reversedById !== null)) throw synieError('conflict', '凭证已经红冲')
  assertMutationBudget(glBudget(originals.length, '总账红冲'))
  const generation = await activeGenerationInMutation(ctx, 'gl')
  const now = Date.now()
  for (const original of originals) {
    const reversalId = await ctx.db.insert('glEntries', {
      voucherType: original.voucherType,
      voucherId: original.voucherId,
      voucherNo: original.voucherNo,
      companyId: original.companyId,
      accountId: original.accountId,
      currencyId: original.currencyId,
      postingDate: postingDate ?? original.postingDate,
      debit: -original.debit,
      credit: -original.credit,
      partyType: original.partyType,
      partyId: original.partyId,
      sequence: original.sequence,
      reversal: true,
      reversedById: null,
      reversesId: original._id,
      cancelled: false,
      cancelledAt: null,
      createdAt: now,
    })
    const projectionId = await ctx.db.insert('accountingDocuments', {
      resource: 'accGlEntries', companyId: original.companyId, parentId: null, status: null,
      sortKey: `${postingDate ?? original.postingDate}:${original.voucherNo}:${String(original.sequence).padStart(6, '0')}:reversal`,
      searchText: `${original.voucherNo} ${original.voucherType}`.toLocaleLowerCase(),
      decimalValues: { debit: -original.debit, credit: -original.credit },
      data: {
        seq: original.sequence, postingDate: postingDate ?? original.postingDate,
        partyType: original.partyType, partyId: original.partyId,
        voucherType: original.voucherType, voucherId: original.voucherId, voucherNo: original.voucherNo,
        isCancelled: false, isReversed: false, isReversal: true, remarks: null,
        companyId: original.companyId, accountId: original.accountId, currencyId: original.currencyId,
        factId: reversalId, reversesId: original._id,
      },
      insertedAt: now, updatedAt: now,
    })
    await replaceDomainQueryRows(ctx, 'accGlEntries', String(projectionId), {
      seq: original.sequence,
      postingDate: postingDate ?? original.postingDate,
      companyId: original.companyId,
    }, { companyId: original.companyId, parentId: null, status: null })
    await ctx.db.patch(reversalId, { factProjectionId: projectionId })
    await ctx.db.patch(original._id, { reversedById: reversalId })
    if (original.factProjectionId) {
      const originalProjection = await ctx.db.get(original.factProjectionId)
      if (originalProjection) await ctx.db.patch(originalProjection._id, {
        data: { ...originalProjection.data, isReversed: true, reversedById: reversalId }, updatedAt: now,
      })
    }
    await applyGlProjection(ctx, generation, {
      companyId: original.companyId,
      accountId: original.accountId,
      postingDate: postingDate ?? original.postingDate,
      debit: -original.debit,
      credit: -original.credit,
      partyType: original.partyType,
      partyId: original.partyId,
    })
  }
  return originals.length
}

export async function cancelGlInMutation(
  ctx: DomainMutationCtx,
  voucherType: string,
  voucherId: string,
): Promise<number> {
  const facts = await ctx.db.query('glEntries').withIndex('by_voucher', (q) =>
    q.eq('voucherType', voucherType).eq('voucherId', voucherId),
  ).take(5_000)
  const live = facts.filter((fact) => !fact.cancelled)
  if (!live.length) return 0
  assertMutationBudget(glBudget(live.length, '总账作废'))
  const generation = await activeGenerationInMutation(ctx, 'gl')
  const now = Date.now()
  for (const fact of live) {
    await ctx.db.patch(fact._id, { cancelled: true, cancelledAt: now })
    if (fact.factProjectionId) {
      const projection = await ctx.db.get(fact.factProjectionId)
      if (projection) await ctx.db.patch(projection._id, {
        data: { ...projection.data, isCancelled: true, cancelledAt: now }, updatedAt: now,
      })
    }
    await applyGlProjection(ctx, generation, {
      companyId: fact.companyId,
      accountId: fact.accountId,
      postingDate: fact.postingDate,
      debit: -fact.debit,
      credit: -fact.credit,
      partyType: fact.partyType,
      partyId: fact.partyId,
    })
  }
  return live.length
}
