/**
 * 扫荡批 6（工单 12，最后一批）的授权端到端验收：finance / accounting / hr。
 *
 * 断言口径（错误语义唯一规则）：动作码不满足 403 forbidden；行级范围不命中
 * 404 not_found / 列表不含；状态不满足 409 conflict（状态守卫划出权限系统）。
 *
 * 三类形态在本批都有样本：
 * - **company**：发票/银行账户/流水/导入批次/导入模板/对账/报销单/承兑交易/持有段/凭证/分录
 *   → 跨公司 404、列表按公司收窄；
 * - **global**：承兑票据主档（acc_bill 无公司列，可见性由名下交易派生）
 *   与 hr 七张表（打卡/导入/日考勤/补卡/工资单/发放/借款，全部无 company_id）；
 * - **via**：报销行（→ 报销单）、凭证行（→ 凭证头）、导入行（→ 导入批次）
 *   → 单条读经 EXISTS 递归归宿，自身不拥有范围。
 *
 * 特殊形态各有一例：发票 reverseMode 派生动作码（S9）、银行导入 import-as-read 重载、
 * 考勤导入自动建档的分支条件权限（D8）、三处跨资源 allOf。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createIamService } from '~/modules/iam/index.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { supportedScopesOf } from '~/platform/meta/resource-authz.ts'
import { testActor } from '~/platform/authz/testing.ts'
import { buildTestApp, createPlatformRegistry, testDatabaseUrl } from './helpers.ts'

const url = testDatabaseUrl()
const run = url ? describe : describe.skip

/** 全量角色：本批各资源的读 + 够跑完别名回归 / 404 / 409 的写码 */
const FULL_CODES = [
  'acc.vat_invoice:read',
  'acc.vat_invoice:create',
  'acc.vat_invoice:update',
  'acc.vat_invoice:delete',
  'acc.vat_invoice:audit',
  'acc.vat_invoice:void',
  'acc.vat_invoice:reverse',
  'acc.bank_account:read',
  'acc.bank_account:create',
  'acc.bank_account:update',
  'acc.bank_account:delete',
  'acc.bank_transaction:read',
  'acc.bank_transaction:create',
  'acc.bank_transaction:update',
  'acc.bank_transaction:delete',
  'acc.bank_transaction:import',
  'acc.bank_transaction:reconcile',
  'acc.bank_import_template:read',
  'acc.bank_import_template:create',
  'acc.bank_import_template:update',
  'acc.bank_import_template:delete',
  'acc.expense_report:read',
  'acc.expense_report:create',
  'acc.expense_report:update',
  'acc.expense_report:delete',
  'acc.expense_report:audit',
  'acc.expense_report:void',
  'acc.bill:read',
  'acc.bill:update',
  'acc.bill:delete',
  'acc.bill_transaction:read',
  'acc.bill_transaction:create',
  'acc.bill_transaction:update',
  'acc.bill_transaction:delete',
  'acc.bill_transaction:audit',
  'acc.bill_transaction:void',
  'acc.bill_holding:read',
  'acc.gl_journal:read',
  'acc.gl_journal:create',
  'acc.gl_journal:update',
  'acc.gl_journal:delete',
  'acc.gl_journal:audit',
  'acc.gl_journal:cancel',
  'acc.gl_entry:read',
  'hr.attendance_punch:read',
  'hr.attendance_punch:import',
  'hr.attendance_day:read',
  'hr.attendance_day:recalc',
  'hr.attendance_correction:read',
  'hr.attendance_correction:create',
  'hr.attendance_correction:update',
  'hr.attendance_correction:delete',
  'hr.payroll:read',
  'hr.payroll:create',
  'hr.payroll:update',
  'hr.payroll:delete',
  'hr.payroll_payment:read',
  'hr.payroll_payment:create',
  'hr.payroll_payment:delete',
  'hr.employee_loan:read',
  'hr.employee_loan:create',
  'hr.employee_loan:update',
  'hr.employee_loan:delete',
  'sys.file:read',
  'sys.file:create',
] as const

/** 只读角色：故意不含任何写码（缺码 403 用例） */
const READ_ONLY_CODES = FULL_CODES.filter((c) => c.endsWith(':read'))

