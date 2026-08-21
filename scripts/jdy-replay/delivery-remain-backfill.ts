/**
 * W5 发货剩余未对账重过：同一 withTx 内备注硬闸 → 整单 gl.cancel →
 * 按 verify6 粒度 gl.post 两行 → ADR 豁免 DELETE A(J)-20200101-0008。
 * 金额自查库，禁止手写 INSERT acc_gl_entry。
 */
import { decimal, roundAmount } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { toDateOnly } from '../../server/src/db/dates.ts'
import { withTx, type TrxHandle } from '../../server/src/db/tx.ts'
import type { DB as Database } from '../../server/src/db/types.ts'
import { createGlEngine } from '../../server/src/engines/gl/index.ts'
import type { GlEntry } from '../../server/src/engines/gl/index.ts'
import type { Permit } from '../../server/src/platform/authz/core/index.ts'
import { ApiError } from '../../server/src/platform/http/errors.ts'
import { accountCurrencies } from '../../server/src/platform/posting/account-currency.ts'
import { lowerParty } from '../../server/src/platform/posting/text.ts'

export const JDY_DELIVERY_REMARKS = '简道云出库:%'
export const PLUG_0008_VOUCHER_NO = 'A(J)-20200101-0008'
export const PLUG_0008_DATE = '2020-01-01'

const VOUCHER = 'sales.delivery'
const JOURNAL_VOUCHER = 'acc.gl_journal'
const gl = createGlEngine()

export interface DeliveryRemainOpts {
  ids: string[]
  apply: boolean
}

export interface DeliveryRemainPosted {
  id: string
  amount: string
}

export interface DeliveryRemainResult {
  apply: boolean
  nonJdyLiveGl: number
  cancelled: string[]
  posted: DeliveryRemainPosted[]
  deletedJournals: string[]
  warning?: string
}

interface RepostHead {
  id: string
  companyId: string
  partyType: string
  partyId: string
  debitAccountId: string
  creditAccountId: string
  deliveryDate: string
  postingDate: string
  deliveryNo: string
  rawAmt: ReturnType<typeof decimal>
}

export async function runDeliveryRemainBackfill(
  db: Kysely<Database>,
  permit: Permit,
  opts: DeliveryRemainOpts,
): Promise<DeliveryRemainResult> {
  if (permit.resource !== 'salDeliveries' || permit.action !== 'audit') {
    throw new ApiError('forbidden', '发货剩余补过账需要 salDeliveries:audit')
  }
  const ids = [...new Set(opts.ids)]
  // 空列表不得进 withTx：否则会只删 0008、留下旧全额 1124
  if (opts.apply && ids.length === 0) {
    throw new ApiError('conflict', '空 --ids-file 拒绝 --apply，不会删除 0008')
  }
  if (!opts.apply) {
    return previewDeliveryRemain(db, ids)
  }
  return withTx(db, (trx) => applyDeliveryRemain(trx, ids))
}

async function previewDeliveryRemain(
  db: Kysely<Database>,
  ids: string[],
): Promise<DeliveryRemainResult> {
  const nonJdyLiveGl = await countNonJdyLiveDeliveryGl(db)
  if (nonJdyLiveGl > 0) {
    throw new ApiError(
      'conflict',
      `存在 ${nonJdyLiveGl} 条未作废 sales.delivery 分录其发货备注不是「简道云出库:%」`,
    )
  }
  const cancelled = await loadCancelIds(db, ids)
  const posted = planRepost(await loadRepostHeads(db, ids)).map((row) => ({
    id: row.id,
    amount: row.amount,
  }))
  const journals = await loadPlug0008(db)
  let warning: string | undefined
  if (journals.length === 0) {
    warning = `${PLUG_0008_VOUCHER_NO} 已不存在，dry-run 仅列出取消/重过集`
  } else {
    const recon = await countPlugRecon(db, journals)
    if (recon > 0) {
      throw new ApiError('conflict', `${PLUG_0008_VOUCHER_NO} 仍被银行对账引用`)
    }
  }
  return {
    apply: false,
    nonJdyLiveGl,
    cancelled,
    posted,
    deletedJournals: journals,
    warning,
  }
}

