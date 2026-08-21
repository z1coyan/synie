/**
 * 仪表盘 1122 混合户改挂。只写 synie_replay_check。
 * 缺省 dry-run；--apply 才过账。
 *
 * bun scripts/jdy-replay/w4m_mixed.ts
 * bun scripts/jdy-replay/w4m_mixed.ts --apply
 */
import { sql } from 'kysely'
import { withTx, type TrxHandle } from '../../server/src/db/tx.ts'
import type { GlEngine } from '../../server/src/engines/gl/index.ts'
import {
  createMigrationWorld,
  MIGRATION_ACTOR_ID as ACTOR,
  resolveBackfillDatabaseUrl,
} from './bootstrap.ts'

type Side = { account: string; customer?: string | null }

interface Spec {
  voucher: string
  date: string
  company: string
  amount: string
  debit: Side
  credit: Side
  remarks: string
}

const SPECS: Spec[] = [
  {
    voucher: 'A(J)-20250117-W4M77-367436',
    date: '2025-01-17',
    company: '京泰',
    amount: '67058.47',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '77' },
    remarks: 'W4M 同票拆段 77 收入 530611000008720241031000367436 67058.47',
  },
  {
    voucher: 'A(J)-20200827-W4M119-433824',
    date: '2020-08-27',
    company: '京泰',
    amount: '50000.00',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '119' },
    remarks: 'W4M 票挂 77 不抢 补 119 收入 131322760901520200818702433824',
  },
  {
    voucher: 'A(J)-20260209-W4M26-186411A',
    date: '2026-02-09',
    company: '京泰',
    amount: '37860.00',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '26' },
    remarks: 'W4M 接收挂 1121 补 26 收入 531333109001320251209101186411 37860',
  },
  {
    voucher: 'A(J)-20260209-W4M26-186411B',
    date: '2026-02-09',
    company: '京泰',
    amount: '37860.00',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '26' },
    remarks: 'W4M 接收挂 1121 补 26 收入 531333109001320251209101186411 37860b',
  },
  {
    voucher: 'A(J)-20250611-W4M97-054749',
    date: '2025-06-11',
    company: '京泰',
    amount: '4297.00',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '97' },
    remarks: 'W4M 同票拆段 97 收入 532330100001920250402000054749（票在 41）',
  },
  {
    voucher: 'A(J)-20250821-W4M41-932309',
    date: '2025-08-21',
    company: '京泰',
    amount: '18600.00',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '41' },
    remarks: 'W4M 同票拆段 41 收入 590779100001720250729100932309（票在 97）',
  },
  {
    voucher: 'A(J)-20250611-W4M50-812172',
    date: '2025-06-11',
    company: '京泰',
    amount: '32800.00',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '50' },
    remarks: 'W4M 同票拆段 50 收入 550345200931720250410100812172（票在 97）',
  },
  {
    voucher: 'A(J)-20250821-W4M50-932309',
    date: '2025-08-21',
    company: '京泰',
    amount: '70900.00',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '50' },
    remarks: 'W4M 同票拆段 50 收入 590779100001720250729100932309（票在 97）',
  },
  {
    voucher: 'A(J)-20210710-W4M19-417546',
    date: '2021-07-10',
    company: '东方',
    amount: '8528.00',
    debit: { account: '1123', customer: '19' },
    credit: { account: '1122', customer: '19' },
    remarks: 'W4M 41792546 作废红字 JDY 67e95cb5bac64f3007640e86 A(I)-20210709-0002',
  },
  {
    voucher: 'A(J)-20200917-W4M232-0003',
    date: '2020-09-17',
    company: '京泰',
    amount: '4522.50',
    debit: { account: '1123', customer: '232' },
    credit: { account: '1122', customer: '232' },
    remarks: 'W4M 发票 lookup=538 误挂 232 A(I)-20200916-0003 公式未计',
  },
  {
    voucher: 'A(J)-20211229-W4M1030-05086',
    date: '2021-12-29',
    company: '东方',
    amount: '2802.75',
    debit: { account: '1123', customer: '1030' },
    credit: { account: '1122', customer: '1030' },
    remarks: 'W4M 发票无 7313 lookup 误挂 1030 A(I)-20211228-0001 公式未计',
  },
  {
    voucher: 'A(J)-20250825-W4M888-355155',
    date: '2025-08-25',
    company: '东方',
    amount: '2400.00',
    debit: { account: '1123', customer: '888' },
    credit: { account: '1122', customer: '888' },
    remarks: 'W4M 发票 lookup 空/其他 误挂 888 A(I)-20250824-0001 公式未计',
  },
  {
    voucher: 'A(J)-20230921-W4M41-17860',
    date: '2023-09-21',
    company: '京泰',
    amount: '7508.18',
    debit: { account: '1122', customer: '41' },
    credit: { account: '3104' },
    remarks: 'W4M 仪表盘/公式重复计 43017860（JDY 7641776+764172e）补 41 发票',
  },
  {
    voucher: 'A(J)-20260311-W4M56-4550',
    date: '2026-03-11',
    company: '京泰',
    amount: '4550.00',
    debit: { account: '1122', customer: '56' },
    credit: { account: '2202', customer: '56' },
    remarks: 'W4M 客户银行支出 2202→1122 A(J)-20260311-0002 天际',
  },
  {
    voucher: 'A(J)-20210205-W4M107-1900',
    date: '2021-02-05',
    company: '东方',
    amount: '1900.00',
    debit: { account: '1122', customer: '107' },
    credit: { account: '2241', customer: '107' },
    remarks: 'W4M 客户银行支出 2241→1122 A(J)-20210205-0002 东踞往来款',
  },
  {
    voucher: 'A(J)-20230918-W4M4150-14800',
    date: '2023-09-18',
    company: '京泰',
    amount: '29600.00',
    debit: { account: '1122', customer: '50' },
    credit: { account: '1122', customer: '41' },
    remarks: 'W4M 承兑互转改向 2×14800 A(J)-20230917-0001 41→50 应为 50 借 / 41 贷',
  },
  {
    voucher: 'A(J)-20231213-W4M4150-62800',
    date: '2023-12-13',
    company: '京泰',
    amount: '125600.00',
    debit: { account: '1122', customer: '50' },
    credit: { account: '1122', customer: '41' },
    remarks: 'W4M 承兑互转改向 2×62800 A(J)-20231212-0002 41→50 应为 50 借 / 41 贷',
  },
]

