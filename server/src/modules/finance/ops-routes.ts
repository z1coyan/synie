/**
 * 银行 / 报销 / 票据 REST 路由（工单 12）。
 * 发票路由见 routes.ts。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import { requirePermission } from '~/platform/authz/actor.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { validationHook } from '~/platform/http/zod.ts'
import type { BankingService } from './banking-service.ts'
import type { ExpenseService } from './expense-service.ts'
import type { BillService } from './bill-service.ts'
import { present } from './common.ts'

const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const idParam = z.object({ id: z.string().uuid() })

function requirePerm(code: string) {
  return async (
    c: { get: (k: 'actor') => AppEnv['Variables']['actor'] },
    next: () => Promise<void>,
  ) => {
    requirePermission(c.get('actor'), code)
    await next()
  }
}

function toList(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

const dec = z.string().nullable().optional()

export function bankAccountRoutes(deps: { auth: AuthService; banking: BankingService }) {
  const { auth, banking } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bank_account:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      const result = await banking.listAccounts(c.get('actor')!, toList(c.req.valid('json')))
      return c.json(result)
    })
    .get('/:id', requirePerm('acc.bank_account:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getAccount(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/', requirePerm('acc.bank_account:create'), zValidator('json', z.object({
      alias: z.string(), bankName: z.string(), holderName: z.string(), accountNo: z.string(),
      branchName: z.string().nullable().optional(), note: z.string().nullable().optional(),
      active: z.boolean().nullable().optional(),
      companyId: z.string().uuid(), currencyId: z.string().uuid(),
      accountId: z.string().uuid().nullable().optional(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createAccount(c.get('actor')!, c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', requirePerm('acc.bank_account:update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        alias: z.string().optional(), bankName: z.string().optional(),
        holderName: z.string().optional(), accountNo: z.string().optional(),
        branchName: z.string().nullable().optional(), note: z.string().nullable().optional(),
        active: z.boolean().optional(), currencyId: z.string().uuid().optional(),
        accountId: z.string().uuid().nullable().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await banking.updateAccount(c.get('actor')!, c.req.valid('param').id, {
        ...body,
        branchNamePresent: present(raw, 'branchName'),
        notePresent: present(raw, 'note'),
        accountIdPresent: present(raw, 'accountId'),
      })
      return c.json(item)
    })
    .delete('/:id', requirePerm('acc.bank_account:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteAccount(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankTransactionRoutes(deps: { auth: AuthService; banking: BankingService }) {
  const { auth, banking } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bank_transaction:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listTransactions(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.bank_transaction:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getTransaction(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/', requirePerm('acc.bank_transaction:create'), zValidator('json', z.object({
      occurredAt: z.string(), income: dec, expense: dec, balance: dec,
      counterpartyName: z.string().nullable().optional(),
      counterpartyAccount: z.string().nullable().optional(),
      summary: z.string().nullable().optional(), note: z.string().nullable().optional(),
      companyId: z.string().uuid(), bankAccountId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createTransaction(c.get('actor')!, c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', requirePerm('acc.bank_transaction:update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        occurredAt: z.string().optional(), income: dec, expense: dec, balance: dec,
        counterpartyName: z.string().nullable().optional(),
        counterpartyAccount: z.string().nullable().optional(),
        summary: z.string().nullable().optional(), note: z.string().nullable().optional(),
        bankAccountId: z.string().uuid().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await banking.updateTransaction(c.get('actor')!, c.req.valid('param').id, {
        ...body,
        incomePresent: present(raw, 'income'),
        expensePresent: present(raw, 'expense'),
        balancePresent: present(raw, 'balance'),
        counterpartyNamePresent: present(raw, 'counterpartyName'),
        counterpartyAccountPresent: present(raw, 'counterpartyAccount'),
        summaryPresent: present(raw, 'summary'),
        notePresent: present(raw, 'note'),
      })
      return c.json(item)
    })
    .delete('/:id', requirePerm('acc.bank_transaction:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteTransaction(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankImportTemplateRoutes(deps: { auth: AuthService; banking: BankingService }) {
  const { auth, banking } = deps
  const col = z.string().nullable().optional()
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bank_import_template:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listTemplates(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.bank_import_template:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getTemplate(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/', requirePerm('acc.bank_import_template:create'), zValidator('json', z.object({
      name: z.string(), startRow: z.number().int().optional(),
      datetimeCol: col, datetimeFormat: col, dateCol: col, dateFormat: col,
      timeCol: col, timeFormat: col, incomeCol: col, expenseCol: col, amountCol: col,
      balanceCol: col, counterpartyNameCol: col, counterpartyAccountCol: col,
      summaryCol: col, noteCol: col,
      companyId: z.string().uuid(), bankAccountId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createTemplate(c.get('actor')!, c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', requirePerm('acc.bank_import_template:update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        name: z.string().optional(), startRow: z.number().int().optional(),
        datetimeCol: col, datetimeFormat: col, dateCol: col, dateFormat: col,
        timeCol: col, timeFormat: col, incomeCol: col, expenseCol: col, amountCol: col,
        balanceCol: col, counterpartyNameCol: col, counterpartyAccountCol: col,
        summaryCol: col, noteCol: col, bankAccountId: z.string().uuid().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const item = await banking.updateTemplate(c.get('actor')!, c.req.valid('param').id, raw)
      return c.json(item)
    })
    .delete('/:id', requirePerm('acc.bank_import_template:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteTemplate(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankImportRoutes(deps: { auth: AuthService; banking: BankingService }) {
  const { auth, banking } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bank_transaction:import'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listImports(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.bank_transaction:import'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getImport(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/', requirePerm('acc.bank_transaction:import'), zValidator('json', z.object({
      companyId: z.string().uuid(), bankAccountId: z.string().uuid(),
      templateId: z.string().uuid(), fileId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createImport(c.get('actor')!, c.req.valid('json'))
      return c.json(item, 201)
    })
    .post('/:id/import', requirePerm('acc.bank_transaction:import'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.runImport(c.get('actor')!, c.req.valid('param').id))
    })
    .delete('/:id', requirePerm('acc.bank_transaction:import'), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteImport(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankImportItemRoutes(deps: { auth: AuthService; banking: BankingService }) {
  const { auth, banking } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bank_transaction:import'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listItems(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.bank_transaction:import'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getItem(c.get('actor')!, c.req.valid('param').id))
    })
    .patch('/:id', requirePerm('acc.bank_transaction:import'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        occurredAt: z.string().optional(), income: dec, expense: dec, balance: dec,
        counterpartyName: z.string().nullable().optional(),
        counterpartyAccount: z.string().nullable().optional(),
        summary: z.string().nullable().optional(), note: z.string().nullable().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await banking.updateItem(c.get('actor')!, c.req.valid('param').id, {
        ...body,
        incomePresent: present(raw, 'income'),
        expensePresent: present(raw, 'expense'),
        balancePresent: present(raw, 'balance'),
        counterpartyNamePresent: present(raw, 'counterpartyName'),
        counterpartyAccountPresent: present(raw, 'counterpartyAccount'),
        summaryPresent: present(raw, 'summary'),
        notePresent: present(raw, 'note'),
      })
      return c.json(item)
    })
    .delete('/:id', requirePerm('acc.bank_transaction:import'), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteItem(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankReconciliationRoutes(deps: { auth: AuthService; banking: BankingService }) {
  const { auth, banking } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bank_transaction:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listReconciliations(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/remaining', requirePerm('acc.bank_transaction:read'),
      zValidator('query', z.object({
        bankTransactionId: z.string().uuid(), journalId: z.string().uuid(),
      }).strict(), validationHook), async (c) => {
      const q = c.req.valid('query')
      return c.json(await banking.remaining(c.get('actor')!, q.bankTransactionId, q.journalId))
    })
    .get('/:id', requirePerm('acc.bank_transaction:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getReconciliation(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/', requirePerm('acc.bank_transaction:reconcile'), zValidator('json', z.object({
      bankTransactionId: z.string().uuid(), journalId: z.string().uuid(), amount: z.string(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createReconciliation(c.get('actor')!, c.req.valid('json'))
      return c.json(item, 201)
    })
    .post('/quick-create', requirePerm('acc.bank_transaction:reconcile'), zValidator('json', z.object({
      bankTransactionId: z.string().uuid(), counterAccountId: z.string().uuid(),
      amount: z.string(), summary: z.string().nullable().optional(), postingDate: z.string(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.quickCreate(c.get('actor')!, c.req.valid('json'))
      return c.json(item, 201)
    })
    .delete('/:id', requirePerm('acc.bank_transaction:reconcile'), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteReconciliation(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function expenseReportRoutes(deps: { auth: AuthService; expenses: ExpenseService }) {
  const { auth, expenses } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.expense_report:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await expenses.listReports(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.expense_report:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await expenses.getReport(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/', requirePerm('acc.expense_report:create'), zValidator('json', z.object({
      companyId: z.string().uuid(), docNo: z.string().nullable().optional(),
      expenseDate: z.string(), postingDate: z.string().nullable().optional(),
      remarks: z.string().nullable().optional(),
      employeeId: z.string().uuid(), paymentAccountId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      const item = await expenses.createReport(c.get('actor')!, c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', requirePerm('acc.expense_report:update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        docNo: z.string().nullable().optional(), expenseDate: z.string().optional(),
        postingDate: z.string().nullable().optional(), remarks: z.string().nullable().optional(),
        employeeId: z.string().uuid().optional(), paymentAccountId: z.string().uuid().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await expenses.updateReport(c.get('actor')!, c.req.valid('param').id, {
        ...body,
        docNoPresent: present(raw, 'docNo'),
        postingDatePresent: present(raw, 'postingDate'),
        remarksPresent: present(raw, 'remarks'),
      })
      return c.json(item)
    })
    .delete('/:id', requirePerm('acc.expense_report:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await expenses.deleteReport(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', requirePerm('acc.expense_report:audit'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({ postingDate: z.string() }).strict(), validationHook), async (c) => {
      return c.json(await expenses.auditReport(c.get('actor')!, c.req.valid('param').id, c.req.valid('json').postingDate))
    })
    .post('/:id/void', requirePerm('acc.expense_report:void'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await expenses.voidReport(c.get('actor')!, c.req.valid('param').id))
    })
}

export function expenseReportItemRoutes(deps: { auth: AuthService; expenses: ExpenseService }) {
  const { auth, expenses } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.expense_report:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await expenses.listItems(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.expense_report:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await expenses.getItem(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/', requirePerm('acc.expense_report:create'), zValidator('json', z.object({
      reportId: z.string().uuid(), idx: z.number().int(), kind: z.string(),
      summary: z.string().nullable().optional(), amount: dec, remarks: z.string().nullable().optional(),
      invoiceId: z.string().uuid().nullable().optional(),
      expenseAccountId: z.string().uuid().nullable().optional(),
    }).strict(), validationHook), async (c) => {
      const item = await expenses.createItem(c.get('actor')!, c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', requirePerm('acc.expense_report:update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        idx: z.number().int().optional(), kind: z.string().optional(),
        summary: z.string().nullable().optional(), amount: dec,
        remarks: z.string().nullable().optional(),
        invoiceId: z.string().uuid().nullable().optional(),
        expenseAccountId: z.string().uuid().nullable().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await expenses.updateItem(c.get('actor')!, c.req.valid('param').id, {
        ...body,
        summaryPresent: present(raw, 'summary'),
        amountPresent: present(raw, 'amount'),
        remarksPresent: present(raw, 'remarks'),
        invoiceIdPresent: present(raw, 'invoiceId'),
        expenseAccountIdPresent: present(raw, 'expenseAccountId'),
      })
      return c.json(item)
    })
    .delete('/:id', requirePerm('acc.expense_report:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await expenses.deleteItem(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function billRoutes(deps: { auth: AuthService; bills: BillService }) {
  const { auth, bills } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bill:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await bills.listBills(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.bill:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await bills.getBill(c.get('actor')!, c.req.valid('param').id))
    })
    .patch('/:id', requirePerm('acc.bill:update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.record(z.string(), z.unknown()), validationHook), async (c) => {
      return c.json(await bills.updateBill(c.get('actor')!, c.req.valid('param').id, c.req.valid('json')))
    })
    .delete('/:id', requirePerm('acc.bill:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await bills.deleteBill(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function billTransactionRoutes(deps: { auth: AuthService; bills: BillService }) {
  const { auth, bills } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bill_transaction:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await bills.listTransactions(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.bill_transaction:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await bills.getTransaction(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/', requirePerm('acc.bill_transaction:create'), zValidator('json', z.object({
      docNo: z.string().nullable().optional(),
      transactionType: z.string(), occurredOn: z.string(),
      subStart: z.number().int(), subEnd: z.number().int(), amount: z.string(),
      partyType: z.string().nullable().optional(), partyId: z.string().uuid().nullable().optional(),
      discountOrg: z.string().nullable().optional(), discountRate: dec, interest: dec, netAmount: dec,
      postingDate: z.string().nullable().optional(), remarks: z.string().nullable().optional(),
      companyId: z.string().uuid(), bankAccountId: z.string().uuid(),
      toBankAccountId: z.string().uuid().nullable().optional(),
      billId: z.string().uuid().nullable().optional(),
      billAttrs: z.record(z.string(), z.unknown()).nullable().optional(),
      billAccountId: z.string().uuid().nullable().optional(),
      settleAccountId: z.string().uuid().nullable().optional(),
      interestAccountId: z.string().uuid().nullable().optional(),
    }).strict(), validationHook), async (c) => {
      const body = c.req.valid('json')
      const item = await bills.createTransaction(c.get('actor')!, {
        ...body,
        billAttrs: body.billAttrs as never,
      })
      return c.json(item, 201)
    })
    .patch('/:id', requirePerm('acc.bill_transaction:update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.record(z.string(), z.unknown()), validationHook), async (c) => {
      return c.json(await bills.updateTransaction(c.get('actor')!, c.req.valid('param').id, c.req.valid('json')))
    })
    .delete('/:id', requirePerm('acc.bill_transaction:delete'), zValidator('param', idParam, validationHook), async (c) => {
      await bills.deleteTransaction(c.get('actor')!, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', requirePerm('acc.bill_transaction:audit'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({ postingDate: z.string().nullable().optional() }).strict(), validationHook), async (c) => {
      return c.json(await bills.auditTransaction(
        c.get('actor')!, c.req.valid('param').id, c.req.valid('json').postingDate,
      ))
    })
    .post('/:id/void', requirePerm('acc.bill_transaction:void'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await bills.voidTransaction(c.get('actor')!, c.req.valid('param').id))
    })
    .post('/ocr', requirePerm('acc.bill_transaction:create'), zValidator('json', z.object({
      fileId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      return c.json(await bills.ocrBill(c.get('actor')!, c.req.valid('json').fileId))
    })
}

export function billHoldingRoutes(deps: { auth: AuthService; bills: BillService }) {
  const { auth, bills } = deps
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', requirePerm('acc.bill_holding:read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await bills.listHoldings(c.get('actor')!, toList(c.req.valid('json'))))
    })
    .get('/:id', requirePerm('acc.bill_holding:read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await bills.getHolding(c.get('actor')!, c.req.valid('param').id))
    })
}
