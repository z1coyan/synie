/**
 * W4 YHDZ 1121：实质贴现/兑付双计。缺省 dry-run；--apply 才写 synie_replay_check。
 *
 * bun scripts/jdy-replay/w4_1121_yhdz.ts
 * bun scripts/jdy-replay/w4_1121_yhdz.ts --apply
 *
 * 已对账 → 解除 acc_bank_reconciliation → journals.cancel（gl.cancel 整单）
 * → 对账改挂承兑贴现/兑付。无对应借银行/贷 1121 分录的不 cancel。
 */
import { decimal } from '@synie/shared'
import { sql } from 'kysely'
import { withTx, type DbHandle } from '../../server/src/db/tx.ts'
import { reconcileStatus, txnAmount } from '../../server/src/modules/finance/banking-shared.ts'
import { lower } from '../../server/src/modules/finance/common.ts'
import {
  assertReplayUrl,
  createMigrationJournalService,
  createMigrationWorld,
  MIGRATION_ACTOR_ID as ACTOR,
  migrationPermits,
  resolveBackfillDatabaseUrl,
} from './bootstrap.ts'

const WHITELIST_AMT = '2217.64'
const JOURNAL_VOUCHER = 'acc.gl_journal'
const BILL_VOUCHER = 'acc.bill_transaction'

interface CancelItem {
  company: string
  company_id: string
  journal_id: string
  voucher_no: string
  credit: string
  journal_status: string
  recon_id: string
  recon_amount: string
  bank_transaction_id: string
  bank_income: string | null
  bank_expense: string | null
  bank_gl_account_id: string
  extracted: string
  bill_no: string
  ds_id: string
  ds_doc_no: string
  ds_type: string
}

interface WhitelistItem {
  company: string
  voucher_no: string
  credit: string
  reason: string
  extracted: string | null
  bill_no: string | null
  ds_doc_no: string | null
}

interface Snapshot {
  company: string
  gl_1121: string
  holding: string
  hold_n: string
}

function parseArgs(argv: string[]): { apply: boolean; allowProd: boolean } {
  let apply = false
  let dry = false
  let allowProd = false
  for (const arg of argv) {
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') dry = true
    else if (arg === '--allow-prod') allowProd = true
    else throw new Error(`不支持的参数：${arg}（只认 --apply / --dry-run / --allow-prod）`)
  }
  if (apply && dry) throw new Error('不能同时 --apply 与 --dry-run')
  return { apply, allowProd }
}

const CANCEL_SQL = sql<CancelItem>`
SELECT
  CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
  co.id::text AS company_id,
  j.id::text AS journal_id,
  j.voucher_no,
  e.credit::text AS credit,
  j.status AS journal_status,
  r.id::text AS recon_id,
  r.amount::text AS recon_amount,
  r.bank_transaction_id::text AS bank_transaction_id,
  bt.income::text AS bank_income,
  bt.expense::text AS bank_expense,
  ba.account_id::text AS bank_gl_account_id,
  x.extracted,
  b.bill_no,
  t.id::text AS ds_id,
  t.doc_no AS ds_doc_no,
  t.transaction_type AS ds_type
FROM acc_gl_entry e
JOIN bas_account a ON a.id = e.account_id
JOIN bas_company co ON co.id = e.company_id
JOIN acc_gl_journal j ON j.id = e.voucher_id
JOIN acc_bank_reconciliation r ON r.voucher_type = ${JOURNAL_VOUCHER} AND r.voucher_id = j.id
JOIN acc_bank_transaction bt ON bt.id = r.bank_transaction_id
JOIN acc_bank_account ba ON ba.id = bt.bank_account_id
JOIN LATERAL (
  SELECT COALESCE(
    (regexp_match(COALESCE(e.remarks, j.remarks, ''), '票号[：:]\s*([0-9]{16,40})'))[1],
    (regexp_match(COALESCE(e.remarks, j.remarks, ''), '([0-9]{20,40})'))[1]
  ) AS extracted
) x ON true
JOIN acc_bill b ON b.bill_no = x.extracted
  OR (length(x.extracted) = 20 AND b.bill_no LIKE x.extracted || '%')
JOIN acc_bill_transaction t ON t.bill_id = b.id AND t.company_id = j.company_id
  AND t.transaction_type IN ('discount','settle') AND t.status = 'audited'
WHERE e.voucher_type = ${JOURNAL_VOUCHER}
  AND NOT e.is_cancelled
  AND a.code = '1121'
  AND (COALESCE(e.remarks,'') LIKE '%YHDZ%' OR COALESCE(j.remarks,'') LIKE '%YHDZ%')
  AND e.credit = t.amount
  AND e.credit <> ${WHITELIST_AMT}::numeric
  AND (
    b.bill_no = x.extracted
    OR (SELECT count(*) FROM acc_bill b2 WHERE length(x.extracted)=20 AND b2.bill_no LIKE x.extracted || '%') = 1
  )
  AND EXISTS (
    SELECT 1 FROM acc_gl_entry ge
    WHERE ge.voucher_type = ${BILL_VOUCHER} AND ge.voucher_id = t.id
      AND NOT ge.is_cancelled AND ge.account_id = ba.account_id AND ge.debit > 0
  )
`