type Db = TrxHandle

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

async function accountId(db: Db, companyIdVal: string, code: string): Promise<string> {
  const row = await sql<{ id: string }>`
    SELECT id FROM bas_account WHERE company_id = ${companyIdVal}::uuid AND code = ${code} LIMIT 1
  `.execute(db)
  const id = row.rows[0]?.id
  if (!id) throw new Error(`找不到科目 ${code}`)
  return id
}

async function journalExists(db: Db, voucherNoVal: string): Promise<boolean> {
  const row = await sql<{ c: string }>`
    SELECT count(*)::text AS c FROM acc_gl_journal WHERE voucher_no = ${voucherNoVal}
  `.execute(db)
  return Number(row.rows[0]?.c ?? 0) > 0
}

async function postOne(gl: GlEngine, db: Db, spec: Spec): Promise<'ok' | 'skip'> {
  if (await journalExists(db, spec.voucher)) return 'skip'
  const coId = await companyId(db, spec.company)
  const debitId = await accountId(db, coId, spec.debit.account)
  const creditId = await accountId(db, coId, spec.credit.account)
  const debitPartyId = spec.debit.customer ? await customerId(db, spec.debit.customer) : null
  const creditPartyId = spec.credit.customer ? await customerId(db, spec.credit.customer) : null
  const debitPartyType = debitPartyId ? 'customer' : null
  const creditPartyType = creditPartyId ? 'customer' : null
  const journalId = crypto.randomUUID()
  await sql`
    INSERT INTO acc_gl_journal (
      id, voucher_no, date, posting_date, remarks, status,
      company_id, created_by_id, submitted_by_id, submitted_at
    ) VALUES (
      ${journalId}::uuid, ${spec.voucher}, ${spec.date}::date, ${spec.date}::date,
      ${spec.remarks}, 'audited', ${coId}::uuid, ${ACTOR}::uuid, ${ACTOR}::uuid,
      (now() AT TIME ZONE 'utc')
    )
  `.execute(db)
  await sql`
    INSERT INTO acc_gl_journal_line (
      id, idx, debit, credit, party_type, party_id, remarks,
      journal_id, company_id, account_id
    ) VALUES
      (
        ${crypto.randomUUID()}::uuid, 1, ${spec.amount}::numeric, 0,
        ${debitPartyType}, ${debitPartyId}::uuid,
        ${spec.remarks}, ${journalId}::uuid, ${coId}::uuid, ${debitId}::uuid
      ),
      (
        ${crypto.randomUUID()}::uuid, 2, 0, ${spec.amount}::numeric,
        ${creditPartyType}, ${creditPartyId}::uuid,
        ${spec.remarks}, ${journalId}::uuid, ${coId}::uuid, ${creditId}::uuid
      )
  `.execute(db)
  await gl.post(
    db,
    {
      type: 'acc.gl_journal',
      id: journalId,
      no: spec.voucher,
      companyId: coId,
      postingDate: spec.date,
    },
    [
      {
        accountId: debitId,
        debit: spec.amount,
        credit: '0',
        partyType: debitPartyType,
        partyId: debitPartyId,
        remarks: spec.remarks,
      },
      {
        accountId: creditId,
        debit: '0',
        credit: spec.amount,
        partyType: creditPartyType,
        partyId: creditPartyId,
        remarks: spec.remarks,
      },
    ],
  )
  return 'ok'
}

