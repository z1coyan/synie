/**
 * 钉 1121：科目 = 持有 ± 白名单 2217.64；白名单外 journal 1121 = 0。
 * 缺省 dry-run；--apply 才写。生产必须 --allow-prod。
 *
 * 不做：replayBill / void 持有 / INSERT acc_gl_entry / 找平 / 动 1122 净额。
 *
 * bun scripts/jdy-replay/w4_1121_nail.ts
 * bun scripts/jdy-replay/w4_1121_nail.ts --apply
 * bun scripts/jdy-replay/w4_1121_nail.ts --apply --allow-prod
 */
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { createJournalService } from '~/modules/accounting/journal-service.ts'
import { isJournalLinkedToBankRecon } from '~/modules/finance/banking-recon.ts'
import { systemPermit } from '~/platform/authz/core/index.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { resolveBackfillDatabaseUrl } from './backfill-cli.ts'

const ACTOR = '99e3e4f6-e208-4bb9-904c-72299808a8e7'
const KEEP_VOUCHER = 'A(J)-20260514-0030'
const KEEP_AMT = '2217.64'
const JOURNAL = 'acc.gl_journal'
const BILL_TX = 'acc.bill_transaction'
const WASH_DOCS = ['A(B)-20260608-0002', 'A(B)-20260608-0004'] as const
const PLUG_VOUCHERS = ['A(J)-20191203-0001', 'A(J)-20191231-0001'] as const

interface Snapshot {
  company: string
  gl_1121: string
  holding: string
  hold_n: string
}

