/**
 * 财务模块：增值税发票（09）+ 银行/票据/报销（12）。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { FileService } from '~/platform/files/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { ReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import type { JournalService } from '~/modules/accounting/journal-service.ts'
import { createVatInvoiceService } from './invoice-service.ts'
import { createBankingService } from './banking-service.ts'
import { createBankAccountService } from './banking-accounts.ts'
import { createExpenseService } from './expense-service.ts'
import { createBillService } from './bill-service.ts'
import { allFinanceResourceMetas } from './meta.ts'
import type { TodoSourceRegistry } from '~/platform/todo/source-registry.ts'
import { registerFinanceSettingResources } from './settings.ts'

export {
  createVatInvoiceService,
  invoiceGLEntries,
  VAT_INVOICE_RESOURCE_NAME,
  type VatInvoiceService,
} from './invoice-service.ts'
export {
  createBankingService,
  BANK_ACCOUNT_RESOURCE,
  BANK_IMPORT_ITEM_RESOURCE,
  BANK_IMPORT_RESOURCE,
  BANK_IMPORT_TEMPLATE_RESOURCE,
  BANK_RECONCILIATION_RESOURCE,
  BANK_TRANSACTION_RESOURCE,
  type BankingService,
} from './banking-service.ts'
export { createBankAccountService, type BankAccountService } from './banking-accounts.ts'
export {
  createExpenseService,
  EXPENSE_REPORT_ITEM_RESOURCE,
  EXPENSE_REPORT_RESOURCE,
  type ExpenseService,
} from './expense-service.ts'
export {
  createBillService,
  BILL_HOLDING_RESOURCE,
  BILL_RESOURCE,
  BILL_TRANSACTION_RESOURCE,
  type BillService,
} from './bill-service.ts'
export { vatInvoiceRoutes } from './routes.ts'
export {
  bankTransactionRoutes,
  bankImportTemplateRoutes,
  bankImportRoutes,
  bankImportItemRoutes,
  bankReconciliationRoutes,
  expenseReportRoutes,
  expenseReportItemRoutes,
  billRoutes,
  billTransactionRoutes,
  billHoldingRoutes,
} from './ops-routes.ts'
export { allFinanceResourceMetas, vatInvoiceResourceMeta } from './meta.ts'
export {
  ACC_BANK_TRANSACTION,
  type AccBankTransactionPermission,
} from './permissions.ts'
export {
  createAccountingSettingService,
  accountingSettingResourceMeta,
  registerFinanceSettingResources,
  type AccountingSettingService,
  type AccountingSetting,
  type AccountingUpdate,
  ACC_RESOURCE_NAME,
} from './settings.ts'

export function registerFinanceResources(registry: Registry): void {
  for (const meta of allFinanceResourceMetas()) {
    registry.register(meta)
  }
  registerFinanceSettingResources(registry)
}

/**
 * 开票/收票待办源：对账确认 → 增值税发票。
 * 第二类待办接入只需再 registerSource，零改 platform/todo。
 */
export function registerFinanceTodoSources(todos: TodoSourceRegistry): void {
  const invoiceAction = ['acc.vat_invoice:create'] as const
  const invoiceUnread = ['acc.vat_invoice:create', 'acc.vat_invoice:read'] as const
  todos.registerSource('sales.reconciliation', {
    actionPermissions: invoiceAction,
    unreadPermissions: invoiceUnread,
    draftLink: {
      table: 'acc_vat_invoice',
      fkColumn: 'sal_reconciliation_id',
      statusColumn: 'status',
      statusValue: 'draft',
    },
  })
  todos.registerSource('purchase.reconciliation', {
    actionPermissions: invoiceAction,
    unreadPermissions: invoiceUnread,
    draftLink: {
      table: 'acc_vat_invoice',
      fkColumn: 'pur_reconciliation_id',
      statusColumn: 'status',
      statusValue: 'draft',
    },
  })
}

export function createFinanceServices(
  db: Kysely<Database>,
  numbering: NumberingService,
  deps: {
    reconciliations: Pick<
      ReconciliationService,
      'closeFromInvoice' | 'reopenFromInvoice' | 'existsForInvoice' | 'loadForInvoiceAudit'
    >
    journals: Pick<JournalService, 'createAndAuditJournal'>
    files?: Pick<FileService, 'readStoredFile' | 'readReachableFile'> | null
    /** 判定归宿解析（三个执行点共用） */
    registry: Registry
  },
) {
  const gl = createGlEngine()
  const registry = deps.registry
  return {
    invoices: createVatInvoiceService(db, numbering, {
      gl,
      reconciliations: deps.reconciliations,
      files: deps.files ?? null,
      registry,
    }),
    banking: createBankingService(db, numbering, {
      journals: deps.journals,
      files: deps.files ?? null,
      registry,
    }),
    bankAccounts: createBankAccountService(db, registry),
    expenses: createExpenseService(db, numbering, gl, registry),
    bills: createBillService(db, numbering, { gl, files: deps.files ?? null, registry }),
  }
}

export type FinanceServices = ReturnType<typeof createFinanceServices>
