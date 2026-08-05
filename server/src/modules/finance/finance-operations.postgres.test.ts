/**
 * 工单 12：银行对账状态派生、报销核销/作废、票据重放不变量。
 * 门控 SYNIE_TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createJournalService } from '~/modules/accounting/journal-service.ts'
import { createBankingService } from './banking-service.ts'
import { createExpenseService } from './expense-service.ts'
import { createBillService } from './bill-service.ts'
import { createVatInvoiceService } from './invoice-service.ts'
import { createReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import { testActor } from '~/platform/authz/testing.ts'


/** 编号服务需要 sealed registry（授权归宿解析） */
const numberingRegistry = createSealedResourceRegistry()
/** 编号规则（global）：夹具建规则现取凭证（superAdmin → rowFilter 全集） */
function numberingPermit(actor: Parameters<typeof numberingAuthz.decideFor>[0]) {
  const decision = numberingAuthz.decideFor(actor, 'sysNumberingRules', 'create')
  if (decision.outcome !== 'permit') throw new Error('夹具应当 permit')
  return decision.permit
}
const numberingAuthz = createAuthzEnforcer(numberingRegistry)

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（财务运营 12）', () => {
  const db = createDb(url!)
  const numbering = createNumberingService(db, buildNumberingCatalog(numberingRegistry), numberingRegistry)
  const gl = createGlEngine()
  const reconciliations = createReconciliationService(db, numbering, gl)
  const banking = createBankingService(db, numbering, {
    journals: createJournalService(db, numbering, gl),
  })
  const expenses = createExpenseService(db, numbering, gl)
  const bills = createBillService(db, numbering, { gl })
  const invoices = createVatInvoiceService(db, numbering, { gl, reconciliations })

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()
  const prefix = `FO${suffix}`
  const currencyId = crypto.randomUUID()
  const companyId = crypto.randomUUID()
  const employeeId = crypto.randomUUID()
  const customerId = crypto.randomUUID()
  const accountBank = crypto.randomUUID()
  const accountCounter = crypto.randomUUID()
  const accountExpense = crypto.randomUUID()
  const accountPayable = crypto.randomUUID()
  const accountBill = crypto.randomUUID()
  const accountSettle = crypto.randomUUID()
  const accountInterest = crypto.randomUUID()
  const userId = crypto.randomUUID()

  const actor: Actor = testActor({
    userId,
    username: 'fo-test',
    name: '财务运营测试',
    superAdmin: true,
    allCompanies: true,
    permissions: new Set(),
    companyIds: [],
  })

  const today = '2099-06-15'
  const due = '2099-12-31'

  beforeAll(async () => {
    await sql`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES (${currencyId}::uuid, ${prefix + '币'}, ${'F' + suffix.slice(0, 2)}, '¤', true)
    `.execute(db)
    await sql`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES (${companyId}::uuid, ${'C' + suffix}, ${prefix + '公司'}, 'FO', ${currencyId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO sys_user(id,username,name,hashed_password)
      VALUES (${userId}::uuid, ${'u' + suffix}, '财务用户', 'x')
    `.execute(db)
    await sql`
      INSERT INTO hr_employees(id,code,name)
      VALUES (${employeeId}::uuid, ${'E' + suffix}, ${prefix + '员工'})
    `.execute(db)
    await sql`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES (${customerId}::uuid, ${'CU' + suffix}, ${prefix + '客户'}, 'CU')
    `.execute(db)
    await sql`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${accountBank}::uuid, ${'B' + suffix}, ${prefix + '银行'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${accountCounter}::uuid, ${'C' + suffix}, ${prefix + '对方'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${accountExpense}::uuid, ${'X' + suffix}, ${prefix + '费用'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${accountPayable}::uuid, ${'P' + suffix}, ${prefix + '应付'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, 'other_payable'),
        (${accountBill}::uuid, ${'L' + suffix}, ${prefix + '票据'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${accountSettle}::uuid, ${'S' + suffix}, ${prefix + '结算'}, 'credit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL),
        (${accountInterest}::uuid, ${'I' + suffix}, ${prefix + '利息'}, 'debit', false, true,
          ${companyId}::uuid, ${currencyId}::uuid, NULL)
    `.execute(db)
    // 取号规则按 resource 全局唯一启用；测试库可能已有，缺失时再补
    const numberingActor: Actor = testActor({
      userId,
      username: 'fo-test',
      name: '财务运营测试',
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(['sys.numbering:create', 'sys.numbering:read']),
      companyIds: [],
    })
    for (const resource of [
      'acc.expense_report',
      'acc.bill_transaction',
      'acc.vat_invoice',
      'acc.gl_journal',
    ] as const) {
      const exists = await sql<{ e: boolean }>`
        SELECT EXISTS(
          SELECT 1 FROM sys_numbering_rule WHERE resource=${resource} AND enabled
        ) AS e
      `.execute(db)
      if (exists.rows[0]?.e) continue
      await numbering.create(numberingPermit(numberingActor), {
        resource,
        name: `${resource}-${suffix}`,
        segments: [
          { type: 'text', value: prefix.slice(0, 6) },
          { type: 'seq', padding: 4 },
        ],
        perCompany: true,
        enabled: true,
      })
    }
  })

  afterAll(async () => {
    // 先清票据持有/交易（引用银行账户）
    await sql`DELETE FROM acc_bill_holding WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bill_transaction WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bill WHERE bill_no LIKE ${prefix + '%'}`.execute(db)
    await sql`DELETE FROM acc_bank_reconciliation WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bank_transaction WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bank_import_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bank_import WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bank_import_template WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_bank_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_expense_report_item WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_expense_report WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_vat_invoice WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_entry WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_journal_line WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM acc_gl_journal WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_account WHERE company_id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM sal_customers WHERE id=${customerId}::uuid`.execute(db)
    await sql`DELETE FROM hr_employees WHERE id=${employeeId}::uuid`.execute(db)
    await sql`DELETE FROM bas_company WHERE id=${companyId}::uuid`.execute(db)
    await sql`DELETE FROM bas_currency WHERE id=${currencyId}::uuid`.execute(db)
    await sql`DELETE FROM sys_user WHERE id=${userId}::uuid`.execute(db)
    await sql`DELETE FROM sys_numbering_counter WHERE rule_id IN (
      SELECT id FROM sys_numbering_rule WHERE name LIKE ${'%' + suffix}
    )`.execute(db)
    await sql`DELETE FROM sys_numbering_rule WHERE name LIKE ${'%' + suffix}`.execute(db)
    await db.destroy()
  })

  test('银行对账：状态派生 + 解除重建', async () => {
    const account = await banking.createAccount(actor, {
      alias: prefix + '户',
      bankName: '测试银行',
      holderName: '持有人',
      accountNo: '6222' + suffix.slice(0, 8),
      companyId,
      currencyId,
      accountId: accountBank,
    })
    const txn = await banking.createTransaction(actor, {
      occurredAt: new Date('2099-06-15T10:00:00Z').toISOString(),
      income: '1234.56',
      companyId,
      bankAccountId: account.id,
      summary: '测试收入',
    })
    expect(txn.reconcileStatus).toBe('UNRECONCILED')
    expect(txn.unreconciledAmount).toBe('1234.56')

    // 手工凭证：借银行 1000
    const journalId = crypto.randomUUID()
    await sql`
      INSERT INTO acc_gl_journal(id,voucher_no,date,posting_date,status,company_id,created_by_id)
      VALUES (${journalId}::uuid, ${prefix + 'J1'}, ${today}::date, ${today}::date, 'audited',
        ${companyId}::uuid, ${userId}::uuid)
    `.execute(db)
    await sql`
      INSERT INTO acc_gl_journal_line(idx,debit,credit,journal_id,company_id,account_id) VALUES
        (1, 1000, 0, ${journalId}::uuid, ${companyId}::uuid, ${accountBank}::uuid),
        (2, 0, 1000, ${journalId}::uuid, ${companyId}::uuid, ${accountCounter}::uuid)
    `.execute(db)

    const remaining = await banking.remaining(actor, txn.id, journalId)
    expect(remaining.amount).toBe('1000')

    const recon = await banking.createReconciliation(actor, {
      bankTransactionId: txn.id,
      journalId,
      amount: '1000',
    })
    const partial = await banking.getTransaction(actor, txn.id)
    expect(partial.reconcileStatus).toBe('PARTIAL')
    expect(partial.reconciledAmount).toBe('1000')
    expect(partial.unreconciledAmount).toBe('234.56')

    await banking.deleteReconciliation(actor, recon.id)
    const cleared = await banking.getTransaction(actor, txn.id)
    expect(cleared.reconcileStatus).toBe('UNRECONCILED')
    expect(cleared.reconciledAmount).toBe('0')
    expect(cleared.unreconciledAmount).toBe('1234.56')

    // 快速对账
    const quick = await banking.quickCreate(actor, {
      bankTransactionId: txn.id,
      counterAccountId: accountCounter,
      amount: '1234.56',
      postingDate: today,
      summary: '快速对账',
    })
    expect(quick.amount).toBe('1234.56')
    const full = await banking.getTransaction(actor, txn.id)
    expect(full.reconcileStatus).toBe('RECONCILED')
  })

  test('报销：挂票核销 + 作废解除占用', async () => {
    const inv = await invoices.create(actor, {
      companyId,
      direction: 'INBOUND',
      partyType: 'EMPLOYEE',
      partyId: employeeId,
      invoiceKind: 'NORMAL',
      invoiceNo: prefix + 'INV',
      invoiceDate: today,
      netTotal: '100',
      taxTotal: '13',
      grossTotal: '113',
      partyAccountId: accountPayable,
      amountAccountId: accountExpense,
      taxAccountId: accountExpense,
    })
    await invoices.audit(actor, inv.id, today)

    const report = await expenses.createReport(actor, {
      companyId,
      expenseDate: today,
      employeeId,
      paymentAccountId: accountBank,
    })
    await expenses.createItem(actor, {
      reportId: report.id,
      idx: 1,
      kind: 'INVOICED',
      invoiceId: inv.id,
    })
    await expenses.createItem(actor, {
      reportId: report.id,
      idx: 2,
      kind: 'MANUAL',
      summary: '无票餐费',
      amount: '50',
      expenseAccountId: accountExpense,
    })

    const audited = await expenses.auditReport(actor, report.id, today)
    expect(audited.status).toBe('AUDITED')

    // 发票已被占用
    await expect(
      expenses.createItem(actor, {
        reportId: (await expenses.createReport(actor, {
          companyId,
          expenseDate: today,
          employeeId,
          paymentAccountId: accountBank,
        })).id,
        idx: 1,
        kind: 'INVOICED',
        invoiceId: inv.id,
      }),
    ).rejects.toThrow(/挂票发票/)

    const voided = await expenses.voidReport(actor, report.id)
    expect(voided.status).toBe('VOIDED')

    // 作废后可再挂
    const report2 = await expenses.createReport(actor, {
      companyId,
      expenseDate: today,
      employeeId,
      paymentAccountId: accountBank,
    })
    const item = await expenses.createItem(actor, {
      reportId: report2.id,
      idx: 1,
      kind: 'INVOICED',
      invoiceId: inv.id,
    })
    expect(item.invoiceId).toBe(inv.id)
  })

  test('票据：接收审核 → 持有段；转让后不可再作废接收', async () => {
    const bankAcct = await banking.createAccount(actor, {
      alias: prefix + '票户',
      bankName: '承兑银行',
      holderName: '持有人',
      accountNo: '6333' + suffix.slice(0, 8),
      companyId,
      currencyId,
      accountId: accountBank,
    })
    // 票面 1000 元 → 子票 1-100000
    const receive = await bills.createTransaction(actor, {
      transactionType: 'RECEIVE',
      occurredOn: today,
      subStart: 1,
      subEnd: 100000,
      amount: '1000',
      partyType: 'CUSTOMER',
      partyId: customerId,
      companyId,
      bankAccountId: bankAcct.id,
      billAccountId: accountBill,
      settleAccountId: accountSettle,
      billAttrs: {
        billNo: prefix + 'BILL',
        billKind: 'BANK_ACCEPTANCE',
        dueDate: due,
        faceAmount: '1000',
        transferable: true,
      },
    })
    const audited = await bills.auditTransaction(actor, receive.id, today)
    expect(audited.status).toBe('AUDITED')

    const holdings = await bills.listHoldings(actor, {
      filter: { billId: { kind: 'fk', values: [receive.billId], labels: [] } },
      limit: 10,
    })
    expect(holdings.count).toBe(1)
    expect(holdings.results[0]!.subStart).toBe(1)
    expect(holdings.results[0]!.subEnd).toBe(100000)
    expect(holdings.results[0]!.amount).toBe('1000')

    // 转让半段
    const endorse = await bills.createTransaction(actor, {
      transactionType: 'ENDORSE',
      occurredOn: today,
      subStart: 1,
      subEnd: 50000,
      amount: '500',
      partyType: 'CUSTOMER',
      partyId: customerId,
      companyId,
      bankAccountId: bankAcct.id,
      billId: receive.billId,
      billAccountId: accountBill,
      settleAccountId: accountSettle,
    })
    await bills.auditTransaction(actor, endorse.id, today)

    const after = await bills.listHoldings(actor, {
      filter: { billId: { kind: 'fk', values: [receive.billId], labels: [] } },
      limit: 10,
    })
    expect(after.count).toBe(1)
    expect(after.results[0]!.subStart).toBe(50001)
    expect(after.results[0]!.subEnd).toBe(100000)

    // 作废接收应失败（后续已动）
    await expect(bills.voidTransaction(actor, receive.id)).rejects.toThrow()
  })
})