export async function main(argv: string[]): Promise<void> {
  const apply = argv.includes('--apply')
  if (argv.some((a) => a !== '--apply' && a !== '--dry-run')) {
    throw new Error('只支持 --apply / --dry-run')
  }
  console.log(JSON.stringify({ level: 'info', msg: 'w4m_start', apply, n: SPECS.length }))
  for (const spec of SPECS) {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'w4m_spec',
        voucher: spec.voucher,
        date: spec.date,
        company: spec.company,
        amount: spec.amount,
        debit: `${spec.debit.account}${spec.debit.customer ? `(${spec.debit.customer})` : ''}`,
        credit: `${spec.credit.account}${spec.credit.customer ? `(${spec.credit.customer})` : ''}`,
        remarks: spec.remarks,
      }),
    )
  }
  if (!apply) {
    console.log(JSON.stringify({ level: 'info', msg: 'w4m_dry_run' }))
    return
  }

  const world = createMigrationWorld(resolveBackfillDatabaseUrl())
  const db = world.db
  const counts = { ok: 0, skip: 0, error: 0 }
  try {
    for (const spec of SPECS) {
      try {
        const status = await withTx(db, (trx) => postOne(world.gl, trx, spec))
        if (status === 'skip') counts.skip++
        else counts.ok++
        console.log(JSON.stringify({ level: 'info', msg: 'w4m_posted', voucher: spec.voucher, status }))
      } catch (err) {
        counts.error++
        const detail = err instanceof Error ? err.message : String(err)
        console.log(JSON.stringify({ level: 'error', msg: 'w4m_failed', voucher: spec.voucher, error: detail }))
      }
    }
    console.log(JSON.stringify({ level: 'info', msg: 'w4m_done', ...counts }))
    if (counts.error > 0) process.exitCode = 1
  } finally {
    await db.destroy()
  }
}