async function applyDeliveryRemain(trx: TrxHandle, ids: string[]): Promise<DeliveryRemainResult> {
  const nonJdyLiveGl = await countNonJdyLiveDeliveryGl(trx)
  if (nonJdyLiveGl > 0) {
    throw new ApiError(
      'conflict',
      `存在 ${nonJdyLiveGl} 条未作废 sales.delivery 分录其发货备注不是「简道云出库:%」`,
    )
  }

  const nonJdy1124Snap = await loadNonJdyDelivery1124(trx)

  if (ids.length > 0) {
    await sql`
      SELECT id FROM sal_delivery WHERE id = ANY(${ids}::uuid[]) FOR UPDATE
    `.execute(trx)
  }

  const cancelled = await loadCancelIds(trx, ids)
  for (const id of cancelled) {
    await gl.cancel(trx, { type: VOUCHER, id })
  }

  const planned = planRepost(await loadRepostHeads(trx, ids))
  const posted: DeliveryRemainPosted[] = []
  for (const head of planned) {
    if (decimal(head.amount).isZero()) continue
    await postRemainHead(trx, head)
    posted.push({ id: head.id, amount: head.amount })
  }

  const deletedJournals = await deletePlug0008(trx)

  await assertW5EndGates(trx, nonJdy1124Snap)

  return {
    apply: true,
    nonJdyLiveGl: 0,
    cancelled,
    posted,
    deletedJournals,
  }
}

async function countNonJdyLiveDeliveryGl(db: Kysely<Database> | TrxHandle): Promise<number> {
  const rows = await sql<{ c: string }>`
    SELECT count(*)::text AS c
    FROM acc_gl_entry e
    JOIN sal_delivery d ON d.id = e.voucher_id
    WHERE e.voucher_type = ${VOUCHER}
      AND NOT e.is_cancelled
      AND (d.remarks IS NULL OR d.remarks NOT LIKE ${JDY_DELIVERY_REMARKS})
  `.execute(db)
  return Number(rows.rows[0]!.c)
}

async function loadCancelIds(db: Kysely<Database> | TrxHandle, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await sql<{ voucher_id: string }>`
    SELECT DISTINCT e.voucher_id::text AS voucher_id
    FROM acc_gl_entry e
    JOIN sal_delivery d ON d.id = e.voucher_id
    WHERE e.voucher_type = ${VOUCHER}
      AND NOT e.is_cancelled
      AND d.remarks LIKE ${JDY_DELIVERY_REMARKS}
      AND d.id = ANY(${ids}::uuid[])
    ORDER BY 1
  `.execute(db)
  return rows.rows.map((r) => r.voucher_id)
}

async function loadRepostHeads(db: Kysely<Database> | TrxHandle, ids: string[]): Promise<RepostHead[]> {
  if (ids.length === 0) return []
  const rows = await sql<{
    id: string
    company_id: string
    party_type: string
    party_id: string
    debit_account_id: string
    credit_account_id: string
    delivery_date: Date | string
    posting_date: Date | string | null
    delivery_no: string
    raw_amt: string
  }>`
    SELECT d.id::text AS id,
           d.company_id::text AS company_id,
           lower(d.party_type) AS party_type,
           d.party_id::text AS party_id,
           d.debit_account_id::text AS debit_account_id,
           d.credit_account_id::text AS credit_account_id,
           d.delivery_date,
           d.posting_date,
           d.delivery_no,
           SUM((i.qty - i.reconciled_qty) * i.order_price)::text AS raw_amt
    FROM sal_delivery d
    JOIN sal_delivery_item i ON i.delivery_id = d.id
    WHERE lower(d.status) = 'audited'
      AND d.remarks LIKE ${JDY_DELIVERY_REMARKS}
      AND d.id = ANY(${ids}::uuid[])
    GROUP BY d.id
    HAVING SUM((i.qty - i.reconciled_qty) * i.order_price) <> 0
  `.execute(db)
  return rows.rows.map((r) => {
    const deliveryDate = toDateOnly(r.delivery_date)
    return {
      id: r.id,
      companyId: r.company_id,
      partyType: lowerParty(r.party_type),
      partyId: r.party_id,
      debitAccountId: r.debit_account_id,
      creditAccountId: r.credit_account_id,
      deliveryDate,
      postingDate: r.posting_date ? toDateOnly(r.posting_date) : deliveryDate,
      deliveryNo: r.delivery_no,
      rawAmt: decimal(r.raw_amt),
    }
  })
}