async function loadSnapshot(db: DbHandle): Promise<Snapshot[]> {
  const rows = await sql<Snapshot>`
    WITH gl AS (
      SELECT
        CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
        ROUND(SUM(e.debit - e.credit), 2)::text AS gl_1121
      FROM acc_gl_entry e
      JOIN bas_account a ON a.id = e.account_id
      JOIN bas_company co ON co.id = e.company_id
      WHERE NOT e.is_cancelled AND a.code = '1121'
      GROUP BY 1
    ),
    hold AS (
      SELECT
        CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
        ROUND(SUM(h.amount), 2)::text AS holding,
        COUNT(*)::text AS hold_n
      FROM acc_bill_holding h
      JOIN bas_company co ON co.id = h.company_id
      GROUP BY 1
    )
    SELECT COALESCE(g.company, h.company) AS company,
      COALESCE(g.gl_1121, '0') AS gl_1121,
      COALESCE(h.holding, '0') AS holding,
      COALESCE(h.hold_n, '0') AS hold_n
    FROM gl g
    FULL OUTER JOIN hold h ON h.company = g.company
    ORDER BY 1
  `.execute(db)
  return rows.rows
}

async function loadWhitelist(db: DbHandle, cancelIds: Set<string>): Promise<WhitelistItem[]> {
  const rows = await sql<{
    journal_id: string
    company: string
    voucher_no: string
    credit: string
    remarks: string
    extracted: string | null
  }>`
    SELECT
      j.id::text AS journal_id,
      CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
      j.voucher_no,
      e.credit::text AS credit,
      COALESCE(e.remarks, j.remarks, '') AS remarks,
      COALESCE(
        (regexp_match(COALESCE(e.remarks, j.remarks, ''), '票号[：:]\s*([0-9]{16,40})'))[1],
        (regexp_match(COALESCE(e.remarks, j.remarks, ''), '([0-9]{20,40})'))[1]
      ) AS extracted
    FROM acc_gl_entry e
    JOIN bas_account a ON a.id = e.account_id
    JOIN bas_company co ON co.id = e.company_id
    JOIN acc_gl_journal j ON j.id = e.voucher_id
    WHERE e.voucher_type = ${JOURNAL_VOUCHER}
      AND NOT e.is_cancelled
      AND a.code = '1121'
      AND (COALESCE(e.remarks,'') LIKE '%YHDZ%' OR COALESCE(j.remarks,'') LIKE '%YHDZ%')
    ORDER BY 2, j.voucher_no
  `.execute(db)

  const items: WhitelistItem[] = []
  for (const row of rows.rows) {
    if (cancelIds.has(row.journal_id)) continue

    let reason = '无对应承兑贴现/兑付（借银行/贷1121）分录'
    if (row.credit === WHITELIST_AMT) {
      reason = '白名单 2217.64（同票另一段无贴现单）'
    } else if (row.extracted) {
      const ds = await sql<{ doc_no: string; gl: string }>`
        SELECT t.doc_no,
          (SELECT string_agg(a.code, ',') FROM acc_gl_entry ge
           JOIN bas_account a ON a.id = ge.account_id
           WHERE ge.voucher_type = ${BILL_VOUCHER} AND ge.voucher_id = t.id
             AND NOT ge.is_cancelled AND ge.debit > 0) AS gl
        FROM acc_bill b
        JOIN acc_bill_transaction t ON t.bill_id = b.id
          AND t.transaction_type IN ('discount','settle') AND t.status = 'audited'
        WHERE b.bill_no = ${row.extracted}
           OR (length(${row.extracted})=20 AND b.bill_no LIKE ${row.extracted} || '%')
        LIMIT 1
      `.execute(db)
      const hit = ds.rows[0]
      if (hit?.gl?.includes('3104') && !hit.gl.match(/1002/)) {
        reason = `有兑付 ${hit.doc_no} 但分录借 3104 非银行，取消会丢掉银行借方`
      }
    }
    items.push({
      company: row.company,
      voucher_no: row.voucher_no,
      credit: row.credit,
      reason,
      extracted: row.extracted,
      bill_no: null,
      ds_doc_no: null,
    })
  }
  return items
}

