/**
 * 银行 / 报销 / 票据 REST 路由（工单 12）。
 * 发票路由见 routes.ts。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 动作码的唯一事实源是 meta：
 * - 导入批次/行没有独立权限点，读写一律由 `acc.bank_transaction:import` 单码门控
 *   （批次 meta 的 `authz.readAnyOf` 声明 import-as-read 重载；行经 via 递归批次）。
 * - 对账（reconcile）是银行流水资源上的命令码（meta `permissionAction: 'reconcile'`）。
 * - 跨资源门控用 `allOf`，附加码从 `authz.targetOf(资源).prefix` 拼，不写字面量。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ListQuery } from '@synie/shared'
import { requireAuth } from '~/platform/auth/middleware.ts'
import type { AuthService } from '~/platform/auth/service.ts'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import { permitOf } from '~/platform/authz/enforce.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { listQuerySchema, validationHook } from '~/platform/http/zod.ts'
import { FILE_RESOURCE_NAME } from '~/platform/files/meta.ts'
import { JOURNAL_RESOURCE_NAME } from '~/modules/accounting/meta.ts'
import {
  BANK_ACCOUNT_RESOURCE,
  BANK_IMPORT_ITEM_RESOURCE,
  BANK_IMPORT_RESOURCE,
  BANK_IMPORT_TEMPLATE_RESOURCE,
  BANK_RECONCILIATION_RESOURCE,
  BANK_TRANSACTION_RESOURCE,
  type BankingService,
} from './banking-service.ts'
import {
  EXPENSE_REPORT_ITEM_RESOURCE,
  EXPENSE_REPORT_RESOURCE,
  type ExpenseService,
} from './expense-service.ts'
import {
  BILL_HOLDING_RESOURCE,
  BILL_RESOURCE,
  BILL_TRANSACTION_RESOURCE,
  type BillService,
} from './bill-service.ts'
import { present } from './common.ts'

const idParam = z.object({ id: z.string().uuid() })

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

// 银行账户路由已迁 platform/standard 派生（见 app.ts /finance/bank-accounts）

export function bankTransactionRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; banking: BankingService
}) {
  const { auth, authz, banking } = deps
  const guard = (action: string) => authz.guard(BANK_TRANSACTION_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listTransactions(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getTransaction(permitOf(c), c.req.valid('param').id))
    })
    .post('/', guard('create'), zValidator('json', z.object({
      occurredAt: z.string(), income: dec, expense: dec, balance: dec,
      counterpartyName: z.string().nullable().optional(),
      counterpartyAccount: z.string().nullable().optional(),
      summary: z.string().nullable().optional(), note: z.string().nullable().optional(),
      companyId: z.string().uuid(), bankAccountId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createTransaction(permitOf(c), c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', guard('update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        occurredAt: z.string().optional(), income: dec, expense: dec, balance: dec,
        counterpartyName: z.string().nullable().optional(),
        counterpartyAccount: z.string().nullable().optional(),
        summary: z.string().nullable().optional(), note: z.string().nullable().optional(),
        bankAccountId: z.string().uuid().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await banking.updateTransaction(permitOf(c), c.req.valid('param').id, {
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
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteTransaction(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankImportTemplateRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; banking: BankingService
}) {
  const { auth, authz, banking } = deps
  const guard = (action: string) => authz.guard(BANK_IMPORT_TEMPLATE_RESOURCE, action)
  const col = z.string().nullable().optional()
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listTemplates(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getTemplate(permitOf(c), c.req.valid('param').id))
    })
    .post('/', guard('create'), zValidator('json', z.object({
      name: z.string(), startRow: z.number().int().optional(),
      datetimeCol: col, datetimeFormat: col, dateCol: col, dateFormat: col,
      timeCol: col, timeFormat: col, incomeCol: col, expenseCol: col, amountCol: col,
      balanceCol: col, counterpartyNameCol: col, counterpartyAccountCol: col,
      summaryCol: col, noteCol: col,
      companyId: z.string().uuid(), bankAccountId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createTemplate(permitOf(c), c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', guard('update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        name: z.string().optional(), startRow: z.number().int().optional(),
        datetimeCol: col, datetimeFormat: col, dateCol: col, dateFormat: col,
        timeCol: col, timeFormat: col, incomeCol: col, expenseCol: col, amountCol: col,
        balanceCol: col, counterpartyNameCol: col, counterpartyAccountCol: col,
        summaryCol: col, noteCol: col, bankAccountId: z.string().uuid().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const item = await banking.updateTemplate(permitOf(c), c.req.valid('param').id, raw)
      return c.json(item)
    })
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteTemplate(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankImportRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; banking: BankingService
}) {
  const { auth, authz, banking } = deps
  // 读走 readAnyOf（import-as-read 重载）；写走 import 命令码，跨资源附加码用 allOf
  const readGuard = () => authz.guard(BANK_IMPORT_RESOURCE, 'read')
  const importGuard = (allOf?: readonly string[]) =>
    authz.guard(BANK_IMPORT_RESOURCE, 'import', allOf ? { allOf } : undefined)
  const codeOf = (resource: string, action: string) =>
    `${authz.targetOf(resource).prefix}:${action}`
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', readGuard(), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listImports(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', readGuard(), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getImport(permitOf(c), c.req.valid('param').id))
    })
    // 建批次必然读导入文件 → ∧ sys.file:read（迁移前是服务里两道码级闸）
    .post('/', importGuard([codeOf(FILE_RESOURCE_NAME, 'read')]), zValidator('json', z.object({
      companyId: z.string().uuid(), bankAccountId: z.string().uuid(),
      templateId: z.string().uuid(), fileId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createImport(permitOf(c), c.req.valid('json'))
      return c.json(item, 201)
    })
    // 执行导入必然建流水 → ∧ acc.bank_transaction:create
    .post(
      '/:id/import',
      importGuard([codeOf(BANK_TRANSACTION_RESOURCE, 'create')]),
      zValidator('param', idParam, validationHook),
      async (c) => {
        return c.json(await banking.runImport(permitOf(c), c.req.valid('param').id))
      },
    )
    .delete('/:id', importGuard(), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteImport(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankImportItemRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; banking: BankingService
}) {
  const { auth, authz, banking } = deps
  const readGuard = () => authz.guard(BANK_IMPORT_ITEM_RESOURCE, 'read')
  const importGuard = () => authz.guard(BANK_IMPORT_ITEM_RESOURCE, 'import')
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', readGuard(), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listItems(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', readGuard(), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getItem(permitOf(c), c.req.valid('param').id))
    })
    .patch('/:id', importGuard(), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        occurredAt: z.string().optional(), income: dec, expense: dec, balance: dec,
        counterpartyName: z.string().nullable().optional(),
        counterpartyAccount: z.string().nullable().optional(),
        summary: z.string().nullable().optional(), note: z.string().nullable().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await banking.updateItem(permitOf(c), c.req.valid('param').id, {
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
    .delete('/:id', importGuard(), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteItem(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function bankReconciliationRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; banking: BankingService
}) {
  const { auth, authz, banking } = deps
  const reconGuard = (action: string) => authz.guard(BANK_RECONCILIATION_RESOURCE, action)
  // 对账写命令码挂在银行流水资源上（meta permissionAction: 'reconcile'）
  const commandGuard = () => authz.guard(BANK_TRANSACTION_RESOURCE, 'reconcile')
  const codeOf = (resource: string, action: string) =>
    `${authz.targetOf(resource).prefix}:${action}`
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', reconGuard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await banking.listReconciliations(permitOf(c), toList(c.req.valid('json'))))
    })
    // 跨资源读：既读流水又读凭证 → allOf（迁移前是服务里两道码级闸）
    .get('/remaining', authz.guard(BANK_RECONCILIATION_RESOURCE, 'read', {
        allOf: [codeOf(JOURNAL_RESOURCE_NAME, 'read')],
      }), zValidator('query', z.object({
        bankTransactionId: z.string().uuid(), journalId: z.string().uuid(),
      }).strict(), validationHook), async (c) => {
      const q = c.req.valid('query')
      return c.json(await banking.remaining(permitOf(c), q.bankTransactionId, q.journalId))
    })
    .get('/:id', reconGuard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await banking.getReconciliation(permitOf(c), c.req.valid('param').id))
    })
    .post('/', commandGuard(), zValidator('json', z.object({
      bankTransactionId: z.string().uuid(), journalId: z.string().uuid(), amount: z.string(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.createReconciliation(permitOf(c), c.req.valid('json'))
      return c.json(item, 201)
    })
    .post('/quick-create', commandGuard(), zValidator('json', z.object({
      bankTransactionId: z.string().uuid(), counterAccountId: z.string().uuid(),
      amount: z.string(), summary: z.string().nullable().optional(), postingDate: z.string(),
    }).strict(), validationHook), async (c) => {
      const item = await banking.quickCreate(permitOf(c), c.req.valid('json'))
      return c.json(item, 201)
    })
    .delete('/:id', commandGuard(), zValidator('param', idParam, validationHook), async (c) => {
      await banking.deleteReconciliation(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function expenseReportRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; expenses: ExpenseService
}) {
  const { auth, authz, expenses } = deps
  const guard = (action: string) => authz.guard(EXPENSE_REPORT_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await expenses.listReports(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await expenses.getReport(permitOf(c), c.req.valid('param').id))
    })
    .post('/', guard('create'), zValidator('json', z.object({
      companyId: z.string().uuid(), docNo: z.string().nullable().optional(),
      expenseDate: z.string(), postingDate: z.string().nullable().optional(),
      remarks: z.string().nullable().optional(),
      employeeId: z.string().uuid(), paymentAccountId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      const item = await expenses.createReport(permitOf(c), c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', guard('update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        docNo: z.string().nullable().optional(), expenseDate: z.string().optional(),
        postingDate: z.string().nullable().optional(), remarks: z.string().nullable().optional(),
        employeeId: z.string().uuid().optional(), paymentAccountId: z.string().uuid().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await expenses.updateReport(permitOf(c), c.req.valid('param').id, {
        ...body,
        docNoPresent: present(raw, 'docNo'),
        postingDatePresent: present(raw, 'postingDate'),
        remarksPresent: present(raw, 'remarks'),
      })
      return c.json(item)
    })
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await expenses.deleteReport(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', guard('audit'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({ postingDate: z.string() }).strict(), validationHook), async (c) => {
      return c.json(await expenses.auditReport(permitOf(c), c.req.valid('param').id, c.req.valid('json').postingDate))
    })
    .post('/:id/void', guard('void'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await expenses.voidReport(permitOf(c), c.req.valid('param').id))
    })
}

export function expenseReportItemRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; expenses: ExpenseService
}) {
  const { auth, authz, expenses } = deps
  // 行是 via(母单)：动作码解析到母单前缀 acc.expense_report
  const guard = (action: string) => authz.guard(EXPENSE_REPORT_ITEM_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await expenses.listItems(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await expenses.getItem(permitOf(c), c.req.valid('param').id))
    })
    .post('/', guard('create'), zValidator('json', z.object({
      reportId: z.string().uuid(), idx: z.number().int(), kind: z.string(),
      summary: z.string().nullable().optional(), amount: dec, remarks: z.string().nullable().optional(),
      invoiceId: z.string().uuid().nullable().optional(),
      expenseAccountId: z.string().uuid().nullable().optional(),
    }).strict(), validationHook), async (c) => {
      const item = await expenses.createItem(permitOf(c), c.req.valid('json'))
      return c.json(item, 201)
    })
    .patch('/:id', guard('update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({
        idx: z.number().int().optional(), kind: z.string().optional(),
        summary: z.string().nullable().optional(), amount: dec,
        remarks: z.string().nullable().optional(),
        invoiceId: z.string().uuid().nullable().optional(),
        expenseAccountId: z.string().uuid().nullable().optional(),
      }).strict(), validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const item = await expenses.updateItem(permitOf(c), c.req.valid('param').id, {
        ...body,
        summaryPresent: present(raw, 'summary'),
        amountPresent: present(raw, 'amount'),
        remarksPresent: present(raw, 'remarks'),
        invoiceIdPresent: present(raw, 'invoiceId'),
        expenseAccountIdPresent: present(raw, 'expenseAccountId'),
      })
      return c.json(item)
    })
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await expenses.deleteItem(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function billRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; bills: BillService
}) {
  const { auth, authz, bills } = deps
  const guard = (action: string) => authz.guard(BILL_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await bills.listBills(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await bills.getBill(permitOf(c), c.req.valid('param').id))
    })
    .patch('/:id', guard('update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.record(z.string(), z.unknown()), validationHook), async (c) => {
      return c.json(await bills.updateBill(permitOf(c), c.req.valid('param').id, c.req.valid('json')))
    })
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await bills.deleteBill(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
}

export function billTransactionRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; bills: BillService
}) {
  const { auth, authz, bills } = deps
  const guard = (action: string) => authz.guard(BILL_TRANSACTION_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await bills.listTransactions(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await bills.getTransaction(permitOf(c), c.req.valid('param').id))
    })
    .post('/', guard('create'), zValidator('json', z.object({
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
      const item = await bills.createTransaction(permitOf(c), {
        ...body,
        billAttrs: body.billAttrs as never,
      })
      return c.json(item, 201)
    })
    .patch('/:id', guard('update'), zValidator('param', idParam, validationHook),
      zValidator('json', z.record(z.string(), z.unknown()), validationHook), async (c) => {
      return c.json(await bills.updateTransaction(permitOf(c), c.req.valid('param').id, c.req.valid('json')))
    })
    .delete('/:id', guard('delete'), zValidator('param', idParam, validationHook), async (c) => {
      await bills.deleteTransaction(permitOf(c), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post('/:id/audit', guard('audit'), zValidator('param', idParam, validationHook),
      zValidator('json', z.object({ postingDate: z.string().nullable().optional() }).strict(), validationHook), async (c) => {
      return c.json(await bills.auditTransaction(
        permitOf(c), c.req.valid('param').id, c.req.valid('json').postingDate,
      ))
    })
    .post('/:id/void', guard('void'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await bills.voidTransaction(permitOf(c), c.req.valid('param').id))
    })
    // OCR 预填是「为建交易读票面影像」：本资源 create（文件行级可达性归平台）
    .post('/ocr', guard('create'), zValidator('json', z.object({
      fileId: z.string().uuid(),
    }).strict(), validationHook), async (c) => {
      return c.json(await bills.ocrBill(permitOf(c), c.req.valid('json').fileId))
    })
}

export function billHoldingRoutes(deps: {
  auth: AuthService; authz: AuthzEnforcer; bills: BillService
}) {
  const { auth, authz, bills } = deps
  const guard = (action: string) => authz.guard(BILL_HOLDING_RESOURCE, action)
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .post('/query', guard('read'), zValidator('json', listQuerySchema, validationHook), async (c) => {
      return c.json(await bills.listHoldings(permitOf(c), toList(c.req.valid('json'))))
    })
    .get('/:id', guard('read'), zValidator('param', idParam, validationHook), async (c) => {
      return c.json(await bills.getHolding(permitOf(c), c.req.valid('param').id))
    })
}
