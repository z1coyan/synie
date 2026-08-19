/**
 * 仪表盘 1122 日记账/YHDZ 改挂。只写 synie_replay_check。
 * 缺省 dry-run；--apply 才过账。
 *
 * bun scripts/jdy-replay/w4j_journals.ts
 * bun scripts/jdy-replay/w4j_journals.ts --apply
 */
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { withTx } from '~/db/tx.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { resolveBackfillDatabaseUrl } from './backfill-cli.ts'

const ACTOR = '99e3e4f6-e208-4bb9-904c-72299808a8e7'
const gl = createGlEngine()

type Side = { account: string; customer?: string | null }

interface Spec {
  date: string
  company: string
  amount: string
  debit: Side
  credit: Side
  remarks: string
  /** 凭证尾：W4J + 本户码 */
  owner: string
}

const SPECS: Spec[] = [
  {
    date: '2020-09-30',
    company: '东方',
    amount: '100000.00',
    debit: { account: '1122', customer: '8075' },
    credit: { account: '1122', customer: '1002' },
    remarks: 'W4J 错户 8075→1002 A(J)-20200930-0001 / W4C0012 玉环庆豪=浙江庆豪',
    owner: '1002',
  },
  {
    date: '2020-12-31',
    company: '东方',
    amount: '35000.00',
    debit: { account: '2202', customer: '8075' },
    credit: { account: '1122', customer: '1002' },
    remarks: 'W4J 2202(8075)→1122(1002) A(J)-20201231-0002 玉环庆豪回款',
    owner: '1002',
  },
  {
    date: '2023-09-22',
    company: '京泰',
    amount: '50000.00',
    debit: { account: '3104' },
    credit: { account: '1122', customer: '22' },
    remarks: 'W4J 冲回重复承兑支出补记 A(J)-20230922-W4X22-499429',
    owner: '22',
  },
  {
    date: '2020-04-10',
    company: '东方',
    amount: '50000.00',
    debit: { account: '1122', customer: '68' },
    credit: { account: '2201' },
    remarks: 'W4J 客户支出 2201→1122 A(J)-20200410-0001 创银找款',
    owner: '68',
  },
  {
    date: '2023-08-23',
    company: '京泰',
    amount: '45024.25',
    debit: { account: '1221' },
    credit: { account: '1122', customer: '9' },
    remarks: 'W4J 1221→1122 A(J)-20230823-0001 雷兹回款',
    owner: '9',
  },
  {
    date: '2026-03-26',
    company: '京泰',
    amount: '20012.50',
    debit: { account: '5051' },
    credit: { account: '1122', customer: '111' },
    remarks: 'W4J 5051→1122 A(J)-20260326-0002 雷安材料款',
    owner: '111',
  },
  {
    date: '2026-04-25',
    company: '京泰',
    amount: '24784.00',
    debit: { account: '2203', customer: '111' },
    credit: { account: '1122', customer: '111' },
    remarks: 'W4J 2203→1122 A(J)-20260425-0001 雷安材料款',
    owner: '111',
  },
  {
    date: '2020-01-23',
    company: '东方',
    amount: '30000.00',
    debit: { account: '1221' },
    credit: { account: '1122', customer: '34' },
    remarks: 'W4J 1221→1122 A(J)-20200123-0001 武汉橡博和=34',
    owner: '34',
  },
  {
    date: '2026-03-24',
    company: '京泰',
    amount: '23232.00',
    debit: { account: '1123', customer: '167' },
    credit: { account: '1122', customer: '167' },
    remarks: 'W4J 漏挂 1123→1122 2026-03-24 大连北方互感器银行回款',
    owner: '167',
  },
  {
    date: '2020-12-23',
    company: '东方',
    amount: '14436.00',
    debit: { account: '2202', customer: '19' },
    credit: { account: '1122', customer: '19' },
    remarks: 'W4J 2202→1122 A(J)-20201223-0001 泰开12月付款',
    owner: '19',
  },
  {
    date: '2025-04-30',
    company: '京泰',
    amount: '14613.75',
    debit: { account: '560299' },
    credit: { account: '1122', customer: '1131' },
    remarks: 'W4J 560299→1122 A(J)-20250430-0003 康格跨行',
    owner: '1131',
  },
  {
    date: '2024-09-18',
    company: '京泰',
    amount: '2300.00',
    debit: { account: '2202', customer: '1030' },
    credit: { account: '1122', customer: '1030' },
    remarks: 'W4J 2202→1122 A(J)-20240918-0001 青州购材料',
    owner: '1030',
  },
  {
    date: '2025-08-11',
    company: '京泰',
    amount: '5500.00',
    debit: { account: '2202', customer: '1030' },
    credit: { account: '1122', customer: '1030' },
    remarks: 'W4J 2202→1122 A(J)-20250811-0005 青州购材料',
    owner: '1030',
  },
  {
    date: '2025-11-21',
    company: '京泰',
    amount: '5000.00',
    debit: { account: '1122', customer: '218' },
    credit: { account: '1123', customer: '218' },
    remarks: 'W4J 公式未计(无lookup) 1122→1123 A(J)-20251121-0004 雄基',
    owner: '218',
  },
  {
    date: '2022-06-18',
    company: '京泰',
    amount: '2200.00',
    debit: { account: '2202', customer: '132' },
    credit: { account: '1122', customer: '132' },
    remarks: 'W4J 2202→1122 A(J)-20220618-0001 鼎浩出金',
    owner: '132',
  },
  {
    date: '2022-11-18',
    company: '京泰',
    amount: '590.00',
    debit: { account: '1221' },
    credit: { account: '1122', customer: '143' },
    remarks: 'W4J 1221→1122 A(J)-20221118-0001 安徽优源=143',
    owner: '143',
  },
  {
    date: '2024-05-14',
    company: '京泰',
    amount: '1375.00',
    debit: { account: '2202', customer: '8039' },
    credit: { account: '1122', customer: '143' },
    remarks: 'W4J 2202(8039)→1122(143) A(J)-20240514-0001 lookup=143',
    owner: '143',
  },
  {
    date: '2020-07-09',
    company: '东方',
    amount: '1900.00',
    debit: { account: '2203', customer: '1028' },
    credit: { account: '1122', customer: '1028' },
    remarks: 'W4J 2203→1122 A(J)-20200709-0004 澎阳预付',
    owner: '1028',
  },
  {
    date: '2023-07-19',
    company: '东方',
    amount: '1500.00',
    debit: { account: '2203', customer: '1056' },
    credit: { account: '1122', customer: '1056' },
    remarks: 'W4J 2203→1122 A(J)-20230719-0001 杜凯预付',
    owner: '1056',
  },
  {
    date: '2020-07-14',
    company: '东方',
    amount: '3900.00',
    debit: { account: '1122', customer: '1030' },
    credit: { account: '1123', customer: '1030' },
    remarks: 'W4J 公式未计(pt=其他) 1122→1123 A(J)-20200714-0001 青州',
    owner: '1030',
  },
  {
    date: '2023-01-14',
    company: '京泰',
    amount: '1093.50',
    debit: { account: '1122', customer: '117' },
    credit: { account: '2202', customer: '117' },
    remarks: 'W4J 客户支出 2202→1122 A(J)-20230114-0001 嘉伦',
    owner: '117',
  },
  {
    date: '2023-07-31',
    company: '京泰',
    amount: '960.00',
    debit: { account: '2202', customer: '158' },
    credit: { account: '1122', customer: '158' },
    remarks: 'W4J 2202→1122 A(J)-20230731-0001 科越',
    owner: '158',
  },
  {
    date: '2020-11-30',
    company: '东方',
    amount: '900.00',
    debit: { account: '1121' },
    credit: { account: '1122', customer: '23' },
    remarks: 'W4J 1121→1122 A(J)-20201130-0002 正泰智能（流水非承兑交易）',
    owner: '23',
  },
  {
    date: '2025-04-28',
    company: '京泰',
    amount: '540.00',
    debit: { account: '2202', customer: '1066' },
    credit: { account: '1122', customer: '1066' },
    remarks: 'W4J 2202→1122 A(J)-20250428-0001 天润采购款',
    owner: '1066',
  },
  {
    date: '2026-01-23',
    company: '京泰',
    amount: '502.50',
    debit: { account: '1122', customer: '1067' },
    credit: { account: '1123', customer: '1067' },
    remarks: 'W4J 公式未计(无lookup) 1122→1123 A(J)-20260123-0001 汇瑞',
    owner: '1067',
  },
  {
    date: '2025-03-28',
    company: '京泰',
    amount: '477.00',
    debit: { account: '2202', customer: '183' },
    credit: { account: '1122', customer: '183' },
    remarks: 'W4J 2202→1122 A(J)-20250328-0002 顾德益',
    owner: '183',
  },
  {
    date: '2023-02-22',
    company: '京泰',
    amount: '223.20',
    debit: { account: '2203', customer: '80' },
    credit: { account: '1122', customer: '80' },
    remarks: 'W4J 2203→1122 A(J)-20230222-0001 翔登预付',
    owner: '80',
  },
  {
    date: '2024-10-11',
    company: '京泰',
    amount: '122.70',
    debit: { account: '2203', customer: '80' },
    credit: { account: '1122', customer: '80' },
    remarks: 'W4J 2203→1122 A(J)-20241011-0003 翔登预付',
    owner: '80',
  },
  {
    date: '2026-03-20',
    company: '京泰',
    amount: '186.00',
    debit: { account: '1122', customer: '239' },
    credit: { account: '1123', customer: '239' },
    remarks: 'W4J 公式未计(无lookup) 1122→1123 A(J)-20260320-0001 佰汇通',
    owner: '239',
  },
]

