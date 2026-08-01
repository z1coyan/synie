import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import {
  unboundCommandAdapter,
  unboundResourceClient,
  unavailableResourceOperation,
} from './unbound'

type BankImportCreate = Record<string, unknown>
type BankImportItemUpdate = Record<string, unknown>
type BankReconciliationQuickCreate = Record<string, unknown>
type VatInvoiceReverse = Record<string, unknown>

export interface FinanceBankingSemanticOperations {
  fetchBankReconciliationRemaining(bankTransactionId: string, journalId: string): Promise<string>
  quickCreateBankReconciliation(input: BankReconciliationQuickCreate): Promise<BankReconciliationRow>
  createBankImport(input: BankImportCreate): Promise<BankImportRow>
  commitBankImport(id: string): Promise<BankImportRow>
  removeBankImport(id: string): Promise<void>
  updateBankImportItem(id: string, input: BankImportItemUpdate): Promise<BankImportItemRow>
  removeBankImportItem(id: string): Promise<void>
  ocrConfigured(): Promise<{ configured: boolean }>
  ocrVatInvoice(fileId: string): Promise<FinanceOCRResult>
  ocrBillTransaction(fileId: string): Promise<FinanceOCRResult>
}

export type BankImportRow = Record<string, unknown> & {
  id: string
  status: string
  error: string | null
  importedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  bankAccountId: string
  templateId: string
  fileId: string
  createdById: string | null
  itemCount?: number
  errorCount?: number
}
export type BankImportItemRow = Record<string, unknown> & { id: string }
export type BankReconciliationRow = Record<string, unknown> & { id: string }
export type FinanceOCRResult = Record<string, unknown>
export type ExpenseReportItemRow = Record<string, unknown> & { id: string }

let semanticOperations: FinanceBankingSemanticOperations | null = null

export function activateFinanceBankingSemanticOperations(
  operations: FinanceBankingSemanticOperations,
): void {
  semanticOperations = operations
}

function banking(): FinanceBankingSemanticOperations {
  if (!semanticOperations) throw new Error('财务能力尚未由 Convex 应用壳装配')
  return semanticOperations
}

export const bankAccountClient = unboundResourceClient('accBankAccounts')
export const bankTransactionClient = unboundResourceClient('accBankTransactions')
export const bankImportTemplateClient = unboundResourceClient('accBankImportTemplates')
export const bankImportClient = unboundResourceClient('accBankImports')
export const bankImportItemClient = unboundResourceClient('accBankImportItems')
export const bankReconciliationClient = unboundResourceClient('accBankReconciliations')
export const vatInvoiceClient = unboundResourceClient('accVatInvoices')
export const expenseReportClient = unboundResourceClient('accExpenseReports')
export const expenseReportItemClient = unboundResourceClient('accExpenseReportItems')
export const billClient = unboundResourceClient('accBills')
export const billTransactionClient = unboundResourceClient('accBillTransactions')
export const billHoldingClient = unboundResourceClient('accBillHoldings')

export const createBankImport = (input: BankImportCreate) =>
  banking().createBankImport(input)
export const importBankImport = (id: string) => banking().commitBankImport(id)
export const removeBankImport = (id: string) => banking().removeBankImport(id)
export const updateBankImportItem = (id: string, input: BankImportItemUpdate) =>
  banking().updateBankImportItem(id, input)
export const removeBankImportItem = (id: string) =>
  banking().removeBankImportItem(id)
export const fetchBankReconciliationRemaining = (
  bankTransactionId: string,
  journalId: string,
) => banking().fetchBankReconciliationRemaining(bankTransactionId, journalId)
export const quickCreateBankReconciliation = (
  input: BankReconciliationQuickCreate,
) => banking().quickCreateBankReconciliation(input)
export const ocrVatInvoice = (fileId: string) => banking().ocrVatInvoice(fileId)
export const financeOcrConfigured = () => banking().ocrConfigured()
export const ocrBillTransaction = (fileId: string) =>
  banking().ocrBillTransaction(fileId)

export type BankReconcileCommandInput = {
  id: string
  journalId: string
  amount: string | number
}

export const bankTransactionCommandAdapter = createCommandAdapter({
  reconcile: defineCommand(
    'row',
    async (input: unknown) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('reconcile 输入须为对象')
      }
      const raw = input as Record<string, unknown>
      const id = decodeRowTarget({ id: raw.id })
      if (typeof raw.journalId !== 'string' || raw.journalId.trim() === '') {
        throw new Error('reconcile 需要 journalId')
      }
      if (raw.amount === undefined || raw.amount === null || raw.amount === '') {
        throw new Error('reconcile 需要 amount')
      }
      void id
      return unavailableResourceOperation()
    },
    { affectedResources: ['accBankReconciliations'] },
  ),
})

export const vatInvoiceCommandAdapter = unboundCommandAdapter({
  audit: 'row',
  void: 'row',
  reverse: 'row',
})
export const expenseReportCommandAdapter = unboundCommandAdapter({
  audit: 'row',
  void: 'row',
})
export const billTransactionCommandAdapter = unboundCommandAdapter({
  audit: 'row',
  void: 'row',
})

export const auditVatInvoice = (id: string, postingDate?: string) =>
  vatInvoiceCommandAdapter.execute('audit', {
    id,
    ...(postingDate ? { postingDate } : {}),
  } as never)
export const voidVatInvoice = (id: string) =>
  vatInvoiceCommandAdapter.execute('void', { id } as never)
export const reverseVatInvoice = (id: string, input: VatInvoiceReverse) =>
  vatInvoiceCommandAdapter.execute('reverse', { id, ...input } as never)
export const auditExpenseReport = (id: string, postingDate?: string) =>
  expenseReportCommandAdapter.execute('audit', {
    id,
    ...(postingDate ? { postingDate } : {}),
  } as never)
export const voidExpenseReport = (id: string) =>
  expenseReportCommandAdapter.execute('void', { id } as never)
export const auditBillTransaction = (id: string, postingDate?: string) =>
  billTransactionCommandAdapter.execute('audit', {
    id,
    ...(postingDate ? { postingDate } : {}),
  } as never)
export const voidBillTransaction = (id: string) =>
  billTransactionCommandAdapter.execute('void', { id } as never)

export async function queryExpenseReportItems(reportId: string): Promise<Row[]> {
  const result = await expenseReportItemClient.query({
    limit: 200,
    offset: 0,
    filter: {
      reportId: { kind: 'fk', values: [reportId], labels: [reportId] },
    },
    sort: { column: 'idx', direction: 'ascending' },
  })
  return result.results
}

export async function saveExpenseReportItems(
  reportId: string,
  current: Row[],
  previous: Row[],
  input: (row: Row) => Record<string, unknown>,
): Promise<string[]> {
  const errors: string[] = []
  const currentIds = new Set(
    current.filter((row) => !row.id.startsWith('local:')).map((row) => row.id),
  )
  for (const old of previous) {
    if (currentIds.has(old.id)) continue
    try {
      await expenseReportItemClient.delete(old.id)
    } catch (error) {
      errors.push(`第 ${old.idx ?? '?'} 行删除失败: ${(error as Error).message}`)
    }
  }
  for (const row of current) {
    try {
      if (row.id.startsWith('local:')) {
        await expenseReportItemClient.create({ ...input(row), reportId })
      } else {
        await expenseReportItemClient.update(row.id, input(row))
      }
    } catch (error) {
      errors.push(`第 ${row.idx ?? '?'} 行保存失败: ${(error as Error).message}`)
    }
  }
  return errors
}