async function refreshBankTxn(
  db: DbHandle,
  bankTransactionId: string,
  income: string | null,
  expense: string | null,
): Promise<void> {
  const used = await sql<{ s: string }>`
    SELECT COALESCE(sum(amount),0)::text AS s
    FROM acc_bank_reconciliation
    WHERE bank_transaction_id = ${bankTransactionId}::uuid
  `.execute(db)
  const total = decimal(used.rows[0]?.s ?? '0')
  const amount = txnAmount(income, expense)
  const remaining = amount.sub(total)
  const status = lower(reconcileStatus(total, amount))
  const result = await sql`
    UPDATE acc_bank_transaction SET
      reconciled_amount = ${total.toFixed()}::numeric,
      unreconciled_amount = ${remaining.toFixed()}::numeric,
      reconcile_status = ${status},
      updated_at = timezone('utc', now())
    WHERE id = ${bankTransactionId}::uuid
  `.execute(db)
  if (Number(result.numAffectedRows) !== 1) {
    throw new Error(`刷新银行流水失败 ${bankTransactionId}`)
  }
}

async function unlinkRecon(db: DbHandle, item: CancelItem): Promise<number> {
  const del = await sql<{ id: string }>`
    DELETE FROM acc_bank_reconciliation
    WHERE voucher_type = ${JOURNAL_VOUCHER} AND voucher_id = ${item.journal_id}::uuid
    RETURNING id::text
  `.execute(db)
  const n = del.rows.length
  if (n !== 1) {
    throw new Error(`${item.voucher_no} 解除对账断言失败：期望 1 行，实际 ${n}`)
  }
  const unlinkChanges = JSON.stringify({
    voucher_type: JOURNAL_VOUCHER,
    voucher_id: item.journal_id,
    amount: item.recon_amount,
    bank_transaction_id: item.bank_transaction_id,
  })
  await sql`
    INSERT INTO sys_audit_log (resource, record_id, record_label, action_type, action_name, actor_id, company_id, changes)
    VALUES (
      'acc_bank_reconciliation', ${item.recon_id}::uuid,
      ${`${item.bank_transaction_id}/${item.voucher_no}`},
      'destroy', 'w4_1121_unlink_yhdz', ${ACTOR}::uuid, ${item.company_id}::uuid,
      ${unlinkChanges}::jsonb
    )
  `.execute(db)
  await refreshBankTxn(db, item.bank_transaction_id, item.bank_income, item.bank_expense)
  return n
}

async function restoreRecon(db: DbHandle, item: CancelItem): Promise<void> {
  await sql`
    INSERT INTO acc_bank_reconciliation (
      id, amount, company_id, bank_transaction_id, voucher_type, voucher_id, voucher_no
    ) VALUES (
      ${item.recon_id}::uuid, ${item.recon_amount}::numeric, ${item.company_id}::uuid,
      ${item.bank_transaction_id}::uuid, ${JOURNAL_VOUCHER}, ${item.journal_id}::uuid, ${item.voucher_no}
    )
  `.execute(db)
  await refreshBankTxn(db, item.bank_transaction_id, item.bank_income, item.bank_expense)
}

