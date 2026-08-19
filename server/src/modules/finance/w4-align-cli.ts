/**
 * W4 承兑 1122 对齐。读 build_w4_align_plan.py 的 JSON。
 * 缺省 dry-run；--apply 才写。
 *
 * bun scripts/jdy-replay/w4_align_customer_bills.ts --plan .scratch/replay/w4_align_plan.json
 */
import { readFileSync } from 'node:fs'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { systemPermit } from '~/platform/authz/core/index.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createBillService } from './bill-service.ts'
import { resolveBackfillDatabaseUrl } from './backfill-cli.ts'

const ACTOR = '99e3e4f6-e208-4bb9-904c-72299808a8e7'
const BILL_VOUCHER = 'acc.bill_transaction'
const gl = createGlEngine()

interface ReceiveUntarget {
  tx_id: string
  settle: '2202' | '3104'
  party_type?: 'supplier' | 'company' | 'customer'
  supplier_code?: string
  party_id?: string
  ticket?: string
  amount?: string
}

interface JournalItem {
  date: string
  company: string
  customer_code: string
  amount: string
  ticket?: string
  src_voucher_no?: string
  voucher_no?: string
}

interface Plan {
  endorse_reclass: string[]
  endorse_restore: string[]
  receive_retarget: { tx_id: string; customer_code: string; company: string; ticket: string; amount: string }[]
  receive_untarget: ReceiveUntarget[]
  split_journals: JournalItem[]
  ar_reclass_1123: JournalItem[]
  expense_journals: JournalItem[]
}

interface Counts {
  endorse: { ok: number; skip: number; error: number }
  retarget: { ok: number; skip: number; error: number }
  untarget: { ok: number; skip: number; error: number }
  journals: { ok: number; skip: number; error: number }
}

function parseArgs(argv: string[]): { planPath: string; apply: boolean } {
  let planPath = '.scratch/replay/w4_align_plan.json'
  let apply = false
  let dry = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--plan') planPath = argv[++i] ?? ''
    else if (arg === '--apply') apply = true
    else if (arg === '--dry-run') dry = true
    else throw new Error(`不支持的参数：${arg}`)
  }
  if (!planPath) throw new Error('--plan 需要路径')
  if (apply && dry) throw new Error('不能同时 --apply 与 --dry-run')
  return { planPath, apply }
}

function loadPlan(path: string): Plan {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Plan>
  return {
    endorse_reclass: raw.endorse_reclass ?? [],
    endorse_restore: raw.endorse_restore ?? [],
    receive_retarget: raw.receive_retarget ?? [],
    receive_untarget: raw.receive_untarget ?? [],
    split_journals: raw.split_journals ?? [],
    ar_reclass_1123: raw.ar_reclass_1123 ?? [],
    expense_journals: raw.expense_journals ?? [],
  }
}

// kysely / withTx 句柄都能跑 sql`` 与 gl.post
type Db = Parameters<typeof gl.post>[0]

async function companyId(db: Db, label: string): Promise<string> {
  const codes = label === '京泰' || label === 'JT' ? sql`('JT','京泰')` : sql`('DF','东方')`
  const row = await sql<{ id: string }>`
    SELECT id FROM bas_company WHERE code IN ${codes} LIMIT 1
  `.execute(db)
  const id = row.rows[0]?.id
  if (!id) throw new Error(`找不到公司 ${label}`)
  return id
}

async function customerId(db: Db, code: string): Promise<string> {
  const row = await sql<{ id: string }>`
    SELECT id FROM sal_customers WHERE code = ${code} LIMIT 1
  `.execute(db)
  const id = row.rows[0]?.id
  if (!id) throw new Error(`找不到客户 ${code}`)
  return id
}

async function supplierId(db: Db, code: string): Promise<string> {
  const row = await sql<{ id: string }>`
    SELECT id FROM pur_supplier WHERE code = ${code} LIMIT 1
  `.execute(db)
  const id = row.rows[0]?.id
  if (!id) throw new Error(`找不到供应商 ${code}`)
  return id
}

async function accountId(db: Db, companyIdVal: string, code: string): Promise<string> {
  const row = await sql<{ id: string }>`
    SELECT id FROM bas_account WHERE company_id = ${companyIdVal}::uuid AND code = ${code} LIMIT 1
  `.execute(db)
  const id = row.rows[0]?.id
  if (!id) throw new Error(`找不到科目 ${code}`)
  return id
}