function dsnHost(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port}${u.pathname}`
  } catch {
    return '(unparseable)'
  }
}

function assertReplayUrl(url: string, allowProd: boolean): void {
  const isReplay = url.includes('synie_replay_check') && url.includes(':5441')
  const isProd = /100\.82\.52\.74|:26002/.test(url) && /\/synie(\?|$)/.test(url)
  if (allowProd) {
    if (!isProd) throw new Error(`--allow-prod 只允许生产 DSN，当前 ${dsnHost(url)}`)
    return
  }
  if (!isReplay) throw new Error(`禁止非彩排库：${dsnHost(url)}（生产请加 --allow-prod）`)
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

async function loadSnapshot(db: DbHandle): Promise<Snapshot[]> {
  const rows = await sql<Snapshot>`
    WITH gl AS (
      SELECT CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
             ROUND(SUM(e.debit - e.credit), 2)::text AS gl_1121
      FROM acc_gl_entry e
      JOIN bas_account a ON a.id = e.account_id
      JOIN bas_company co ON co.id = e.company_id
      WHERE NOT e.is_cancelled AND a.code = '1121'
      GROUP BY 1
    ),
    hold AS (
      SELECT CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
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
    FROM gl g FULL OUTER JOIN hold h ON h.company = g.company
    ORDER BY 1
  `.execute(db)
  return rows.rows
}

async function ar1122(db: DbHandle): Promise<{ n: string; amt: string }> {
  const rows = await sql<{ n: string; amt: string }>`
    SELECT COUNT(*)::text AS n, ROUND(SUM(e.debit - e.credit), 2)::text AS amt
    FROM acc_gl_entry e
    JOIN bas_account a ON a.id = e.account_id
    WHERE NOT e.is_cancelled AND a.code = '1122' AND e.party_type = 'customer'
  `.execute(db)
  return rows.rows[0]!
}

async function accountId(db: DbHandle, companyId: string, code: string): Promise<string> {
  const rows = await sql<{ id: string }>`
    SELECT id::text FROM bas_account
    WHERE company_id = ${companyId}::uuid AND code = ${code}
  `.execute(db)
  const id = rows.rows[0]?.id
  if (!id) throw new Error(`科目 ${code} 不存在 ${companyId}`)
  return id
}

async function audit(
  db: DbHandle,
  recordId: string,
  label: string,
  companyId: string,
  action: string,
  changes: unknown,
): Promise<void> {
  const payload = JSON.stringify(changes)
  await sql`
    INSERT INTO sys_audit_log (resource, record_id, record_label, action_type, action_name, actor_id, company_id, changes)
    VALUES (
      'acc_gl_entry', ${recordId}::uuid, ${label},
      'update', ${action}, ${ACTOR}::uuid, ${companyId}::uuid, ${payload}::jsonb
    )
  `.execute(db)
}

export async function main(argv: string[]): Promise<void> {
  const { apply, allowProd } = parseArgs(argv)
  const url = resolveBackfillDatabaseUrl()
  assertReplayUrl(url, allowProd)
  const db = createDb(url)
  try {
    const before = await loadSnapshot(db)
    const arBefore = await ar1122(db)

    const yhd = await sql<{
      entry_id: string
      journal_id: string
      voucher_no: string
      company_id: string
      company: string
      credit: string
      w4j_id: string | null
      w4j_party: string | null
    }>`
      SELECT
        e.id::text AS entry_id,
        j.id::text AS journal_id,
        j.voucher_no,
        e.company_id::text AS company_id,
        CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
        e.credit::text AS credit,
        w.id::text AS w4j_id,
        w1122.party_id::text AS w4j_party
      FROM acc_gl_entry e
      JOIN bas_account a ON a.id = e.account_id
      JOIN acc_gl_journal j ON j.id = e.voucher_id
      JOIN bas_company co ON co.id = e.company_id
      LEFT JOIN acc_gl_journal w
        ON w.company_id = j.company_id
       AND w.status = 'audited'
       AND w.remarks LIKE 'W4J 1121→1122 ' || j.voucher_no || '%'
      LEFT JOIN acc_gl_entry w1122
        ON w1122.voucher_type = ${JOURNAL} AND w1122.voucher_id = w.id
       AND NOT w1122.is_cancelled AND w1122.credit > 0
      LEFT JOIN bas_account wa ON wa.id = w1122.account_id AND wa.code = '1122'
      WHERE e.voucher_type = ${JOURNAL}
        AND NOT e.is_cancelled AND a.code = '1121' AND e.credit > 0
        AND j.remarks LIKE 'YHDZ%'
        AND j.voucher_no IS DISTINCT FROM ${KEEP_VOUCHER}
        AND e.credit IS DISTINCT FROM ${KEEP_AMT}::numeric
      ORDER BY j.voucher_no, e.company_id
    `.execute(db)

    const offsets = await sql<{
      journal_id: string
      voucher_no: string
      company_id: string
      company: string
      debit: string
      status: string
    }>`
      SELECT
        j.id::text AS journal_id,
        j.voucher_no,
        j.company_id::text AS company_id,
        CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
        e.debit::text AS debit,
        j.status
      FROM acc_gl_entry e
      JOIN bas_account a ON a.id = e.account_id
      JOIN acc_gl_journal j ON j.id = e.voucher_id
      JOIN bas_company co ON co.id = j.company_id
      WHERE e.voucher_type = ${JOURNAL}
        AND NOT e.is_cancelled AND a.code = '1121' AND e.debit > 0
        AND (j.voucher_no LIKE 'A(J)-R21B-%' OR j.voucher_no LIKE 'A(J)-R21-%')
        AND j.status = 'audited'
      ORDER BY j.voucher_no
    `.execute(db)

    const plugs = await sql<{
      entry_id: string
      voucher_no: string
      company_id: string
      company: string
      debit: string
    }>`
      SELECT
        e.id::text AS entry_id,
        j.voucher_no,
        e.company_id::text AS company_id,
        CASE WHEN co.code IN ('JT','京泰') THEN '京泰' ELSE '东方' END AS company,
        e.debit::text AS debit
      FROM acc_gl_entry e
      JOIN bas_account a ON a.id = e.account_id
      JOIN acc_gl_journal j ON j.id = e.voucher_id
      JOIN bas_company co ON co.id = e.company_id
      WHERE e.voucher_type = ${JOURNAL}
        AND NOT e.is_cancelled AND a.code = '1121' AND e.debit > 0
        AND j.voucher_no IN (${sql.join(PLUG_VOUCHERS.map((v) => sql`${v}`))})
    `.execute(db)

    const w4j = await sql<{
      journal_id: string
      voucher_no: string
      company_id: string
      status: string
      debit: string
    }>`
      SELECT j.id::text AS journal_id, j.voucher_no, j.company_id::text AS company_id,
             j.status, e.debit::text AS debit
      FROM acc_gl_journal j
      JOIN acc_gl_entry e ON e.voucher_type = ${JOURNAL} AND e.voucher_id = j.id
      JOIN bas_account a ON a.id = e.account_id
      WHERE j.voucher_no = 'A(J)-20201130-W4J23'
        AND NOT e.is_cancelled AND a.code = '1121' AND j.status = 'audited'
    `.execute(db)

    const wash = await sql<{
      entry_id: string
      doc_no: string
      tx_id: string
      company_id: string
      credit: string
      settle_account_id: string
    }>`
      SELECT e.id::text AS entry_id, t.doc_no, t.id::text AS tx_id,
             t.company_id::text AS company_id, e.credit::text AS credit,
             t.settle_account_id::text AS settle_account_id
      FROM acc_bill_transaction t
      JOIN acc_gl_entry e ON e.voucher_type = ${BILL_TX} AND e.voucher_id = t.id
      JOIN bas_account a ON a.id = e.account_id
      WHERE t.doc_no IN (${sql.join(WASH_DOCS.map((v) => sql`${v}`))})
        AND NOT e.is_cancelled AND a.code = '1121' AND e.credit > 0
    `.execute(db)

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'w4_1121_nail_start',
        apply,
        dsn: dsnHost(url),
        before,
        ar_1122: arBefore,
        yhd_n: yhd.rows.length,
        offset_n: offsets.rows.length,
        plug_n: plugs.rows.length,
        w4j_n: w4j.rows.length,
        wash_n: wash.rows.length,
        yhd_to_1122: yhd.rows.filter((r) => r.w4j_id).map((r) => r.voucher_no),
      }),
    )

    if (!apply) {
      console.log(JSON.stringify({ level: 'info', msg: 'w4_1121_nail_dry_run' }))
      return
    }

    const registry = createSealedResourceRegistry()
    const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
    const gl = createGlEngine()
    const journals = createJournalService(db, numbering, gl, registry, { isJournalLinkedToBankRecon })
    const permit = systemPermit('accGlJournals', 'cancel')

    let yhd3104 = 0
    let yhd1122 = 0
    for (const row of yhd.rows) {
      await withTx(db, async (trx) => {
        const toCode = row.w4j_id ? '1122' : '3104'
        const toId = await accountId(trx, row.company_id, toCode)
        const old = await sql<{
          account_id: string
          debit: string
          credit: string
          voucher_id: string
        }>`
          SELECT account_id::text, debit::text, credit::text, voucher_id::text
          FROM acc_gl_entry WHERE id = ${row.entry_id}::uuid
        `.execute(trx)
        const prev = old.rows[0]
        if (!prev) throw new Error(`分录不存在 ${row.entry_id}`)
        const line = await sql`
          UPDATE acc_gl_journal_line SET
            account_id = ${toId}::uuid,
            party_type = ${row.w4j_id ? 'customer' : null},
            party_id = ${row.w4j_party}::uuid,
            updated_at = timezone('utc', now())
          WHERE journal_id = ${prev.voucher_id}::uuid
            AND account_id = ${prev.account_id}::uuid
            AND debit = ${prev.debit}::numeric
            AND credit = ${prev.credit}::numeric
        `.execute(trx)
        if (Number(line.numAffectedRows) !== 1) {
          throw new Error(`${row.voucher_no} journal_line 改挂断言失败 ${line.numAffectedRows}`)
        }
        const ent = await sql`
          UPDATE acc_gl_entry SET
            account_id = ${toId}::uuid,
            party_type = ${row.w4j_id ? 'customer' : null},
            party_id = ${row.w4j_party}::uuid
          WHERE id = ${row.entry_id}::uuid
        `.execute(trx)
        if (Number(ent.numAffectedRows) !== 1) throw new Error(`${row.voucher_no} entry 改挂失败`)
        await audit(trx, row.entry_id, row.voucher_no, row.company_id, 'w4_1121_nail_yhd', {
          from: '1121',
          to: toCode,
          credit: row.credit,
        })
      })
      if (row.w4j_id) yhd1122++
      else yhd3104++
    }

    for (const row of plugs.rows) {
      await withTx(db, async (trx) => {
        const toId = await accountId(trx, row.company_id, '3104')
        const old = await sql<{
          account_id: string
          debit: string
          credit: string
          voucher_id: string
        }>`
          SELECT account_id::text, debit::text, credit::text, voucher_id::text
          FROM acc_gl_entry WHERE id = ${row.entry_id}::uuid
        `.execute(trx)
        const prev = old.rows[0]
        if (!prev) throw new Error(`补记分录不存在 ${row.entry_id}`)
        const line = await sql`
          UPDATE acc_gl_journal_line SET
            account_id = ${toId}::uuid,
            updated_at = timezone('utc', now())
          WHERE journal_id = ${prev.voucher_id}::uuid
            AND account_id = ${prev.account_id}::uuid
            AND debit = ${prev.debit}::numeric
            AND credit = ${prev.credit}::numeric
        `.execute(trx)
        if (Number(line.numAffectedRows) !== 1) {
          throw new Error(`${row.voucher_no} 补记 line 断言失败`)
        }
        const ent = await sql`
          UPDATE acc_gl_entry SET account_id = ${toId}::uuid
          WHERE id = ${row.entry_id}::uuid
        `.execute(trx)
        if (Number(ent.numAffectedRows) !== 1) throw new Error(`${row.voucher_no} 补记 entry 失败`)
        await audit(trx, row.entry_id, row.voucher_no, row.company_id, 'w4_1121_nail_plug', {
          from: '1121',
          to: '3104',
          debit: row.debit,
        })
      })
    }

    for (const row of wash.rows) {
      await withTx(db, async (trx) => {
        const toId = await accountId(trx, row.company_id, '3104')
        const ent = await sql`
          UPDATE acc_gl_entry SET account_id = ${toId}::uuid
          WHERE id = ${row.entry_id}::uuid AND credit > 0
        `.execute(trx)
        if (Number(ent.numAffectedRows) !== 1) throw new Error(`${row.doc_no} 接收贷方改挂失败`)
        const tx = await sql`
          UPDATE acc_bill_transaction SET
            settle_account_id = ${toId}::uuid,
            updated_at = timezone('utc', now())
          WHERE id = ${row.tx_id}::uuid
        `.execute(trx)
        if (Number(tx.numAffectedRows) !== 1) throw new Error(`${row.doc_no} settle_account 失败`)
        await audit(trx, row.entry_id, row.doc_no, row.company_id, 'w4_1121_nail_wash', {
          from: '1121',
          to: '3104',
          credit: row.credit,
        })
      })
    }

    const counts = { cancel_offset: 0, cancel_w4j: 0, skip: 0, error: 0 }
    const errors: string[] = []
    for (const row of offsets.rows) {
      try {
        if (row.status !== 'audited') {
          counts.skip++
          continue
        }
        await journals.cancel(permit, row.journal_id)
        counts.cancel_offset++
      } catch (err) {
        counts.error++
        const detail = err instanceof Error ? err.message : String(err)
        errors.push(`${row.voucher_no}: ${detail}`)
        console.log(JSON.stringify({ level: 'error', msg: 'w4_1121_nail_cancel_failed', voucher: row.voucher_no, error: detail }))
      }
    }
    for (const row of w4j.rows) {
      try {
        await journals.cancel(permit, row.journal_id)
        counts.cancel_w4j++
      } catch (err) {
        counts.error++
        const detail = err instanceof Error ? err.message : String(err)
        errors.push(`${row.voucher_no}: ${detail}`)
        console.log(JSON.stringify({ level: 'error', msg: 'w4_1121_nail_cancel_failed', voucher: row.voucher_no, error: detail }))
      }
    }

    const holdingAfter = await loadSnapshot(db)
    const holdMap = new Map(before.map((s) => [s.company, s]))
    for (const row of holdingAfter) {
      const prev = holdMap.get(row.company)
      if (!prev) continue
      if (prev.holding !== row.holding || prev.hold_n !== row.hold_n) {
        throw new Error(`持有被改动：${row.company} ${prev.hold_n}/${prev.holding} → ${row.hold_n}/${row.holding}`)
      }
    }
    const arAfter = await ar1122(db)
    if (arAfter.n !== arBefore.n || arAfter.amt !== arBefore.amt) {
      throw new Error(`1122 客户往来被改动：${arBefore.n}/${arBefore.amt} → ${arAfter.n}/${arAfter.amt}`)
    }

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'w4_1121_nail_done',
        yhd_to_3104: yhd3104,
        yhd_to_1122: yhd1122,
        plug: plugs.rows.length,
        wash: wash.rows.length,
        ...counts,
        after: holdingAfter,
        errors,
      }),
    )
    if (counts.error > 0) process.exitCode = 1
  } finally {
    await db.destroy()
  }
}
