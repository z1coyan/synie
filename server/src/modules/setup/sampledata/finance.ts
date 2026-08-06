import { decimal } from '@synie/shared'
import type { Actor } from '~/platform/authz/actor.ts'
import { permitFor } from './permit.ts'
import { daysAgo, daysAgoAt, previousMonth, type MasterData, type SeedCtx } from './helpers.ts'
import type { FinanceResult, PurchaseResult, SalesResult, SampleDataDeps } from './types.ts'

export async function seedFinance(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  md: MasterData,
  sales: SalesResult,
  purchase: PurchaseResult,
): Promise<FinanceResult> {
  const bankAccount = await deps.bankAccounts.create(permitFor(deps, actor, 'accBankAccounts', 'create'), {
    alias: '基本户',
    bankName: '中国银行',
    branchName: '台州分行营业部',
    holderName: sc.company.name,
    accountNo: '377601886688901',
    companyId: sc.company.id,
    currencyId: sc.company.baseCurrencyId,
    accountId: sc.accounts.bank,
  })

  const c01 = md.customers.C01!
  const c02 = md.customers.C02!
  const s01 = md.suppliers.S01!
  const s04 = md.suppliers.S04!

  type TxSpec = {
    ago: number
    hour: number
    income?: string
    expense?: string
    balance: string
    counterparty: string
    summary: string
  }
  const txSpecs: TxSpec[] = [
    {
      ago: 80,
      hour: 10,
      income: '200000.00',
      balance: '200000.00',
      counterparty: '王建国',
      summary: '股东注资款',
    },
    {
      ago: 28,
      hour: 14,
      income: '36000.00',
      balance: '236000.00',
      counterparty: c01.name,
      summary: '海纳电气货款',
    },
    {
      ago: 20,
      hour: 9,
      expense: '33360.00',
      balance: '202640.00',
      counterparty: s01.name,
      summary: '支付精铜材料货款',
    },
    {
      ago: 15,
      hour: 16,
      expense: '8500.00',
      balance: '194140.00',
      counterparty: s04.name,
      summary: '支付恒力钣金部分货款',
    },
    {
      ago: 8,
      hour: 11,
      income: '12500.00',
      balance: '206640.00',
      counterparty: c02.name,
      summary: '联成机电预付款',
    },
    {
      ago: 5,
      hour: 15,
      expense: '3200.00',
      balance: '203440.00',
      counterparty: '陈晓梅',
      summary: '报销及办公用品采购',
    },
  ]
  let txCount = 0
  for (const spec of txSpecs) {
    await deps.banking.createTransaction(permitFor(deps, actor, 'accBankTransactions', 'create'), {
      occurredAt: daysAgoAt(spec.ago, spec.hour),
      balance: spec.balance,
      counterpartyName: spec.counterparty,
      summary: spec.summary,
      companyId: sc.company.id,
      bankAccountId: bankAccount.id,
      income: spec.income ?? null,
      expense: spec.expense ?? null,
    })
    txCount++
  }

  await createGLJournal(deps, actor, sc, 85, '期初实收资本入账', [
    { accountId: sc.accounts.bank, debit: '200000.00', credit: '0' },
    { accountId: sc.accounts.capital, debit: '0', credit: '200000.00' },
  ])
  await createGLJournal(deps, actor, sc, 30, '支付当月办公场地租金', [
    { accountId: sc.accounts.expense, debit: '1200.00', credit: '0' },
    { accountId: sc.accounts.bank, debit: '0', credit: '1200.00' },
  ])

  const date = daysAgo(18)
  const report = await deps.expenses.createReport(permitFor(deps, actor, 'accExpenseReports', 'create'), {
    companyId: sc.company.id,
    expenseDate: date,
    postingDate: date,
    employeeId: md.employees['陈晓梅']!.id,
    paymentAccountId: sc.accounts.bank,
    remarks: '初始化示例报销单',
  })
  for (const [i, line] of [
    { summary: '宁波客户拜访差旅费', amount: '860.00' },
    { summary: '办公用品采购', amount: '240.50' },
  ].entries()) {
    await deps.expenses.createItem(permitFor(deps, actor, 'accExpenseReportItems', 'create'), {
      reportId: report.id,
      idx: i + 1,
      kind: 'MANUAL',
      summary: line.summary,
      amount: line.amount,
      expenseAccountId: sc.accounts.expense,
    })
  }
  await deps.expenses.auditReport(permitFor(deps, actor, 'accExpenseReports', 'audit'), report.id, date)

  const month = previousMonth()
  const p1 = await deps.hr.payroll.createPayroll(permitFor(deps, actor, 'hrPayrolls', 'create'), {
    employeeId: md.employees['张伟强']!.id,
    month,
    workdays: '22',
    attendanceDays: 22,
    missingDays: 0,
    overtimeHours: '0',
    dailyWage: '260',
    allowance: '300',
    bonus: '500',
    fine: '0',
    loanDeduction: '0',
    remarks: '初始化示例工资单',
  })
  await deps.hr.payroll.createPayment(permitFor(deps, actor, 'hrPayrollPayments', 'create'), {
    payrollId: p1.id,
    paidOn: daysAgo(10),
    amount: '6520.00',
    remarks: '银行代发',
  })
  await deps.hr.payroll.createPayroll(permitFor(deps, actor, 'hrPayrolls', 'create'), {
    employeeId: md.employees['李秀英']!.id,
    month,
    workdays: '21',
    attendanceDays: 21,
    missingDays: 0,
    overtimeHours: '0',
    dailyWage: '220',
    allowance: '300',
    bonus: '0',
    fine: '0',
    loanDeduction: '0',
    remarks: '初始化示例工资单(待发放)',
  })

  await createVatInvoice(
    deps,
    actor,
    sc,
    'OUTBOUND',
    15,
    'CUSTOMER',
    c01.id,
    '033002400116',
    '04632188',
    sc.company.name,
    c01.name,
    sales.confirmedBaseGrossTotal,
    sc.accounts.receivable,
    sc.accounts.revenue,
    sc.accounts.tax,
    sales.confirmedReconciliation,
    null,
    [
      { name: '配电箱壳体', model: 'HN-BX-100 定制', unit: '件', qty: '50', price: '128.00' },
      { name: '汇流铜排组件', model: 'HN-BB-08 8 路', unit: '件', qty: '20', price: '86.50' },
    ],
    '初始化示例销项发票',
  )
  await createVatInvoice(
    deps,
    actor,
    sc,
    'INBOUND',
    10,
    'SUPPLIER',
    s01.id,
    '033002400205',
    '55209317',
    s01.name,
    sc.company.name,
    purchase.confirmedBaseGrossTotal,
    sc.accounts.payable,
    sc.accounts.inventory,
    sc.accounts.tax,
    null,
    purchase.confirmedReconciliation,
    [
      { name: '紫铜棒', model: 'T2 φ20', unit: '件', qty: '500', price: '52.00' },
      { name: '紫铜排', model: 'T2 3×30×1000', unit: '件', qty: '200', price: '36.80' },
    ],
    '初始化示例进项发票',
  )

  return {
    bankTransactions: txCount,
    glJournals: 2,
    payrolls: 2,
    vatInvoices: 2,
  }
}