run('PG 集成（扫荡 12：finance/accounting/hr 授权语义）', () => {
  const db = createDb(url!)
  const registry = createPlatformRegistry()
  const authz = createAuthzEnforcer(registry)
  const iam = createIamService(db, registry)
  const admin = testActor({ superAdmin: true, allCompanies: true })
  const adminUserPermit = () => {
    const decision = authz.decideFor(admin, 'sysUsers', 'create')
    if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
    return decision.permit
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const currencyId = crypto.randomUUID()
  const companyA = crypto.randomUUID()
  const companyB = crypto.randomUUID()
  const employeeId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  // 科目：甲乙各一套（凭证行/报销行/银行账户都要求科目同公司）
  const accountBankA = crypto.randomUUID()
  const accountCounterA = crypto.randomUUID()
  const accountExpenseA = crypto.randomUUID()
  const accountPartyA = crypto.randomUUID()
  const accountBankB = crypto.randomUUID()
  const accountCounterB = crypto.randomUUID()

  const bankAccountA = crypto.randomUUID()
  const bankAccountB = crypto.randomUUID()
  const txnA = crypto.randomUUID()
  const txnB = crypto.randomUUID()
  const templateA = crypto.randomUUID()
  const templateB = crypto.randomUUID()
  const fileA = crypto.randomUUID()
  const importA = crypto.randomUUID()
  const importB = crypto.randomUUID()
  const importItemA = crypto.randomUUID()
  const importItemB = crypto.randomUUID()
  const journalA = crypto.randomUUID()
  const journalB = crypto.randomUUID()
  const journalLineA = crypto.randomUUID()
  const journalLineB = crypto.randomUUID()
  const reconA = crypto.randomUUID()
  const entryA = crypto.randomUUID()
  const invoiceDraftA = crypto.randomUUID()
  const invoiceAuditedA = crypto.randomUUID()
  const invoiceB = crypto.randomUUID()
  const reportA = crypto.randomUUID()
  const reportB = crypto.randomUUID()
  const reportItemA = crypto.randomUUID()
  const reportItemB = crypto.randomUUID()
  const billA = crypto.randomUUID()
  const billB = crypto.randomUUID()
  const billTxA = crypto.randomUUID()
  const billTxB = crypto.randomUUID()
  const holdingA = crypto.randomUUID()
  const holdingB = crypto.randomUUID()
  // hr 全局资源（无 company_id）
  const punchA = crypto.randomUUID()
  const hrImportA = crypto.randomUUID()
  const attendanceDayA = crypto.randomUUID()
  const correctionA = crypto.randomUUID()
  const payrollA = crypto.randomUUID()
  const paymentA = crypto.randomUUID()
  const loanA = crypto.randomUUID()

  const fullRoleId = crypto.randomUUID()
  const readRoleId = crypto.randomUUID()
  const importOnlyRoleId = crypto.randomUUID()
  const hrImportRoleId = crypto.randomUUID()

  let fullUserId = ''
  let readUserId = ''
  let importOnlyUserId = ''
  let hrImportUserId = ''
  let fullHeaders: Record<string, string> = {}
  let readHeaders: Record<string, string> = {}
  let importOnlyHeaders: Record<string, string> = {}
  let hrImportHeaders: Record<string, string> = {}
  let app: Awaited<ReturnType<typeof buildTestApp>>

  async function grant(roleId: string, codes: readonly string[]): Promise<void> {
    await db.deleteFrom('sys_role_permission').where('role_id', '=', roleId).execute()
    if (codes.length > 0) {
      await db
        .insertInto('sys_role_permission')
        .values(codes.map((permission) => ({ role_id: roleId, permission, scope: 'all' })))
        .execute()
    }
  }

  async function login(username: string, password: string): Promise<Record<string, string>> {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const { token } = (await res.json()) as { token: string }
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  }

  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1${path}`, { headers })
  const patch = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`/api/v1${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
  const del = (path: string, headers: Record<string, string>) =>
    app.request(`/api/v1${path}`, { method: 'DELETE', headers })

  /** 列表路径的别名回归：断言**本人可达的行在结果里**（只断言别人的不在，对空集永真） */
  async function listIds(
    path: string,
    headers: Record<string, string>,
    body: Record<string, unknown> = {},
  ): Promise<string[]> {
    const res = await post(path, headers, { limit: 200, offset: 0, ...body })
    expect([path, res.status]).toEqual([path, 200])
    const parsed = (await res.json()) as { results: Array<{ id: string }> }
    return parsed.results.map((r) => r.id)
  }

  async function errorCode(res: Response): Promise<string> {
    const body = (await res.json()) as { error?: { code?: string } }
    return body.error?.code ?? ''
  }

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency (id, name, iso_code, symbol, active)
      VALUES (${currencyId}::uuid, ${'扫12币-' + suffix}, ${'F' + suffix.slice(0, 2).toUpperCase()}, 'F', true)
    `.execute(db)
    for (const [id, code, name] of [
      [companyA, 'FA', '扫12公司甲'],
      [companyB, 'FB', '扫12公司乙'],
    ] as const) {
      await sql`
        INSERT INTO bas_company (id, code, name, short_name, base_currency_id)
        VALUES (${id}::uuid, ${code + suffix}, ${name + suffix}, ${code}, ${currencyId}::uuid)
      `.execute(db)
    }
    await db
      .insertInto('bas_account')
      .values([
        {
          id: accountBankA, code: `1002${suffix}`, name: `甲银行存款-${suffix}`,
          direction: 'debit', company_id: companyA, is_group: false, active: true,
        },
        {
          id: accountCounterA, code: `6001${suffix}`, name: `甲主营收入-${suffix}`,
          direction: 'credit', company_id: companyA, is_group: false, active: true,
        },
        {
          id: accountExpenseA, code: `6602${suffix}`, name: `甲管理费用-${suffix}`,
          direction: 'debit', company_id: companyA, is_group: false, active: true,
        },
        {
          id: accountPartyA, code: `1122${suffix}`, name: `甲应收账款-${suffix}`,
          direction: 'debit', company_id: companyA, is_group: false, active: true,
        },
        {
          id: accountBankB, code: `1002B${suffix}`, name: `乙银行存款-${suffix}`,
          direction: 'debit', company_id: companyB, is_group: false, active: true,
        },
        {
          id: accountCounterB, code: `6001B${suffix}`, name: `乙主营收入-${suffix}`,
          direction: 'credit', company_id: companyB, is_group: false, active: true,
        },
      ])
      .execute()
    await db
      .insertInto('hr_employees')
      .values({ id: employeeId, code: `E${suffix}`, name: `扫12员工-${suffix}`, attendance_no: `A${suffix}` })
      .execute()
    await db
      .insertInto('sal_customers')
      .values({ id: customerId, code: `C${suffix}`, name: `扫12客户-${suffix}` })
      .execute()

    // ── 银行账户 / 流水 ────────────────────────────────────────
    await db
      .insertInto('acc_bank_account')
      .values([
        {
          id: bankAccountA, alias: `甲基本户-${suffix}`, bank_name: '中国银行',
          holder_name: '甲', account_no: `A${suffix}`, active: true,
          company_id: companyA, currency_id: currencyId, account_id: accountBankA,
        },
        {
          id: bankAccountB, alias: `乙基本户-${suffix}`, bank_name: '中国银行',
          holder_name: '乙', account_no: `B${suffix}`, active: true,
          company_id: companyB, currency_id: currencyId, account_id: accountBankB,
        },
      ])
      .execute()
    await sql`
      INSERT INTO acc_bank_transaction (
        id, occurred_at, income, balance, summary, reconciled_amount, unreconciled_amount,
        reconcile_status, company_id, bank_account_id)
      VALUES
        (${txnA}::uuid, now(), 1000, 1000, ${'甲收款-' + suffix}, 0, 1000, 'unreconciled',
          ${companyA}::uuid, ${bankAccountA}::uuid),
        (${txnB}::uuid, now(), 2000, 2000, ${'乙收款-' + suffix}, 0, 2000, 'unreconciled',
          ${companyB}::uuid, ${bankAccountB}::uuid)
    `.execute(db)

    // ── 导入模板 / 批次 / 行（import-as-read 重载的样本） ───────
    await db
      .insertInto('acc_bank_import_template')
      .values([
        {
          id: templateA, name: `甲模板-${suffix}`, start_row: 2, datetime_col: 'A',
          datetime_format: 'ymd_dash_hms', income_col: 'B',
          company_id: companyA, bank_account_id: bankAccountA,
        },
        {
          id: templateB, name: `乙模板-${suffix}`, start_row: 2, datetime_col: 'A',
          datetime_format: 'ymd_dash_hms', income_col: 'B',
          company_id: companyB, bank_account_id: bankAccountB,
        },
      ])
      .execute()
    await db
      .insertInto('sys_file')
      .values({
        id: fileA, filename: `扫12流水-${suffix}.xlsx`, content_type: 'application/vnd.ms-excel',
        size: '10', storage: 'local', key: `sweep12/${suffix}.xlsx`, sha256: `sha${suffix}`,
      })
      .execute()
    await db
      .insertInto('acc_bank_import')
      .values([
        {
          id: importA, status: 'parsed', company_id: companyA,
          bank_account_id: bankAccountA, template_id: templateA, file_id: fileA,
        },
        {
          id: importB, status: 'parsed', company_id: companyB,
          bank_account_id: bankAccountB, template_id: templateB, file_id: fileA,
        },
      ])
      .execute()
    await sql`
      INSERT INTO acc_bank_import_item (id, row_no, occurred_at, income, import_id, company_id)
      VALUES
        (${importItemA}::uuid, 2, now(), 1000, ${importA}::uuid, ${companyA}::uuid),
        (${importItemB}::uuid, 2, now(), 2000, ${importB}::uuid, ${companyB}::uuid)
    `.execute(db)

    // ── 凭证 / 凭证行 / 分录 / 对账 ────────────────────────────
    await db
      .insertInto('acc_gl_journal')
      .values([
        {
          id: journalA, voucher_no: `JA${suffix}`, date: '2026-08-01',
          posting_date: '2026-08-01', status: 'audited', company_id: companyA,
        },
        {
          id: journalB, voucher_no: `JB${suffix}`, date: '2026-08-01',
          posting_date: '2026-08-01', status: 'draft', company_id: companyB,
        },
      ])
      .execute()
    await db
      .insertInto('acc_gl_journal_line')
      .values([
        {
          id: journalLineA, idx: 1, debit: '1000', credit: '0',
          journal_id: journalA, company_id: companyA, account_id: accountBankA,
        },
        {
          id: journalLineB, idx: 1, debit: '2000', credit: '0',
          journal_id: journalB, company_id: companyB, account_id: accountBankB,
        },
      ])
      .execute()
    await sql`
      INSERT INTO acc_gl_entry (
        id, posting_date, debit, credit, voucher_type, voucher_id, voucher_no,
        is_cancelled, company_id, account_id)
      VALUES (${entryA}::uuid, '2026-08-01'::date, 1000, 0, 'acc.gl_journal',
        ${journalA}::uuid, ${'JA' + suffix}, false, ${companyA}::uuid, ${accountBankA}::uuid)
    `.execute(db)
    await db
      .insertInto('acc_bank_reconciliation')
      .values({
        id: reconA, amount: '1000', company_id: companyA,
        bank_transaction_id: txnA,
        voucher_type: 'acc.gl_journal', voucher_id: journalA, voucher_no: 'JA' + suffix,
      })
      .execute()

    // ── 发票（草稿 / 已审核 / 乙公司） ─────────────────────────
    await sql`
      INSERT INTO acc_vat_invoice (
        id, doc_no, direction, party_type, party_id, invoice_kind, invoice_code,
        invoice_no, invoice_date, net_total, tax_total, gross_total, status, company_id,
        party_account_id, amount_account_id)
      VALUES
        (${invoiceDraftA}::uuid, ${'IVD' + suffix}, 'inbound', 'employee', ${employeeId}::uuid,
          'special', '', ${'N1' + suffix}, '2026-08-01'::date, 100, 13, 113, 'draft',
          ${companyA}::uuid, ${accountPartyA}::uuid, ${accountExpenseA}::uuid),
        (${invoiceAuditedA}::uuid, ${'IVA' + suffix}, 'inbound', 'employee', ${employeeId}::uuid,
          'special', '', ${'N2' + suffix}, '2026-08-01'::date, 200, 26, 226, 'audited',
          ${companyA}::uuid, ${accountPartyA}::uuid, ${accountExpenseA}::uuid),
        (${invoiceB}::uuid, ${'IVB' + suffix}, 'inbound', 'employee', ${employeeId}::uuid,
          'special', '', ${'N3' + suffix}, '2026-08-01'::date, 300, 39, 339, 'draft',
          ${companyB}::uuid, NULL, NULL)
    `.execute(db)

    // ── 报销单 / 报销行（via 样本） ────────────────────────────
    await db
      .insertInto('acc_expense_report')
      .values([
        {
          id: reportA, doc_no: `ERA${suffix}`, expense_date: '2026-08-01', status: 'draft',
          company_id: companyA, employee_id: employeeId, payment_account_id: accountBankA,
        },
        {
          id: reportB, doc_no: `ERB${suffix}`, expense_date: '2026-08-01', status: 'draft',
          company_id: companyB, employee_id: employeeId, payment_account_id: accountBankB,
        },
      ])
      .execute()
    await db
      .insertInto('acc_expense_report_item')
      .values([
        {
          id: reportItemA, idx: 1, kind: 'manual', summary: '甲差旅', amount: '100',
          report_id: reportA, company_id: companyA, expense_account_id: accountExpenseA,
        },
        {
          id: reportItemB, idx: 1, kind: 'manual', summary: '乙差旅', amount: '200',
          report_id: reportB, company_id: companyB, expense_account_id: accountCounterB,
        },
      ])
      .execute()

    // ── 承兑票据（global，可见性由交易派生） ───────────────────
    await db
      .insertInto('acc_bill')
      .values([
        {
          id: billA, bill_no: `BA${suffix}`, bill_kind: 'bank_acceptance',
          due_date: '2026-12-31', face_amount: '1000', transferable: true,
        },
        {
          id: billB, bill_no: `BB${suffix}`, bill_kind: 'bank_acceptance',
          due_date: '2026-12-31', face_amount: '2000', transferable: true,
        },
      ])
      .execute()
    await db
      .insertInto('acc_bill_transaction')
      .values([
        {
          id: billTxA, doc_no: `BTA${suffix}`, transaction_type: 'receive',
          occurred_on: '2026-08-01', sub_start: '1', sub_end: '100', amount: '1',
          party_type: 'customer', party_id: customerId, status: 'draft',
          company_id: companyA, bank_account_id: bankAccountA, bill_id: billA,
        },
        {
          id: billTxB, doc_no: `BTB${suffix}`, transaction_type: 'receive',
          occurred_on: '2026-08-01', sub_start: '1', sub_end: '100', amount: '1',
          party_type: 'customer', party_id: customerId, status: 'draft',
          company_id: companyB, bank_account_id: bankAccountB, bill_id: billB,
        },
      ])
      .execute()
    await db
      .insertInto('acc_bill_holding')
      .values([
        {
          id: holdingA, bill_no: `BA${suffix}`, sub_start: '1', sub_end: '100', amount: '1',
          due_date: '2026-12-31', acquired_on: '2026-08-01', company_id: companyA,
          bank_account_id: bankAccountA, bill_id: billA, source_transaction_id: billTxA,
        },
        {
          id: holdingB, bill_no: `BB${suffix}`, sub_start: '1', sub_end: '100', amount: '1',
          due_date: '2026-12-31', acquired_on: '2026-08-01', company_id: companyB,
          bank_account_id: bankAccountB, bill_id: billB, source_transaction_id: billTxB,
        },
      ])
      .execute()

    // ── hr（七张表都无 company_id：global） ────────────────────
    await db
      .insertInto('hr_attendance_import')
      .values({ id: hrImportA, status: 'parsed', file_id: fileA, total_rows: '1' })
      .execute()
    await sql`
      INSERT INTO hr_attendance_punch (id, attendance_no, punched_at, employee_id, import_id)
      VALUES (${punchA}::uuid, ${'A' + suffix}, '2026-08-01 09:00:00'::timestamp,
        ${employeeId}::uuid, ${hrImportA}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO hr_attendance_day (
        id, date, morning_in, normal_hours, overtime_hours, bonus_workday, status, employee_id)
      VALUES (${attendanceDayA}::uuid, '2026-08-01'::date, '09:00:00'::time, 8, 0, 0,
        'normal', ${employeeId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO hr_attendance_correction (id, date, times, employee_id)
      VALUES (${correctionA}::uuid, '2026-08-02'::date,
        ARRAY['09:00:00'::time], ${employeeId}::uuid)
    `.execute(db)
    await db
      .insertInto('hr_payroll')
      .values({
        id: payrollA, month: '2026-07', workdays: '22', attendance_days: '22',
        missing_days: '0', overtime_hours: '0', daily_wage: '260', base_amount: '5720',
        allowance: '0', bonus: '0', fine: '0', loan_deduction: '0', payable: '5720',
        status: 'pending', employee_id: employeeId,
      })
      .execute()
    await db
      .insertInto('hr_payroll_payment')
      .values({
        id: paymentA, month: '2026-07', paid_on: '2026-08-05', amount: '1000',
        kind: 'normal', payroll_id: payrollA, employee_id: employeeId,
      })
      .execute()
    await db
      .insertInto('hr_employee_loan')
      .values({
        id: loanA, kind: 'borrow', occurred_on: '2026-07-01', amount: '500',
        employee_id: employeeId,
      })
      .execute()

    await db
      .insertInto('sys_role')
      .values([
        { id: fullRoleId, code: `sweep12-full-${suffix}`, name: `扫12全量-${suffix}` },
        { id: readRoleId, code: `sweep12-read-${suffix}`, name: `扫12只读-${suffix}` },
        { id: importOnlyRoleId, code: `sweep12-imp-${suffix}`, name: `扫12导入-${suffix}` },
        { id: hrImportRoleId, code: `sweep12-hrimp-${suffix}`, name: `扫12考勤导入-${suffix}` },
      ])
      .execute()
    await grant(fullRoleId, FULL_CODES)
    await grant(readRoleId, READ_ONLY_CODES)
    // 只有 import 码、没有 bank_transaction:read/create：验 import-as-read 与 runImport 的 allOf
    await grant(importOnlyRoleId, ['acc.bank_transaction:import'])
    // 只有考勤导入码、没有 hr.employee:create：验 D8 分支条件权限
    await grant(hrImportRoleId, ['hr.attendance_punch:import', 'sys.file:read'])

    // 文件上传（D8 用真实 .dat）需要默认本地存储
    await db
      .insertInto('sys_storage')
      .values({
        name: `sweep12-${suffix}`,
        label: `扫12本地-${suffix}`,
        kind: 'local',
        root: `/tmp/sweep12-${suffix}`,
        is_default: false,
      })
      .onConflict((oc) => oc.column('name').doNothing())
      .execute()
    await db.updateTable('sys_storage').set({ is_default: false }).execute()
    await db
      .updateTable('sys_storage')
      .set({ is_default: true })
      .where('name', '=', `sweep12-${suffix}`)
      .execute()

    app = await buildTestApp(db)
    // 四个用户都只授权公司甲：公司域资源的跨公司边界由此可验
    for (const [roleId, tag] of [
      [fullRoleId, 'full'],
      [readRoleId, 'read'],
      [importOnlyRoleId, 'imp'],
      [hrImportRoleId, 'hrimp'],
    ] as const) {
      const created = await iam.createUser(adminUserPermit(), {
        username: `sweep12-${tag}-${suffix}`,
        name: `扫12-${tag}`,
        roleIds: [roleId],
        companyIds: [companyA],
      })
      const headers = await login(`sweep12-${tag}-${suffix}`, created.password)
      if (tag === 'full') {
        fullUserId = created.user.id
        fullHeaders = headers
      } else if (tag === 'read') {
        readUserId = created.user.id
        readHeaders = headers
      } else if (tag === 'imp') {
        importOnlyUserId = created.user.id
        importOnlyHeaders = headers
      } else {
        hrImportUserId = created.user.id
        hrImportHeaders = headers
      }
    }
  })

  afterAll(async () => {
    // 业务数据先删：acc_bank_import.imported_by_id / 打卡等外键指向 sys_user
    await db.deleteFrom('hr_attendance_punch').where('employee_id', '=', employeeId).execute()
    await db.deleteFrom('hr_employee_loan').where('id', '=', loanA).execute()
    await db.deleteFrom('hr_payroll_payment').where('id', '=', paymentA).execute()
    await db.deleteFrom('hr_payroll').where('id', '=', payrollA).execute()
    await db.deleteFrom('hr_attendance_correction').where('id', '=', correctionA).execute()
    await db.deleteFrom('hr_attendance_day').where('id', '=', attendanceDayA).execute()
    await db.deleteFrom('hr_attendance_punch').where('id', '=', punchA).execute()
    await db.deleteFrom('hr_attendance_import').where('id', '=', hrImportA).execute()

    await db.deleteFrom('acc_bill_holding').where('id', 'in', [holdingA, holdingB]).execute()
    await db.deleteFrom('acc_bill_transaction').where('id', 'in', [billTxA, billTxB]).execute()
    await db.deleteFrom('acc_bill').where('id', 'in', [billA, billB]).execute()
    await db
      .deleteFrom('acc_expense_report_item')
      .where('id', 'in', [reportItemA, reportItemB])
      .execute()
    await db.deleteFrom('acc_expense_report').where('id', 'in', [reportA, reportB]).execute()
    await db
      .deleteFrom('acc_vat_invoice')
      .where('id', 'in', [invoiceDraftA, invoiceAuditedA, invoiceB])
      .execute()
    await db.deleteFrom('acc_bank_reconciliation').where('id', '=', reconA).execute()
    await db.deleteFrom('acc_gl_entry').where('id', '=', entryA).execute()
    await db
      .deleteFrom('acc_gl_journal_line')
      .where('id', 'in', [journalLineA, journalLineB])
      .execute()
    await db.deleteFrom('acc_gl_journal').where('id', 'in', [journalA, journalB]).execute()
    await db
      .deleteFrom('acc_bank_import_item')
      .where('id', 'in', [importItemA, importItemB])
      .execute()
    await db.deleteFrom('acc_bank_import').where('id', 'in', [importA, importB]).execute()
    await db.deleteFrom('sys_file').where('id', '=', fileA).execute()
    await db
      .deleteFrom('acc_bank_import_template')
      .where('id', 'in', [templateA, templateB])
      .execute()
    // runImport 会按导入行生成流水，按公司兜底清
    for (const id of [companyA, companyB]) {
      await db.deleteFrom('acc_bank_transaction').where('company_id', '=', id).execute()
    }
    await db.deleteFrom('acc_bank_account').where('id', 'in', [bankAccountA, bankAccountB]).execute()
    await db.deleteFrom('sal_customers').where('id', '=', customerId).execute()
    await db.deleteFrom('hr_employees').where('id', '=', employeeId).execute()
    await db
      .deleteFrom('bas_account')
      .where('id', 'in', [
        accountBankA, accountCounterA, accountExpenseA, accountPartyA,
        accountBankB, accountCounterB,
      ])
      .execute()
    for (const id of [companyA, companyB]) {
      await db.deleteFrom('sys_audit_log').where('company_id', '=', id).execute()
    }

    // 角色/用户最后删（业务行的 created_by/imported_by 外键已清）
    for (const id of [fullUserId, readUserId, importOnlyUserId, hrImportUserId]) {
      if (!id) continue
      await db.deleteFrom('sys_user_role').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', id).execute()
      await db.deleteFrom('sys_audit_log').where('record_id', '=', id).execute()
      await db.deleteFrom('sys_file').where('uploaded_by_id', '=', id).execute()
      const row = await db
        .selectFrom('sys_user')
        .select('auth_user_id')
        .where('id', '=', id)
        .executeTakeFirst()
      await db.deleteFrom('sys_user').where('id', '=', id).execute()
      if (row?.auth_user_id) {
        await db.deleteFrom('auth_user').where('id', '=', row.auth_user_id).execute()
      }
    }
    const roleIds = [fullRoleId, readRoleId, importOnlyRoleId, hrImportRoleId]
    await db.deleteFrom('sys_role_permission').where('role_id', 'in', roleIds).execute()
    await db.deleteFrom('sys_role').where('id', 'in', roleIds).execute()
    // 公司最后删：sys_user_company 外键指向 bas_company
    await db.deleteFrom('bas_company').where('id', 'in', [companyA, companyB]).execute()
    await db.deleteFrom('bas_currency').where('id', '=', currencyId).execute()
    await db.deleteFrom('sys_storage').where('name', '=', `sweep12-${suffix}`).execute()
    await db.destroy()
  })

  test('别名回归：19 条列表路径都能看到本人可达的行', async () => {
    // finance 公司域（裸表别名）
    expect(await listIds('/finance/vat-invoices/query', fullHeaders)).toContain(invoiceDraftA)
    expect(await listIds('/finance/bank-accounts/query', fullHeaders)).toContain(bankAccountA)
    expect(await listIds('/finance/bank-transactions/query', fullHeaders)).toContain(txnA)
    expect(await listIds('/finance/bank-import-templates/query', fullHeaders)).toContain(templateA)
    expect(await listIds('/finance/bank-imports/query', fullHeaders)).toContain(importA)
    expect(await listIds('/finance/bank-import-items/query', fullHeaders)).toContain(importItemA)
    expect(await listIds('/finance/bank-reconciliations/query', fullHeaders)).toContain(reconA)
    expect(await listIds('/finance/expense-reports/query', fullHeaders)).toContain(reportA)
    expect(await listIds('/finance/expense-report-items/query', fullHeaders)).toContain(reportItemA)
    expect(await listIds('/finance/bill-transactions/query', fullHeaders)).toContain(billTxA)
    expect(await listIds('/finance/bill-holdings/query', fullHeaders)).toContain(holdingA)
    // 承兑票据是 global，可见性由「名下有可达交易」派生（EXISTS 子查询别名 scope_tx）
    expect(await listIds('/finance/bills/query', fullHeaders)).toContain(billA)
    // accounting（投影子查询别名 journals / journal_lines）
    expect(await listIds('/accounting/gl-journals/query', fullHeaders)).toContain(journalA)
    expect(await listIds('/accounting/gl-journal-lines/query', fullHeaders)).toContain(journalLineA)
    expect(await listIds('/accounting/gl-entries/query', fullHeaders)).toContain(entryA)
    // hr global（其中导入批次投影别名是 i、工资单是 p）
    expect(await listIds('/hr/attendance-punches/query', fullHeaders)).toContain(punchA)
    expect(await listIds('/hr/attendance-imports/query', fullHeaders)).toContain(hrImportA)
    expect(await listIds('/hr/attendance-days/query', fullHeaders)).toContain(attendanceDayA)
    expect(await listIds('/hr/attendance-corrections/query', fullHeaders)).toContain(correctionA)
    expect(await listIds('/hr/payrolls/query', fullHeaders)).toContain(payrollA)
    expect(await listIds('/hr/payroll-payments/query', fullHeaders)).toContain(paymentA)
    expect(await listIds('/hr/employee-loans/query', fullHeaders)).toContain(loanA)
  })

  test('公司域跨公司：单条 404、列表不含；本公司同路径 200', async () => {
    const crossPaths: Array<[string, string]> = [
      ['/finance/vat-invoices', invoiceB],
      ['/finance/bank-accounts', bankAccountB],
      ['/finance/bank-transactions', txnB],
      ['/finance/bank-import-templates', templateB],
      ['/finance/bank-imports', importB],
      ['/finance/expense-reports', reportB],
      ['/finance/bill-transactions', billTxB],
      ['/finance/bill-holdings', holdingB],
      ['/accounting/gl-journals', journalB],
    ]
    for (const [base, id] of crossPaths) {
      const res = await get(`${base}/${id}`, fullHeaders)
      expect([base, res.status]).toEqual([base, 404])
      expect([base, await errorCode(res)]).toEqual([base, 'not_found'])
    }
    // 列表同样不含乙公司行
    expect(await listIds('/finance/bank-accounts/query', fullHeaders)).not.toContain(bankAccountB)
    expect(await listIds('/accounting/gl-journals/query', fullHeaders)).not.toContain(journalB)
    // 本公司同路径 200（证明 404 是行级边界，不是路由/别名写错）
    expect((await get(`/finance/bank-accounts/${bankAccountA}`, fullHeaders)).status).toBe(200)
    expect((await get(`/accounting/gl-journals/${journalA}`, fullHeaders)).status).toBe(200)
  })

  test('via 子行跨公司：母单不可达即 404（行自身公司列不再是判据）', async () => {
    // 报销行 → 报销单；凭证行 → 凭证头；导入行 → 导入批次
    for (const [base, id] of [
      ['/finance/expense-report-items', reportItemB],
      ['/accounting/gl-journal-lines', journalLineB],
      ['/finance/bank-import-items', importItemB],
    ] as const) {
      const res = await get(`${base}/${id}`, fullHeaders)
      expect([base, res.status]).toEqual([base, 404])
      expect([base, await errorCode(res)]).toEqual([base, 'not_found'])
    }
    // 本公司子行照读（via 链递归到可达母单）
    expect((await get(`/finance/expense-report-items/${reportItemA}`, fullHeaders)).status).toBe(200)
    expect((await get(`/accounting/gl-journal-lines/${journalLineA}`, fullHeaders)).status).toBe(200)
    expect((await get(`/finance/bank-import-items/${importItemA}`, fullHeaders)).status).toBe(200)
  })

  test('承兑票据（global）：可见性由名下交易派生，无可达交易的票据 404', async () => {
    const cross = await get(`/finance/bills/${billB}`, fullHeaders)
    expect(cross.status).toBe(404)
    expect(await errorCode(cross)).toBe('not_found')
    expect(await listIds('/finance/bills/query', fullHeaders)).not.toContain(billB)
    expect((await get(`/finance/bills/${billA}`, fullHeaders)).status).toBe(200)
  })

  test('缺码 403：只读角色写路径全 403，同角色读路径 200（403 唯一成因＝码不满足）', async () => {
    const writes: Array<[string, Promise<Response> | Response]> = [
      ['发票 create', post('/finance/vat-invoices', readHeaders, {
        companyId: companyA, direction: 'INBOUND', partyType: 'EMPLOYEE',
        partyId: employeeId, invoiceKind: 'SPECIAL',
      })],
      ['银行账户 delete', del(`/finance/bank-accounts/${bankAccountA}`, readHeaders)],
      ['报销单 audit', post(`/finance/expense-reports/${reportA}/audit`, readHeaders, {
        postingDate: '2026-08-01',
      })],
      ['凭证 cancel', post(`/accounting/gl-journals/${journalA}/cancel`, readHeaders, {})],
      ['补卡 delete', del(`/hr/attendance-corrections/${correctionA}`, readHeaders)],
      ['工资单 delete', del(`/hr/payrolls/${payrollA}`, readHeaders)],
    ]
    for (const [label, promise] of writes) {
      const res = await promise
      expect([label, res.status]).toEqual([label, 403])
      expect([label, await errorCode(res)]).toEqual([label, 'forbidden'])
    }
    // 对照：同一角色的读路径 200（证明 403 来自缺写码，不是登录/路由问题）
    expect((await get(`/finance/bank-accounts/${bankAccountA}`, readHeaders)).status).toBe(200)
    expect((await get(`/hr/payrolls/${payrollA}`, readHeaders)).status).toBe(200)
  })

  test('状态守卫 409：领域不变量没被卷进权限系统', async () => {
    // 已审核发票不可改（仅草稿可改）
    const patchAudited = await patch(`/finance/vat-invoices/${invoiceAuditedA}`, fullHeaders, {
      remarks: 'x',
    })
    expect(patchAudited.status).toBe(409)
    expect(await errorCode(patchAudited)).toBe('conflict')
    // 已审核凭证不可删（仅草稿可改删）
    const delAudited = await del(`/accounting/gl-journals/${journalA}`, fullHeaders)
    expect(delAudited.status).toBe(409)
    expect(await errorCode(delAudited)).toBe('conflict')
    // 已导入/已解析状态门：删除已有对账的流水
    const delLinkedTxn = await del(`/finance/bank-transactions/${txnA}`, fullHeaders)
    expect(delLinkedTxn.status).toBe(409)
    expect(await errorCode(delLinkedTxn)).toBe('conflict')
  })

  test('create 目标公司未授权：404（旧 forbidden），且入参校验先于公司边界', async () => {
    const crossCreate = await post('/finance/bank-accounts', fullHeaders, {
      alias: `跨公司-${suffix}`, bankName: '中国银行', holderName: '乙',
      accountNo: `X${suffix}`, companyId: companyB, currencyId,
    })
    expect(crossCreate.status).toBe(404)
    expect(await errorCode(crossCreate)).toBe('not_found')
    // 必填校验（400）先于公司边界（404）：alias 为空且公司未授权 → 报 400
    const invalid = await post('/finance/bank-accounts', fullHeaders, {
      alias: '', bankName: '中国银行', holderName: '乙',
      accountNo: `Y${suffix}`, companyId: companyB, currencyId,
    })
    expect(invalid.status).toBe(400)
    expect(await errorCode(invalid)).toBe('validation')
  })

  test('S9 发票 reverseMode 派生动作码：void 与 reverse 各自独立门控', async () => {
    // 只授 void、不授 reverse
    await grant(readRoleId, [...READ_ONLY_CODES, 'acc.vat_invoice:void'])
    const reverseDenied = await post(
      `/finance/vat-invoices/${invoiceAuditedA}/reverse`,
      readHeaders,
      { postingDate: '2026-08-05' },
    )
    expect(reverseDenied.status).toBe(403)
    expect(await errorCode(reverseDenied)).toBe('forbidden')
    // 同一角色的 void 端点不再 403（派生动作码分别判定，不是同一个码）
    const voidRes = await post(`/finance/vat-invoices/${invoiceAuditedA}/void`, readHeaders, {})
    expect(voidRes.status).not.toBe(403)
    await grant(readRoleId, READ_ONLY_CODES)
  })

  test('import-as-read 重载：单持 import 码即可读导入批次与行，但读流水仍 403', async () => {
    // 只有 acc.bank_transaction:import 的角色能读导入批次/行（readAnyOf 声明即执行）
    expect((await get(`/finance/bank-imports/${importA}`, importOnlyHeaders)).status).toBe(200)
    expect(await listIds('/finance/bank-imports/query', importOnlyHeaders)).toContain(importA)
    expect((await get(`/finance/bank-import-items/${importItemA}`, importOnlyHeaders)).status).toBe(200)
    // 但它没有 acc.bank_transaction:read，读流水仍 403（重载只覆盖导入批次这一个资源）
    const txnRead = await get(`/finance/bank-transactions/${txnA}`, importOnlyHeaders)
    expect(txnRead.status).toBe(403)
    expect(await errorCode(txnRead)).toBe('forbidden')
    // 跨资源 allOf：执行导入要 ∧ acc.bank_transaction:create，缺码 403
    const runDenied = await post(`/finance/bank-imports/${importA}/import`, importOnlyHeaders, {})
    expect(runDenied.status).toBe(403)
    expect(await errorCode(runDenied)).toBe('forbidden')
    // 齐码后不再是 403（领域上会因文件不可读/行校验另行报错，但不是码级拒绝）
    expect((await post(`/finance/bank-imports/${importA}/import`, fullHeaders, {})).status)
      .not.toBe(403)
  })

  test('跨资源 allOf 三处：建导入批次 ∧ sys.file:read、对账余额 ∧ gl_journal:read、考勤导入建批次 ∧ sys.file:read', async () => {
    // 1) 银行导入建批次：只有 import 码、没有 sys.file:read → 403
    const createImportDenied = await post('/finance/bank-imports', importOnlyHeaders, {
      companyId: companyA, bankAccountId: bankAccountA, templateId: templateA, fileId: fileA,
    })
    expect(createImportDenied.status).toBe(403)
    expect(await errorCode(createImportDenied)).toBe('forbidden')
    // 2) 对账余额：全量角色有两码 → 非 403；去掉 gl_journal:read → 403
    expect(
      (await get(
        `/finance/bank-reconciliations/remaining?bankTransactionId=${txnA}&journalId=${journalA}`,
        fullHeaders,
      )).status,
    ).not.toBe(403)
    await grant(readRoleId, READ_ONLY_CODES.filter((c) => c !== 'acc.gl_journal:read'))
    const remainingDenied = await get(
      `/finance/bank-reconciliations/remaining?bankTransactionId=${txnA}&journalId=${journalA}`,
      readHeaders,
    )
    expect(remainingDenied.status).toBe(403)
    expect(await errorCode(remainingDenied)).toBe('forbidden')
    await grant(readRoleId, READ_ONLY_CODES)
    // 3) 考勤导入建批次：hrimp 角色带 sys.file:read → 非 403；去掉后 403
    await grant(hrImportRoleId, ['hr.attendance_punch:import'])
    const hrCreateDenied = await post('/hr/attendance-imports', hrImportHeaders, { fileId: fileA })
    expect(hrCreateDenied.status).toBe(403)
    expect(await errorCode(hrCreateDenied)).toBe('forbidden')
    await grant(hrImportRoleId, ['hr.attendance_punch:import', 'sys.file:read'])
    expect((await post('/hr/attendance-imports', hrImportHeaders, { fileId: fileA })).status)
      .not.toBe(403)
  })

  test('D8 考勤导入分支条件权限：勾选自动建档才要 hr.employee:create', async () => {
    // 真实上传一个含未匹配编号的 .dat（分支要走到「有 missing 编号」才触发二次取证）
    const unknownNo = `Z${suffix.slice(0, 6)}`
    const content = [
      `${suffix.slice(0, 6)}A 2099-03-01 08:00:00`,
      `${unknownNo} 2099-03-01 08:05:00`,
    ].join('\n')
    const form = new FormData()
    form.append('file', new Blob([content], { type: 'text/plain' }), `sweep12-${suffix}.dat`)
    const uploaded = await app.request('/api/v1/files', {
      method: 'POST',
      headers: { authorization: fullHeaders.authorization! },
      body: form,
    })
    expect(uploaded.status).toBe(201)
    const { file } = (await uploaded.json()) as { file: { id: string } }

    // 全量角色（带 hr.attendance_punch:import ∧ sys.file:read）建批次
    const created = await post('/hr/attendance-imports', fullHeaders, { fileId: file.id })
    expect(created.status).toBe(201)
    const batch = (await created.json()) as { id: string }

    // 勾选自动建档：full 角色没有 hr.employee:create → 403（分支内二次取凭证）
    const withAuto = await post(
      `/hr/attendance-imports/${batch.id}/import`,
      fullHeaders,
      { autoCreateEmployees: true },
    )
    expect(withAuto.status).toBe(403)
    expect(await errorCode(withAuto)).toBe('forbidden')

    // 不勾选：同一批次、同一角色不再撞 employee:create（分支不进入即不要该码）
    const withoutAuto = await post(
      `/hr/attendance-imports/${batch.id}/import`,
      fullHeaders,
      { autoCreateEmployees: false },
    )
    expect(withoutAuto.status).toBe(200)

    await db.deleteFrom('hr_attendance_punch').where('import_id', '=', batch.id).execute()
    await db.deleteFrom('hr_attendance_import').where('id', '=', batch.id).execute()
    await db.deleteFrom('sys_file').where('id', '=', file.id).execute()
  })

  test('hr 全局资源：零公司授权也照读（无公司列即无公司边界）', async () => {
    const created = await iam.createUser(adminUserPermit(), {
      username: `sweep12-nocompany-${suffix}`,
      name: '扫12无公司',
      roleIds: [readRoleId],
      companyIds: [],
    })
    const headers = await login(`sweep12-nocompany-${suffix}`, created.password)
    try {
      // hr 七张表都是 global：零公司授权照样可读
      expect(await listIds('/hr/payrolls/query', headers)).toContain(payrollA)
      expect(await listIds('/hr/attendance-days/query', headers)).toContain(attendanceDayA)
      expect((await get(`/hr/employee-loans/${loanA}`, headers)).status).toBe(200)
      // 对照：公司域资源在零公司授权下是空列表 + 单条 404（spec §5）
      expect(await listIds('/finance/bank-accounts/query', headers)).toEqual([])
      expect((await get(`/finance/bank-accounts/${bankAccountA}`, headers)).status).toBe(404)
    } finally {
      await db.deleteFrom('sys_user_role').where('user_id', '=', created.user.id).execute()
      await db.deleteFrom('sys_user_company').where('user_id', '=', created.user.id).execute()
      await db.deleteFrom('sys_audit_log').where('record_id', '=', created.user.id).execute()
      const row = await db
        .selectFrom('sys_user')
        .select('auth_user_id')
        .where('id', '=', created.user.id)
        .executeTakeFirst()
      await db.deleteFrom('sys_user').where('id', '=', created.user.id).execute()
      if (row?.auth_user_id) {
        await db.deleteFrom('auth_user').where('id', '=', row.auth_user_id).execute()
      }
    }
  })

  test('单公司聚合（应收应付报表）：公司未授权返回空结果，不再 forbidden', async () => {
    const own = await get(`/accounting/ar-ap-report?companyId=${companyA}&asOf=2026-08-31`, fullHeaders)
    expect(own.status).toBe(200)
    const cross = await get(
      `/accounting/ar-ap-report?companyId=${companyB}&asOf=2026-08-31`,
      fullHeaders,
    )
    expect(cross.status).toBe(200)
    const body = (await cross.json()) as { rows: unknown[]; roleAccounts: Record<string, unknown> }
    expect(body.rows).toEqual([])
    expect(body.roleAccounts).toEqual({})
  })

  test('本批前缀 supportedScopes 只出 all（未加 owner/dept 绑定，矩阵不新增档位）', () => {
    const prefixes = new Set([
      'acc.vat_invoice', 'acc.bank_account', 'acc.bank_transaction', 'acc.bank_import_template',
      'acc.expense_report', 'acc.bill', 'acc.bill_transaction', 'acc.bill_holding',
      'acc.gl_journal', 'acc.gl_entry',
      'hr.attendance_punch', 'hr.attendance_day', 'hr.attendance_correction',
      'hr.payroll', 'hr.payroll_payment', 'hr.employee_loan',
    ])
    for (const group of registry.permissionCatalog()) {
      if (!prefixes.has(group.prefix)) continue
      expect([group.prefix, group.supportedScopes]).toEqual([group.prefix, ['all']])
    }
    // via 子行不拥有自己的范围（否则同前缀交集会把维度交没）
    for (const name of ['accExpenseReportItems', 'accGlJournalLines', 'accBankImportItems']) {
      const meta = registry.get(name)!
      expect([name, supportedScopesOf(meta)]).toEqual([name, []])
    }
  })
})