async function journalExists(db: Db, voucherNo: string): Promise<boolean> {
  const row = await sql<{ c: string }>`
    SELECT count(*)::text AS c FROM acc_gl_journal WHERE voucher_no = ${voucherNo}
  `.execute(db)
  return Number(row.rows[0]?.c ?? 0) > 0
}

function ymd(iso: string): string {
  return iso.slice(0, 10).replaceAll('-', '')
}

async function postReclassJournal(
  db: Db,
  opts: {
    voucherNo: string
    date: string
    companyLabel: string
    customerCode: string
    amount: string
    debitCode: string
    creditCode: string
    remarks: string
    debitParty: boolean
    creditParty: boolean
  },
): Promise<'ok' | 'skip'> {
  if (await journalExists(db, opts.voucherNo)) return 'skip'
  const coId = await companyId(db, opts.companyLabel)
  const partyId = await customerId(db, opts.customerCode)
  const debitId = await accountId(db, coId, opts.debitCode)
  const creditId = await accountId(db, coId, opts.creditCode)
  const journalId = crypto.randomUUID()
  const debitPartyType = opts.debitParty ? 'customer' : null
  const creditPartyType = opts.creditParty ? 'customer' : null
  const debitPartyId = opts.debitParty ? partyId : null
  const creditPartyId = opts.creditParty ? partyId : null
  await sql`
    INSERT INTO acc_gl_journal (
      id, voucher_no, date, posting_date, remarks, status,
      company_id, created_by_id, submitted_by_id, submitted_at
    ) VALUES (
      ${journalId}::uuid, ${opts.voucherNo}, ${opts.date}::date, ${opts.date}::date,
      ${opts.remarks}, 'audited', ${coId}::uuid, ${ACTOR}::uuid, ${ACTOR}::uuid,
      (now() AT TIME ZONE 'utc')
    )
  `.execute(db)
  await sql`
    INSERT INTO acc_gl_journal_line (
      id, idx, debit, credit, party_type, party_id, remarks,
      journal_id, company_id, account_id
    ) VALUES
      (
        ${crypto.randomUUID()}::uuid, 1, ${opts.amount}::numeric, 0,
        ${debitPartyType}, ${debitPartyId}::uuid,
        ${opts.remarks}, ${journalId}::uuid, ${coId}::uuid, ${debitId}::uuid
      ),
      (
        ${crypto.randomUUID()}::uuid, 2, 0, ${opts.amount}::numeric,
        ${creditPartyType}, ${creditPartyId}::uuid,
        ${opts.remarks}, ${journalId}::uuid, ${coId}::uuid, ${creditId}::uuid
      )
  `.execute(db)
  await gl.post(
    db,
    {
      type: 'acc.gl_journal',
      id: journalId,
      no: opts.voucherNo,
      companyId: coId,
      postingDate: opts.date,
    },
    [
      {
        accountId: debitId,
        debit: opts.amount,
        credit: '0',
        partyType: debitPartyType,
        partyId: debitPartyId,
        remarks: opts.remarks,
      },
      {
        accountId: creditId,
        debit: '0',
        credit: opts.amount,
        partyType: creditPartyType,
        partyId: creditPartyId,
        remarks: opts.remarks,
      },
    ],
  )
  return 'ok'
}

