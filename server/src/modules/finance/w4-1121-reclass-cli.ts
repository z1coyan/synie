/**
 * 剩余未作废 YHDZ 1121 贷方：同日 借1121 / 贷3104。
 * 不 cancel 原 YHDZ（保住银行借方），不碰 1122。
 */
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { resolveBackfillDatabaseUrl } from './backfill-cli.ts'

const ACTOR = '99e3e4f6-e208-4bb9-904c-72299808a8e7'
const KEEP = 'A(J)-20260514-0030'
const gl = createGlEngine()

export async function main(argv: string[]): Promise<void> {
  const apply = argv.includes('--apply')
  if (apply && argv.includes('--dry-run')) throw new Error('不能同时 --apply 与 --dry-run')
  const db = createDb(resolveBackfillDatabaseUrl())
  try {
    const rows = await sql<{
      voucher_no: string
      posting_date: string
      company_id: string
      company: string
      amt: string
      a1121: string
      a3104: string
    }>`
      WITH yhd AS (
        SELECT j.voucher_no, MIN(e.posting_date)::text AS posting_date,
               e.company_id, co.code AS company,
               ROUND(SUM(e.credit - e.debit), 2) AS yhd
        FROM acc_gl_entry e
        JOIN bas_account a ON a.id = e.account_id
        JOIN acc_gl_journal j ON j.id = e.voucher_id AND e.voucher_type = 'acc.gl_journal'
        JOIN bas_company co ON co.id = e.company_id
        WHERE NOT e.is_cancelled AND a.code = '1121'
          AND j.remarks LIKE 'YHDZ%'
          AND j.voucher_no IS DISTINCT FROM ${KEEP}
        GROUP BY j.voucher_no, e.company_id, co.code
      ), r21 AS (
        SELECT CASE
                 WHEN j.voucher_no LIKE 'A(J)-R21B-%' THEN replace(j.voucher_no, 'A(J)-R21B-', 'A(J)-')
                 ELSE replace(j.voucher_no, 'A(J)-R21-', 'A(J)-')
               END AS orig,
               e.company_id, ROUND(SUM(e.debit - e.credit), 2) AS r21
        FROM acc_gl_entry e
        JOIN bas_account a ON a.id = e.account_id
        JOIN acc_gl_journal j ON j.id = e.voucher_id AND e.voucher_type = 'acc.gl_journal'
        WHERE NOT e.is_cancelled AND a.code = '1121'
          AND (j.voucher_no LIKE 'A(J)-R21-%' OR j.voucher_no LIKE 'A(J)-R21B-%')
        GROUP BY 1, 2
      )
      SELECT y.voucher_no, y.posting_date, y.company_id::text, y.company,
             (y.yhd - COALESCE(r.r21, 0))::text AS amt,
             a1121.id::text AS a1121, a3104.id::text AS a3104
      FROM yhd y
      LEFT JOIN r21 r ON r.orig = y.voucher_no AND r.company_id = y.company_id
      JOIN bas_account a1121 ON a1121.company_id = y.company_id AND a1121.code = '1121'
      JOIN bas_account a3104 ON a3104.company_id = y.company_id AND a3104.code = '3104'
      WHERE y.yhd - COALESCE(r.r21, 0) > 0.01
      ORDER BY y.posting_date, y.voucher_no
    `.execute(db)
    console.log(JSON.stringify({ level: 'info', msg: 'w4_1121_reclass_start', apply, n: rows.rows.length }))
    if (!apply) {
      const byCo: Record<string, number> = {}
      for (const r of rows.rows) {
        byCo[r.company] = (byCo[r.company] ?? 0) + Number(r.amt)
      }
      console.log(JSON.stringify({ level: 'info', msg: 'w4_1121_reclass_dry_run', byCo }))
      return
    }
    let ok = 0
    for (const r of rows.rows) {
      const suffix = r.voucher_no.replace(/^A\(J\)-/, '')
      const voucherNo = `A(J)-R21B-${suffix}`
      await withTx(db, async (trx) => {
        const exists = await sql<{ c: string }>`
          SELECT count(*)::text AS c FROM acc_gl_journal WHERE voucher_no = ${voucherNo}
        `.execute(trx)
        if (Number(exists.rows[0]?.c ?? 0) > 0) return
        const jid = crypto.randomUUID()
        const remarks = `W4 1121→3104 补差 原 ${r.voucher_no}`
        await sql`
          INSERT INTO acc_gl_journal (
            id, voucher_no, date, posting_date, remarks, status,
            company_id, created_by_id, submitted_by_id, submitted_at
          ) VALUES (
            ${jid}::uuid, ${voucherNo}, ${r.posting_date}::date, ${r.posting_date}::date,
            ${remarks}, 'audited', ${r.company_id}::uuid, ${ACTOR}::uuid, ${ACTOR}::uuid,
            (now() AT TIME ZONE 'utc')
          )
        `.execute(trx)
        await sql`
          INSERT INTO acc_gl_journal_line (
            id, idx, debit, credit, remarks, journal_id, company_id, account_id
          ) VALUES
            (${crypto.randomUUID()}::uuid, 1, ${r.amt}::numeric, 0, ${remarks},
             ${jid}::uuid, ${r.company_id}::uuid, ${r.a1121}::uuid),
            (${crypto.randomUUID()}::uuid, 2, 0, ${r.amt}::numeric, ${remarks},
             ${jid}::uuid, ${r.company_id}::uuid, ${r.a3104}::uuid)
        `.execute(trx)
        await gl.post(trx, {
          type: 'acc.gl_journal', id: jid, no: voucherNo,
          companyId: r.company_id, postingDate: r.posting_date,
        }, [
          { accountId: r.a1121, debit: r.amt, credit: '0', remarks },
          { accountId: r.a3104, debit: '0', credit: r.amt, remarks },
        ])
      })
      ok++
      if (ok % 50 === 0) console.log(JSON.stringify({ level: 'info', msg: 'progress', ok }))
    }
    console.log(JSON.stringify({ level: 'info', msg: 'w4_1121_reclass_done', ok }))
  } finally {
    await db.destroy()
  }
}
