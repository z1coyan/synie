import { Decimal, roundAmount } from '@synie/shared'
import type { GenericMutationCtx } from 'convex/server'
import type { DataModel } from '../../_generated/dataModel'
import type { Actor } from '../../lib/actor'
import { synieError } from '../../lib/errors'
import { childrenFor, createDomainRecord, hydrateStored, removeDomainRecord, unsafeStoredForMutation } from '../shared/records'

type MutationCtx = GenericMutationCtx<DataModel>
type Wire = Record<string, unknown>
type Segment = { companyId: string; bankAccountId: string; start: number; end: number; acquiredOn: string; sourceId: string }

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw synieError('validation', `${field}必须是非负安全整数`)
  return value
}

function overlaps(a: Segment, start: number, end: number): boolean {
  return a.start <= end && start <= a.end
}

function replay(rows: readonly Wire[]): Segment[] {
  let segments: Segment[] = []
  for (const row of rows) {
    const start = integer(row.subStart, '票据起号')
    const end = integer(row.subEnd, '票据止号')
    if (end < start) throw synieError('conflict', '票据止号不能小于起号')
    const kind = String(row.transactionType).toUpperCase()
    const companyId = String(row.companyId)
    const bankAccountId = String(row.bankAccountId)
    const label = String(row.docNo ?? row.id)
    if (kind === 'RECEIVE') {
      if (segments.some((segment) => overlaps(segment, start, end))) throw synieError('conflict', `交易 ${label} 接收段与现有持有段重叠`)
      segments.push({ companyId, bankAccountId, start, end, acquiredOn: String(row.occurredOn), sourceId: String(row.id) })
      continue
    }
    const next: Segment[] = []
    let cursor = start
    for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
      if (segment.companyId !== companyId || segment.bankAccountId !== bankAccountId || !overlaps(segment, start, end)) {
        next.push(segment); continue
      }
      if (segment.start > cursor) throw synieError('conflict', `交易 ${label} 的票据段未持有`)
      if (segment.start < start) next.push({ ...segment, end: start - 1 })
      if (segment.end >= cursor) cursor = segment.end + 1
      if (segment.end > end) next.push({ ...segment, start: end + 1 })
    }
    if (cursor <= end) throw synieError('conflict', `交易 ${label} 的票据段未持有`)
    if (kind === 'REALLOCATE') {
      if (typeof row.toBankAccountId !== 'string') throw synieError('conflict', '票据调拨缺少转入账户')
      next.push({ companyId, bankAccountId: row.toBankAccountId, start, end, acquiredOn: String(row.occurredOn), sourceId: String(row.id) })
    }
    segments = next
  }
  return segments
}

export async function replayBill(
  ctx: MutationCtx,
  actor: Actor,
  billId: string,
  pending: { id: string; status: 'AUDITED' | 'VOIDED' },
): Promise<void> {
  const bill = hydrateStored(await unsafeStoredForMutation(ctx, 'accBills', billId))
  const transactions = await childrenFor(ctx, 'accBillTransactions', billId)
  const active = transactions
    .filter((row) => (String(row.id) === pending.id ? pending.status : row.status) === 'AUDITED')
    .sort((left, right) => String(left.occurredOn).localeCompare(String(right.occurredOn)) || Number(left.auditedAt ?? left.insertedAt) - Number(right.auditedAt ?? right.insertedAt) || String(left.id).localeCompare(String(right.id)))
  const segments = replay(active)
  for (const holding of await childrenFor(ctx, 'accBillHoldings', billId)) {
    await removeDomainRecord(ctx, actor, 'accBillHoldings', String(holding.id), { permissionChecked: true })
  }
  for (const segment of segments) {
    await createDomainRecord(ctx, actor, 'accBillHoldings', {}, {
      permissionChecked: true,
      trustedDerived: {
        billId,
        billNo: bill.billNo,
        subStart: segment.start,
        subEnd: segment.end,
        amount: roundAmount(new Decimal(segment.end - segment.start + 1).div(100)),
        dueDate: bill.dueDate,
        acquiredOn: segment.acquiredOn,
        companyId: segment.companyId,
        bankAccountId: segment.bankAccountId,
        sourceTransactionId: segment.sourceId,
      },
    })
  }
}