function planRepost(heads: RepostHead[]): Array<RepostHead & { amount: string }> {
  const groups = new Map<string, RepostHead[]>()
  for (const head of heads) {
    const key = `${head.companyId}\0${lowerParty(head.partyType)}\0${head.partyId}`
    const list = groups.get(key)
    if (list) list.push(head)
    else groups.set(key, [head])
  }
  const planned: Array<RepostHead & { amount: string }> = []
  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (a.deliveryDate !== b.deliveryDate) return a.deliveryDate < b.deliveryDate ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    let rawSum = decimal(0)
    for (const head of group) rawSum = rawSum.add(head.rawAmt)
    const partyTotal = decimal(roundAmount(rawSum))
    let posted = decimal(0)
    for (let i = 0; i < group.length; i++) {
      const head = group[i]!
      const isLast = i === group.length - 1
      const amount = isLast ? partyTotal.minus(posted) : decimal(roundAmount(head.rawAmt))
      posted = posted.add(amount)
      planned.push({ ...head, amount: roundAmount(amount) })
    }
  }
  return planned
}

async function postRemainHead(trx: TrxHandle, head: RepostHead & { amount: string }): Promise<void> {
  const amount = decimal(head.amount)
  const currencies = await accountCurrencies(trx, head.debitAccountId, head.creditAccountId)
  const debit: GlEntry = {
    accountId: head.debitAccountId,
    currencyId: currencies.debit,
    debit: amount,
    credit: decimal(0),
    partyType: lowerParty(head.partyType),
    partyId: head.partyId,
  }
  const credit: GlEntry = {
    accountId: head.creditAccountId,
    currencyId: currencies.credit,
    debit: decimal(0),
    credit: amount,
  }
  await gl.post(
    trx,
    {
      type: VOUCHER,
      id: head.id,
      no: head.deliveryNo,
      companyId: head.companyId,
      postingDate: head.postingDate,
    },
    [debit, credit],
    amount.isNegative() ? { allowNegative: true } : {},
  )
}

