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
import { createExpenseService } from './expense-service.ts'
import { createBillService } from './bill-service.ts'
import { allFinanceResourceMetas } from './meta.ts'
import type { TodoSourceRegistry } from '~/platform/todo/source-registry.ts'
import { registerFinanceSettingResources } from './settings.ts'

export { createVatInvoiceService, type VatInvoiceService } from './invoice-service.ts'
export { createBankingService, type BankingService } from './banking-service.ts'
export { createExpenseService, type ExpenseService } from './expense-service.ts'
export { createBillService, type BillService } from './bill-service.ts'
export { vatInvoiceRoutes } from './routes.ts'
export {
  bankAccountRoutes,
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
  },
) {
  const gl = createGlEngine()
  return {
    invoices: createVatInvoiceService(db, numbering, {
      gl,
      reconciliations: deps.reconciliations,
      files: deps.files ?? null,
    }),
    banking: createBankingService(db, numbering, {
      journals: deps.journals,
      files: deps.files ?? null,
    }),
    expenses: createExpenseService(db, numbering, gl),
    bills: createBillService(db, numbering, { gl, files: deps.files ?? null }),
  }
}

export type FinanceServices = ReturnType<typeof createFinanceServices>