async function createGLJournal(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  dateAgoN: number,
  remarks: string,
  lines: Array<{ accountId: string; debit: string; credit: string }>,
): Promise<void> {
  const date = daysAgo(dateAgoN)
  const journal = await deps.journals.create(permitFor(deps, actor, 'accGlJournals', 'create'), {
    date,
    postingDate: date,
    remarks,
    companyId: sc.company.id,
  })
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    await deps.journals.createLine(permitFor(deps, actor, 'accGlJournalLines', 'create'), {
      journalId: journal.id,
      idx: i + 1,
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
    })
  }
  await deps.journals.audit(permitFor(deps, actor, 'accGlJournals', 'audit'), journal.id)
}

interface InvoiceLine {
  name: string
  model: string
  unit: string
  qty: string
  price: string
}

async function createVatInvoice(
  deps: SampleDataDeps,
  actor: Actor,
  sc: SeedCtx,
  direction: string,
  dateAgoN: number,
  partyType: string,
  partyId: string,
  invoiceCode: string,
  invoiceNo: string,
  seller: string,
  buyer: string,
  gross: string,
  partyAccount: string,
  amountAccount: string,
  taxAccount: string,
  salRecon: string | null,
  purRecon: string | null,
  lines: InvoiceLine[],
  remarks: string,
): Promise<void> {
  const grossDec = decimal(gross)
  const { net, tax } = splitVAT(grossDec)
  const items = lines.map((line) => {
    const lineGross = decimal(line.qty).mul(decimal(line.price)).toDecimalPlaces(2)
    const split = splitVAT(lineGross)
    return {
      name: line.name,
      model: line.model,
      unit: line.unit,
      quantity: line.qty,
      price: line.price,
      net_amount: split.net.toFixed(2),
      tax_rate: '13%',
      tax_amount: split.tax.toFixed(2),
    }
  })
  const date = daysAgo(dateAgoN)
  const invoice = await deps.invoices.create(permitFor(deps, actor, 'accVatInvoices', 'create'), {
    companyId: sc.company.id,
    direction,
    invoiceDate: date,
    partyType,
    partyId,
    invoiceKind: 'SPECIAL',
    invoiceCode,
    invoiceNo,
    sellerName: seller,
    buyerName: buyer,
    items,
    netTotal: net.toFixed(2),
    taxTotal: tax.toFixed(2),
    grossTotal: gross,
    partyAccountId: partyAccount,
    amountAccountId: amountAccount,
    taxAccountId: taxAccount,
    salReconciliationId: salRecon,
    purReconciliationId: purRecon,
    remarks,
  })
  await deps.invoices.audit(permitFor(deps, actor, 'accVatInvoices', 'audit'), invoice.id, date)
}

function splitVAT(gross: ReturnType<typeof decimal>): {
  net: ReturnType<typeof decimal>
  tax: ReturnType<typeof decimal>
} {
  const rate = decimal('0.13')
  const net = gross.div(decimal(1).add(rate)).toDecimalPlaces(2)
  const tax = gross.sub(net)
  return { net, tax }
}