export async function main(argv: string[]): Promise<void> {
  const { planPath, apply } = parseArgs(argv)
  const plan = loadPlan(planPath)
  const counts: Counts = {
    endorse: { ok: 0, skip: 0, error: 0 },
    retarget: { ok: 0, skip: 0, error: 0 },
    untarget: { ok: 0, skip: 0, error: 0 },
    journals: { ok: 0, skip: 0, error: 0 },
  }
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'w4_align_start',
      apply,
      endorse: plan.endorse_reclass.length,
      restore: plan.endorse_restore.length,
      retarget: plan.receive_retarget.length,
      untarget: plan.receive_untarget.length,
      split: plan.split_journals.length,
      ar1123: plan.ar_reclass_1123.length,
      expense: plan.expense_journals.length,
    }),
  )
  if (!apply) {
    console.log(JSON.stringify({ level: 'info', msg: 'w4_align_dry_run' }))
    return
  }

  const db = createDb(resolveBackfillDatabaseUrl())
  try {
    const registry = createSealedResourceRegistry()
    const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
    const bills = createBillService(db, numbering, { gl, registry })
    const permit = systemPermit('accBillTransactions', 'audit')

    for (const id of plan.endorse_reclass) {
      try {
        const action = await withTx(db, async (trx) => {
          const row = await sql<{ settle: string; already: string }>`
            SELECT sa.code AS settle,
                   EXISTS(
                     SELECT 1 FROM acc_gl_entry e
                     JOIN bas_account a ON a.id = e.account_id
                     WHERE e.voucher_type = ${BILL_VOUCHER} AND e.voucher_id = ${id}::uuid
                       AND NOT e.is_cancelled AND a.code = '1122'
                   )::text AS already
            FROM acc_bill_transaction t
            JOIN bas_account sa ON sa.id = t.settle_account_id
            WHERE t.id = ${id}::uuid
          `.execute(trx)
          const cur = row.rows[0]
          if (!cur) throw new Error('交易不存在')
          if (cur.settle === '3104' && cur.already === 'false') return 'skip' as const
          await gl.cancel(trx, { type: BILL_VOUCHER, id })
          await sql`
            UPDATE acc_bill_transaction t
            SET settle_account_id = a.id,
                remarks = left(coalesce(t.remarks,'') || ' W4改挂3104（非K16客户退回）', 500),
                updated_at = (now() AT TIME ZONE 'utc')
            FROM bas_account a
            WHERE t.id = ${id}::uuid
              AND a.company_id = t.company_id AND a.code = '3104'
          `.execute(trx)
          await sql`
            INSERT INTO sys_audit_log (resource, record_id, action_type, action_name, actor_id, company_id, changes)
            SELECT 'accBillTransactions', t.id, 'update', 'w4_align_settle_3104', ${ACTOR}::uuid,
                   t.company_id, jsonb_build_object('settle', '3104')
            FROM acc_bill_transaction t WHERE t.id = ${id}::uuid
          `.execute(trx)
          return 'ok' as const
        })
        if (action === 'skip') {
          counts.endorse.skip++
          continue
        }
        await bills.backfillPostedGL(permit, id)
        counts.endorse.ok++
        if (counts.endorse.ok % 50 === 0) {
          console.log(JSON.stringify({ level: 'info', msg: 'endorse_progress', ok: counts.endorse.ok }))
        }
      } catch (err) {
        counts.endorse.error++
        const detail = err instanceof Error ? err.message : String(err)
        console.log(JSON.stringify({ level: 'error', msg: 'endorse_failed', id, error: detail }))
      }
    }

    for (const id of plan.endorse_restore) {
      try {
        const action = await withTx(db, async (trx) => {
          const row = await sql<{ settle: string }>`
            SELECT sa.code AS settle
            FROM acc_bill_transaction t
            JOIN bas_account sa ON sa.id = t.settle_account_id
            WHERE t.id = ${id}::uuid
          `.execute(trx)
          const cur = row.rows[0]
          if (!cur) throw new Error('交易不存在')
          if (cur.settle === '1122') return 'skip' as const
          await gl.cancel(trx, { type: BILL_VOUCHER, id })
          await sql`
            UPDATE acc_bill_transaction t
            SET settle_account_id = a.id,
                remarks = left(coalesce(t.remarks,'') || ' W4还原K16退回1122', 500),
                updated_at = (now() AT TIME ZONE 'utc')
            FROM bas_account a
            WHERE t.id = ${id}::uuid
              AND a.company_id = t.company_id AND a.code = '1122'
          `.execute(trx)
          await sql`
            INSERT INTO sys_audit_log (resource, record_id, action_type, action_name, actor_id, company_id, changes)
            SELECT 'accBillTransactions', t.id, 'update', 'w4_align_restore_k16', ${ACTOR}::uuid,
                   t.company_id, jsonb_build_object('settle', '1122')
            FROM acc_bill_transaction t WHERE t.id = ${id}::uuid
          `.execute(trx)
          return 'ok' as const
        })
        if (action === 'skip') {
          counts.endorse.skip++
          continue
        }
        await bills.backfillPostedGL(permit, id)
        counts.endorse.ok++
      } catch (err) {
        counts.endorse.error++
        const detail = err instanceof Error ? err.message : String(err)
        console.log(JSON.stringify({ level: 'error', msg: 'restore_failed', id, error: detail }))
      }
    }

    for (const item of plan.receive_retarget) {
      try {
        await withTx(db, async (trx) => {
          const row = await sql<{ ptyp: string; settle: string; cust: string }>`
            SELECT lower(coalesce(t.party_type,'')) AS ptyp, sa.code AS settle, coalesce(c.code,'') AS cust
            FROM acc_bill_transaction t
            JOIN bas_account sa ON sa.id = t.settle_account_id
            LEFT JOIN sal_customers c ON c.id = t.party_id AND lower(t.party_type)='customer'
            WHERE t.id = ${item.tx_id}::uuid
          `.execute(trx)
          const cur = row.rows[0]
          if (!cur) throw new Error('交易不存在')
          if (cur.ptyp === 'customer' && cur.settle === '1122' && cur.cust === item.customer_code) {
            counts.retarget.skip++
            return
          }
          const partyId = await customerId(trx, item.customer_code)
          const remarkSuffix = ` W4改挂客户${item.customer_code} 1122`
          await gl.cancel(trx, { type: BILL_VOUCHER, id: item.tx_id })
          await sql`
            UPDATE acc_bill_transaction t
            SET party_type = 'customer',
                party_id = ${partyId}::uuid,
                settle_account_id = a.id,
                remarks = left(coalesce(t.remarks,'') || ${remarkSuffix}, 500),
                updated_at = (now() AT TIME ZONE 'utc')
            FROM bas_account a
            WHERE t.id = ${item.tx_id}::uuid
              AND a.company_id = t.company_id AND a.code = '1122'
          `.execute(trx)
          await sql`
            INSERT INTO sys_audit_log (resource, record_id, action_type, action_name, actor_id, company_id, changes)
            SELECT 'accBillTransactions', t.id, 'update', 'w4_align_receive_1122', ${ACTOR}::uuid,
                   t.company_id, jsonb_build_object('customer', ${item.customer_code}::text)
            FROM acc_bill_transaction t WHERE t.id = ${item.tx_id}::uuid
          `.execute(trx)
        })
        await bills.backfillPostedGL(permit, item.tx_id)
        counts.retarget.ok++
        if (counts.retarget.ok % 50 === 0) {
          console.log(JSON.stringify({ level: 'info', msg: 'retarget_progress', ok: counts.retarget.ok }))
        }
      } catch (err) {
        counts.retarget.error++
        const detail = err instanceof Error ? err.message : String(err)
        console.log(JSON.stringify({ level: 'error', msg: 'retarget_failed', id: item.tx_id, error: detail }))
      }
    }

    for (const item of plan.receive_untarget) {
      try {
        await withTx(db, async (trx) => {
          const row = await sql<{ ptyp: string; settle: string; party: string }>`
            SELECT lower(coalesce(t.party_type,'')) AS ptyp, sa.code AS settle,
                   coalesce(t.party_id::text,'') AS party
            FROM acc_bill_transaction t
            JOIN bas_account sa ON sa.id = t.settle_account_id
            WHERE t.id = ${item.tx_id}::uuid
          `.execute(trx)
          const cur = row.rows[0]
          if (!cur) throw new Error('交易不存在')
          let nextPartyType = item.party_type ?? cur.ptyp
          let nextPartyId = item.party_id ?? (cur.party || null)
          if (item.party_type === 'supplier') {
            if (!item.supplier_code) throw new Error('receive_untarget supplier 需要 supplier_code')
            nextPartyId = await supplierId(trx, item.supplier_code)
          } else if (item.party_type === 'company') {
            if (!item.party_id) throw new Error('receive_untarget company 需要 party_id')
            nextPartyId = item.party_id
          } else if (item.party_type === 'customer') {
            if (!item.party_id) throw new Error('receive_untarget customer 需要 party_id')
            nextPartyId = item.party_id
          }
          const sameParty =
            nextPartyType === cur.ptyp && (nextPartyId ?? '') === cur.party
          if (cur.settle === item.settle && sameParty) {
            counts.untarget.skip++
            return
          }
          const remarkSuffix = ` W4撤销改挂${item.settle}`
          await gl.cancel(trx, { type: BILL_VOUCHER, id: item.tx_id })
          await sql`
            UPDATE acc_bill_transaction t
            SET party_type = ${nextPartyType},
                party_id = ${nextPartyId}::uuid,
                settle_account_id = a.id,
                remarks = left(coalesce(t.remarks,'') || ${remarkSuffix}, 500),
                updated_at = (now() AT TIME ZONE 'utc')
            FROM bas_account a
            WHERE t.id = ${item.tx_id}::uuid
              AND a.company_id = t.company_id AND a.code = ${item.settle}
          `.execute(trx)
          await sql`
            INSERT INTO sys_audit_log (resource, record_id, action_type, action_name, actor_id, company_id, changes)
            SELECT 'accBillTransactions', t.id, 'update', 'w4_align_receive_untarget', ${ACTOR}::uuid,
                   t.company_id, jsonb_build_object(
                     'settle', ${item.settle}::text,
                     'party_type', ${nextPartyType}::text
                   )
            FROM acc_bill_transaction t WHERE t.id = ${item.tx_id}::uuid
          `.execute(trx)
        })
        await bills.backfillPostedGL(permit, item.tx_id)
        counts.untarget.ok++
      } catch (err) {
        counts.untarget.error++
        const detail = err instanceof Error ? err.message : String(err)
        console.log(JSON.stringify({ level: 'error', msg: 'untarget_failed', id: item.tx_id, error: detail }))
      }
    }

    let seq = 0
    const postOne = async (
      kind: string,
      voucherNo: string,
      spec: Parameters<typeof postReclassJournal>[1],
    ) => {
      try {
        const status = await withTx(db, (trx) => postReclassJournal(trx, spec))
        if (status === 'skip') counts.journals.skip++
        else counts.journals.ok++
      } catch (err) {
        counts.journals.error++
        const detail = err instanceof Error ? err.message : String(err)
        console.log(JSON.stringify({ level: 'error', msg: 'journal_failed', kind, voucherNo, error: detail }))
      }
    }

    for (const item of plan.split_journals) {
      seq++
      const tail = (item.ticket ?? '').replace(/\D/g, '').slice(-6) || String(seq).padStart(4, '0')
      const voucherNo =
        item.voucher_no ?? `A(J)-${ymd(item.date)}-W4B${item.customer_code}-${tail}`
      await postOne('split', voucherNo, {
        voucherNo,
        date: item.date,
        companyLabel: item.company,
        customerCode: item.customer_code,
        amount: item.amount,
        debitCode: '3104',
        creditCode: '1122',
        remarks: `W4 同票拆段客户收入 ${item.ticket} ${item.customer_code}`,
        debitParty: false,
        creditParty: true,
      })
    }
    seq = 0
    for (const item of plan.ar_reclass_1123) {
      seq++
      const voucherNo = `A(J)-${ymd(item.date)}-W4C${String(seq).padStart(4, '0')}`
      await postOne('1123', voucherNo, {
        voucherNo,
        date: item.date,
        companyLabel: item.company,
        customerCode: item.customer_code,
        amount: item.amount,
        debitCode: '1123',
        creditCode: '1122',
        remarks: `W4 客户回款 1123→1122 ${item.src_voucher_no} ${item.customer_code}`,
        debitParty: true,
        creditParty: true,
      })
    }
    seq = 0
    for (const item of plan.expense_journals) {
      const tail = (item.ticket ?? '').replace(/\D/g, '').slice(-6) || String(++seq).padStart(4, '0')
      const voucherNo =
        item.voucher_no ?? `A(J)-${ymd(item.date)}-W4X${item.customer_code}-${tail}`
      await postOne('expense', voucherNo, {
        voucherNo,
        date: item.date,
        companyLabel: item.company,
        customerCode: item.customer_code,
        amount: item.amount,
        debitCode: '1122',
        creditCode: '3104',
        remarks: `W4 客户承兑支出补记 ${item.ticket} ${item.customer_code}`,
        debitParty: true,
        creditParty: false,
      })
    }

    console.log(JSON.stringify({ level: 'info', msg: 'w4_align_done', ...counts }))
    if (
      counts.endorse.error + counts.retarget.error + counts.untarget.error + counts.journals.error > 0
    ) {
      process.exitCode = 1
    }
  } finally {
    await db.destroy()
  }
}