type Db = Parameters<typeof gl.post>[0]

function ymd(iso: string): string {
  return iso.slice(0, 10).replaceAll('-', '')
}

function voucherNo(spec: Spec): string {
  return `A(J)-${ymd(spec.date)}-W4J${spec.owner}`
}

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

async function postOne(db: Db, spec: Spec): Promise<'ok' | 'skip'> {
  const vno = voucherNo(spec)
  if (await journalExists(db, vno)) return 'skip'
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
      ${journalId}::uuid, ${vno}, ${spec.date}::date, ${spec.date}::date,
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
      no: vno,
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
  console.log(JSON.stringify({ level: 'info', msg: 'w4j_start', apply, n: SPECS.length }))
  for (const spec of SPECS) {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'w4j_spec',
        voucher: voucherNo(spec),
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
    console.log(JSON.stringify({ level: 'info', msg: 'w4j_dry_run' }))
    return
  }

  const db = createDb(resolveBackfillDatabaseUrl())
  const counts = { ok: 0, skip: 0, error: 0 }
  try {
    for (const spec of SPECS) {
      const vno = voucherNo(spec)
      try {
        const status = await withTx(db, (trx) => postOne(trx, spec))
        if (status === 'skip') counts.skip++
        else counts.ok++
        console.log(JSON.stringify({ level: 'info', msg: 'w4j_posted', voucher: vno, status }))
      } catch (err) {
        counts.error++
        const detail = err instanceof Error ? err.message : String(err)
        console.log(JSON.stringify({ level: 'error', msg: 'w4j_failed', voucher: vno, error: detail }))
      }
    }
    console.log(JSON.stringify({ level: 'info', msg: 'w4j_done', ...counts }))
    if (counts.error > 0) process.exitCode = 1
  } finally {
    await db.destroy()
  }
}