async function relinkToBill(
  db: DbHandle,
  item: CancelItem,
): Promise<'relinked' | 'no_capacity' | 'already'> {
  const existing = await sql<{ e: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM acc_bank_reconciliation
      WHERE bank_transaction_id = ${item.bank_transaction_id}::uuid
    ) AS e
  `.execute(db)
  if (existing.rows[0]?.e) return 'already'

  const cap = await sql<{ total: string; used: string }>`
    SELECT
      COALESCE((
        SELECT sum(ge.debit) FROM acc_gl_entry ge
        WHERE ge.voucher_type = ${BILL_VOUCHER} AND ge.voucher_id = ${item.ds_id}::uuid
          AND NOT ge.is_cancelled AND ge.account_id = ${item.bank_gl_account_id}::uuid
      ), 0)::text AS total,
      COALESCE((
        SELECT sum(r.amount) FROM acc_bank_reconciliation r
        JOIN acc_bank_transaction t ON t.id = r.bank_transaction_id
        JOIN acc_bank_account b ON b.id = t.bank_account_id
        WHERE r.voucher_type = ${BILL_VOUCHER} AND r.voucher_id = ${item.ds_id}::uuid
          AND b.account_id = ${item.bank_gl_account_id}::uuid
      ), 0)::text AS used
  `.execute(db)
  const total = decimal(cap.rows[0]?.total ?? '0')
  const used = decimal(cap.rows[0]?.used ?? '0')
  const need = decimal(item.recon_amount)
  if (total.sub(used).lt(need)) return 'no_capacity'

  await sql`
    INSERT INTO acc_bank_reconciliation (
      amount, company_id, bank_transaction_id, voucher_type, voucher_id, voucher_no
    ) VALUES (
      ${item.recon_amount}::numeric, ${item.company_id}::uuid,
      ${item.bank_transaction_id}::uuid, ${BILL_VOUCHER}, ${item.ds_id}::uuid, ${item.ds_doc_no}
    )
  `.execute(db)
  const relinkChanges = JSON.stringify({
    voucher_type: BILL_VOUCHER,
    voucher_id: item.ds_id,
    amount: item.recon_amount,
    from_journal: item.voucher_no,
  })
  await sql`
    INSERT INTO sys_audit_log (resource, record_id, record_label, action_type, action_name, actor_id, company_id, changes)
    SELECT 'acc_bank_reconciliation', r.id, ${`${item.bank_transaction_id}/${item.ds_doc_no}`},
      'create', 'w4_1121_relink_bill', ${ACTOR}::uuid, ${item.company_id}::uuid,
      ${relinkChanges}::jsonb
    FROM acc_bank_reconciliation r
    WHERE r.bank_transaction_id = ${item.bank_transaction_id}::uuid
      AND r.voucher_type = ${BILL_VOUCHER} AND r.voucher_id = ${item.ds_id}::uuid
  `.execute(db)
  await refreshBankTxn(db, item.bank_transaction_id, item.bank_income, item.bank_expense)
  return 'relinked'
}

async function assertGuards(
  db: DbHandle,
  holdingBefore: Snapshot[],
  arBefore: { n: string; amt: string },
): Promise<void> {
  const holdingAfter = await loadSnapshot(db)
  const holdMap = new Map(holdingBefore.map((s) => [s.company, s]))
  for (const row of holdingAfter) {
    const before = holdMap.get(row.company)
    if (!before) continue
    if (before.holding !== row.holding || before.hold_n !== row.hold_n) {
      throw new Error(`持有被改动：${row.company} ${before.hold_n}/${before.holding} → ${row.hold_n}/${row.holding}`)
    }
  }
  const ar = await sql<{ n: string; amt: string }>`
    SELECT COUNT(*)::text AS n, ROUND(SUM(e.debit-e.credit),2)::text AS amt
    FROM acc_gl_entry e
    JOIN bas_account a ON a.id = e.account_id
    WHERE NOT e.is_cancelled AND a.code = '1122' AND e.party_type = 'customer'
  `.execute(db)
  const after = ar.rows[0]!
  if (after.n !== arBefore.n || after.amt !== arBefore.amt) {
    throw new Error(`1122 客户往来被改动：${arBefore.n}/${arBefore.amt} → ${after.n}/${after.amt}`)
  }
}

export async function main(argv: string[]): Promise<void> {
  const { apply, allowProd } = parseArgs(argv)
  const url = resolveBackfillDatabaseUrl()
  assertReplayUrl(url, allowProd)
  const world = createMigrationWorld(url)
  const db = world.db
  try {
    const before = await loadSnapshot(db)
    const arBefore = (
      await sql<{ n: string; amt: string }>`
        SELECT COUNT(*)::text AS n, ROUND(SUM(e.debit-e.credit),2)::text AS amt
        FROM acc_gl_entry e
        JOIN bas_account a ON a.id = e.account_id
        WHERE NOT e.is_cancelled AND a.code = '1122' AND e.party_type = 'customer'
      `.execute(db)
    ).rows[0]!

    const cancelRows = (await CANCEL_SQL.execute(db)).rows
    const cancelIds = new Set(cancelRows.map((r) => r.journal_id))
    if (cancelIds.size !== cancelRows.length) {
      throw new Error('cancel 集 journal_id 不唯一')
    }
    const dsIds = cancelRows.map((r) => r.ds_id)
    if (new Set(dsIds).size !== dsIds.length) {
      throw new Error('cancel 集 ds_id 不唯一')
    }

    const whitelist = await loadWhitelist(db, cancelIds)
    const byCo = (items: { company: string; credit: string }[]) => {
      const m = new Map<string, { n: number; amt: ReturnType<typeof decimal> }>()
      for (const it of items) {
        const cur = m.get(it.company) ?? { n: 0, amt: decimal(0) }
        cur.n += 1
        cur.amt = cur.amt.add(decimal(it.credit))
        m.set(it.company, cur)
      }
      return m
    }
    const cancelBy = byCo(cancelRows)
    const whiteBy = byCo(whitelist)

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'w4_1121_start',
        apply,
        before,
        cancel: Object.fromEntries(
          [...cancelBy].map(([k, v]) => [k, { n: v.n, amt: v.amt.toFixed() }]),
        ),
        whitelist: Object.fromEntries(
          [...whiteBy].map(([k, v]) => [k, { n: v.n, amt: v.amt.toFixed() }]),
        ),
      }),
    )
    for (const row of cancelRows) {
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'w4_1121_cancel_plan',
          company: row.company,
          voucher: row.voucher_no,
          credit: row.credit,
          bill_no: row.bill_no,
          ds: row.ds_doc_no,
          ds_type: row.ds_type,
        }),
      )
    }
    if (!apply) {
      console.log(JSON.stringify({ level: 'info', msg: 'w4_1121_dry_run', whitelist: whitelist.length }))
      return
    }

    const journals = createMigrationJournalService(world)
    const permit = migrationPermits.journalCancel()

    const counts = { cancel: 0, relink: 0, cancel_no_relink: 0, skip: 0, error: 0 }
    const noRelink: string[] = []

    for (const item of cancelRows) {
      try {
        if (item.journal_status === 'cancelled') {
          counts.skip++
          console.log(JSON.stringify({ level: 'info', msg: 'w4_1121_skip_cancelled', voucher: item.voucher_no }))
          continue
        }
        const unlinked = await withTx(db, (trx) => unlinkRecon(trx, item))
        console.log(
          JSON.stringify({
            level: 'info',
            msg: 'w4_1121_unlinked',
            voucher: item.voucher_no,
            recon_deleted: unlinked,
          }),
        )
        try {
          await journals.cancel(permit, item.journal_id)
        } catch (err) {
          await withTx(db, (trx) => restoreRecon(trx, item))
          throw err
        }
        counts.cancel++
        const relink = await withTx(db, (trx) => relinkToBill(trx, item))
        if (relink === 'relinked') {
          counts.relink++
          console.log(
            JSON.stringify({
              level: 'info',
              msg: 'w4_1121_relinked',
              voucher: item.voucher_no,
              ds: item.ds_doc_no,
            }),
          )
        } else {
          counts.cancel_no_relink++
          noRelink.push(`${item.voucher_no}→${item.ds_doc_no} (${relink})`)
          console.log(
            JSON.stringify({
              level: 'warn',
              msg: 'w4_1121_cancel_no_relink',
              voucher: item.voucher_no,
              ds: item.ds_doc_no,
              reason: relink,
            }),
          )
        }
      } catch (err) {
        counts.error++
        const detail = err instanceof Error ? err.message : String(err)
        console.log(JSON.stringify({ level: 'error', msg: 'w4_1121_failed', voucher: item.voucher_no, error: detail }))
      }
    }

    await assertGuards(db, before, arBefore)
    const after = await loadSnapshot(db)
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'w4_1121_done',
        ...counts,
        after,
        no_relink: noRelink,
      }),
    )
    if (counts.error > 0) process.exitCode = 1
  } finally {
    await db.destroy()
  }
}