async function loadPlug0008(db: Kysely<Database> | TrxHandle): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT id::text AS id
    FROM acc_gl_journal
    WHERE voucher_no = ${PLUG_0008_VOUCHER_NO}
      AND date = ${PLUG_0008_DATE}::date
    ORDER BY id
  `.execute(db)
  return rows.rows.map((r) => r.id)
}

async function countPlugRecon(db: Kysely<Database> | TrxHandle, journalIds: string[]): Promise<number> {
  if (journalIds.length === 0) return 0
  const rows = await sql<{ c: string }>`
    SELECT count(*)::text AS c
    FROM acc_bank_reconciliation
    WHERE voucher_type = ${JOURNAL_VOUCHER}
      AND voucher_id = ANY(${journalIds}::uuid[])
  `.execute(db)
  return Number(rows.rows[0]!.c)
}

/** ADR 2026-07-09 一次性迁移豁免：只删白名单 0008，顺序 entry→line→audit→journal */
async function deletePlug0008(trx: TrxHandle): Promise<string[]> {
  const journalIds = await loadPlug0008(trx)
  if (journalIds.length === 0) {
    throw new ApiError('conflict', `找不到白名单凭证 ${PLUG_0008_VOUCHER_NO}`)
  }
  const recon = await countPlugRecon(trx, journalIds)
  if (recon > 0) {
    throw new ApiError('conflict', `${PLUG_0008_VOUCHER_NO} 仍被银行对账引用`)
  }

  const lineRows = await sql<{ id: string }>`
    SELECT id::text AS id
    FROM acc_gl_journal_line
    WHERE journal_id = ANY(${journalIds}::uuid[])
  `.execute(trx)
  const lineIds = lineRows.rows.map((r) => r.id)

  await sql`
    DELETE FROM acc_gl_entry
    WHERE voucher_type = ${JOURNAL_VOUCHER}
      AND voucher_id = ANY(${journalIds}::uuid[])
  `.execute(trx)
  await sql`
    DELETE FROM acc_gl_journal_line
    WHERE journal_id = ANY(${journalIds}::uuid[])
  `.execute(trx)
  await sql`
    DELETE FROM sys_audit_log
    WHERE resource IN ('acc_gl_journal', 'accGlJournals')
      AND record_id = ANY(${journalIds}::uuid[])
  `.execute(trx)
  if (lineIds.length > 0) {
    await sql`
      DELETE FROM sys_audit_log
      WHERE resource IN ('acc_gl_journal_line', 'accGlJournalLines')
        AND record_id = ANY(${lineIds}::uuid[])
    `.execute(trx)
  }
  await sql`
    DELETE FROM acc_gl_journal
    WHERE id = ANY(${journalIds}::uuid[])
  `.execute(trx)

  await assertPlug0008Gone(trx, journalIds, lineIds)
  return journalIds
}

async function assertPlug0008Gone(
  trx: TrxHandle,
  journalIds: string[],
  lineIds: string[],
): Promise<void> {
  const journal = await sql<{ c: string }>`
    SELECT count(*)::text AS c FROM acc_gl_journal
    WHERE voucher_no = ${PLUG_0008_VOUCHER_NO} AND date = ${PLUG_0008_DATE}::date
  `.execute(trx)
  const entry = await sql<{ c: string }>`
    SELECT count(*)::text AS c FROM acc_gl_entry
    WHERE voucher_type = ${JOURNAL_VOUCHER} AND voucher_no = ${PLUG_0008_VOUCHER_NO}
  `.execute(trx)
  const line = lineIds.length
    ? await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM acc_gl_journal_line
        WHERE id = ANY(${lineIds}::uuid[])
      `.execute(trx)
    : { rows: [{ c: '0' }] }
  const auditIds = [...journalIds, ...lineIds]
  const audit = auditIds.length
    ? await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM sys_audit_log
        WHERE record_id = ANY(${auditIds}::uuid[])
          AND resource IN ('acc_gl_journal', 'accGlJournals', 'acc_gl_journal_line', 'accGlJournalLines')
      `.execute(trx)
    : { rows: [{ c: '0' }] }
  if (
    Number(journal.rows[0]!.c) !== 0 ||
    Number(entry.rows[0]!.c) !== 0 ||
    Number(line.rows[0]!.c) !== 0 ||
    Number(audit.rows[0]!.c) !== 0
  ) {
    throw new ApiError('conflict', `${PLUG_0008_VOUCHER_NO} 删除后仍有残留`)
  }
}

interface NonJdy1124Row {
  id: string
  debit: string
  credit: string
}

async function loadNonJdyDelivery1124(
  db: Kysely<Database> | TrxHandle,
): Promise<NonJdy1124Row[]> {
  const rows = await sql<NonJdy1124Row>`
    SELECT e.id::text AS id, e.debit::text AS debit, e.credit::text AS credit
    FROM acc_gl_entry e
    JOIN sal_delivery d ON d.id = e.voucher_id
    JOIN bas_account a ON a.id = e.account_id
    WHERE e.voucher_type = ${VOUCHER}
      AND NOT e.is_cancelled
      AND a.code = '1124'
      AND (d.remarks IS NULL OR d.remarks NOT LIKE ${JDY_DELIVERY_REMARKS})
    ORDER BY e.id
  `.execute(db)
  return rows.rows
}

async function assertW5EndGates(trx: TrxHandle, snap: NonJdy1124Row[]): Promise<void> {
  const leftover = await countNonJdyLiveDeliveryGl(trx)
  if (leftover > 0) {
    throw new ApiError('conflict', `结束闸：仍有 ${leftover} 条非简道云备注的未作废发货分录`)
  }

  const foreign1124 = await sql<{ c: string }>`
    SELECT count(*)::text AS c
    FROM acc_gl_entry e
    JOIN bas_account a ON a.id = e.account_id
    WHERE NOT e.is_cancelled
      AND a.code = '1124'
      AND e.voucher_type <> ${VOUCHER}
  `.execute(trx)
  if (Number(foreign1124.rows[0]!.c) > 0) {
    throw new ApiError('conflict', '结束闸：未作废 1124 存在非 sales.delivery 来源')
  }

  const plug = await sql<{ c: string }>`
    SELECT count(*)::text AS c FROM acc_gl_journal
    WHERE voucher_no = ${PLUG_0008_VOUCHER_NO} AND date = ${PLUG_0008_DATE}::date
  `.execute(trx)
  if (Number(plug.rows[0]!.c) > 0) {
    throw new ApiError('conflict', `结束闸：${PLUG_0008_VOUCHER_NO} 仍存在`)
  }

  const mismatch = await sql<{ c: string }>`
    WITH remain AS (
      SELECT d.company_id, lower(d.party_type) AS party_type, d.party_id,
             ROUND(SUM((i.qty - i.reconciled_qty) * i.order_price), 2) AS amt
      FROM sal_delivery d
      JOIN sal_delivery_item i ON i.delivery_id = d.id
      WHERE lower(d.status) = 'audited'
        AND d.remarks LIKE ${JDY_DELIVERY_REMARKS}
      GROUP BY d.company_id, lower(d.party_type), d.party_id
    ),
    posted AS (
      SELECT e.company_id, lower(e.party_type) AS party_type, e.party_id,
             SUM(e.debit - e.credit) AS amt
      FROM acc_gl_entry e
      JOIN bas_account a ON a.id = e.account_id
      JOIN sal_delivery d ON d.id = e.voucher_id
      WHERE e.voucher_type = ${VOUCHER}
        AND NOT e.is_cancelled
        AND a.code = '1124'
        AND d.remarks LIKE ${JDY_DELIVERY_REMARKS}
      GROUP BY e.company_id, lower(e.party_type), e.party_id
    )
    SELECT count(*)::text AS c
    FROM remain r
    FULL OUTER JOIN posted p
      ON p.company_id = r.company_id
     AND p.party_type = r.party_type
     AND p.party_id = r.party_id
    WHERE COALESCE(r.amt, 0) <> COALESCE(p.amt, 0)
  `.execute(trx)
  if (Number(mismatch.rows[0]!.c) > 0) {
    throw new ApiError('conflict', '结束闸：简道云出库头 1124 与剩余未对账不一致')
  }

  const after = await loadNonJdyDelivery1124(trx)
  if (after.length !== snap.length) {
    throw new ApiError('conflict', '结束闸：非简道云出库头 1124 与 W5 前快照不一致')
  }
  for (let i = 0; i < snap.length; i++) {
    const a = snap[i]!
    const b = after[i]!
    if (a.id !== b.id || a.debit !== b.debit || a.credit !== b.credit) {
      throw new ApiError('conflict', '结束闸：非简道云出库头 1124 与 W5 前快照不一致')
    }
  }
}
