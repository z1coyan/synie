import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  createRowCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import { restTransport } from './rest-transport'


type BankReconciliationQuickCreate =
  Record<string, unknown>
type VatInvoiceReverse = Record<string, unknown>

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

const listWireOptions = {
  resourceLabel: '财务',
  extraFields: 'reject',
  joinFields: 'reject',
} as const

export const bankAccountClient = restTransport(
  'accBankAccounts',
  api.finance['bank-accounts'],
  { listOptions: listWireOptions },
)

export const bankTransactionClient = restTransport(
  'accBankTransactions',
  api.finance['bank-transactions'],
  { listOptions: listWireOptions },
)

export const bankImportTemplateClient = restTransport(
  'accBankImportTemplates',
  api.finance['bank-import-templates'],
  { listOptions: listWireOptions },
)

export const bankImportClient = restTransport(
  'accBankImports',
  api.finance['bank-imports'],
  { capabilities: { update: false }, listOptions: listWireOptions },
)

export async function importBankImport(id: string): Promise<BankImportRow> {
  return apiData(
    api.finance['bank-imports'][':id'].import.$post({
      param: { id }}),
  )
}

export const bankImportItemClient = restTransport(
  'accBankImportItems',
  api.finance['bank-import-items'],
  {
    capabilities: { create: false },
    listOptions: listWireOptions,
  },
)

export const bankReconciliationClient = restTransport(
  'accBankReconciliations',
  api.finance['bank-reconciliations'],
  {
    capabilities: { update: false },
    listOptions: listWireOptions,
  },
)

export async function fetchBankReconciliationRemaining(
  bankTransactionId: string,
  journalId: string,
) {
  const result = await apiData(
    api.finance['bank-reconciliations'].remaining.$get({
      query: { bankTransactionId, journalId },
    }),
  )
  return result.amount
}

export function quickCreateBankReconciliation(
  input: BankReconciliationQuickCreate,
): Promise<BankReconciliationRow> {
  return apiData(
    api.finance['bank-reconciliations']['quick-create'].$post({
      json: {
        ...input,
        amount: String(input.amount),
      } as never,
    }),
  )
}

export type BankReconcileCommandInput = {
  id: string
  journalId: string
  amount: string | number
}

/**
 * accBankTransactions 语义命令：reconcile（非 export）。
 * row target：将流水与已审凭证对账；transport / payload 规范化仅在本 Adapter。
 * 快速新建凭证并对账仍走 quickCreateBankReconciliation（复合 UI 流程）。
 */
export const bankTransactionCommandAdapter = createCommandAdapter({
  reconcile: defineCommand(
    'row',
    async (input: unknown) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('reconcile 输入须为对象')
      }
      const raw = input as Record<string, unknown>
      const id = decodeRowTarget({ id: raw.id })
      const journalId = raw.journalId
      if (typeof journalId !== 'string' || journalId.trim() === '') {
        throw new Error('reconcile 需要 journalId')
      }
      if (raw.amount === undefined || raw.amount === null || raw.amount === '') {
        throw new Error('reconcile 需要 amount')
      }
      return bankReconciliationClient.create({
        bankTransactionId: id,
        journalId,
        amount: String(raw.amount),
      })
    },
    { affectedResources: ['accBankReconciliations'] },
  ),
})

export const vatInvoiceClient = restTransport(
  'accVatInvoices',
  api.finance['vat-invoices'],
  { listOptions: listWireOptions },
)

export function auditVatInvoice(id: string, postingDate?: string) {
  return apiData(
    api.finance['vat-invoices'][':id'].audit.$post({
      param: { id },
      json: (postingDate ? { postingDate } : { postingDate: '' }) as never }),
  )
}

export function voidVatInvoice(id: string) {
  return apiData(
    api.finance['vat-invoices'][':id'].void.$post({
      param: { id }}),
  )
}

export function reverseVatInvoice(id: string, input: VatInvoiceReverse) {
  return apiData(
    api.finance['vat-invoices'][':id'].reverse.$post({
      param: { id },
      json: input as never}),
  )
}

export const vatInvoiceCommandAdapter = createCommandAdapter({
  audit: defineCommand('row', async (input: unknown) => {
    const id = decodeRowTarget(input)
    const postingDate =
      typeof input === 'object' && input !== null && 'postingDate' in input
        ? String((input as Record<string, unknown>).postingDate ?? '')
        : undefined
    return auditVatInvoice(id, postingDate || undefined)
  }),
  void: defineCommand('row', (input: unknown) =>
    voidVatInvoice(decodeRowTarget(input))),
  reverse: defineCommand('row', (input: unknown) => {
    const id = decodeRowTarget(input)
    const raw = input as Record<string, unknown>
    if (typeof raw.postingDate !== 'string' || raw.postingDate === '') {
      throw new Error('reverse 需要 postingDate')
    }
    return reverseVatInvoice(id, {
      postingDate: raw.postingDate,
      redInvoiceNo:
        raw.redInvoiceNo == null || raw.redInvoiceNo === ''
          ? null
          : String(raw.redInvoiceNo),
    })
  }),
})

export function ocrVatInvoice(fileId: string): Promise<FinanceOCRResult> {
  return apiData(
    api.finance['vat-invoices'].ocr.$post({
      json: { fileId }}),
  )
}

export const expenseReportClient = restTransport(
  'accExpenseReports',
  api.finance['expense-reports'],
  { listOptions: listWireOptions },
)

export function auditExpenseReport(id: string, postingDate?: string) {
  return apiData(
    api.finance['expense-reports'][':id'].audit.$post({
      param: { id },
      json: (postingDate ? { postingDate } : { postingDate: '' }) as never,
    }),
  )
}

export function voidExpenseReport(id: string) {
  return apiData(
    api.finance['expense-reports'][':id'].void.$post({
      param: { id }}),
  )
}

export const expenseReportCommandAdapter = createRowCommandAdapter({
  audit: (id) => auditExpenseReport(id),
  void: voidExpenseReport,
})

export const expenseReportItemClient = restTransport(
  'accExpenseReportItems',
  api.finance['expense-report-items'],
  { listOptions: listWireOptions },
)

export async function queryExpenseReportItems(
  reportId: string,
): Promise<Row[]> {
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
        await expenseReportItemClient.create({
          ...input(row),
          reportId,
        })
      } else {
        await expenseReportItemClient.update(row.id, input(row))
      }
    } catch (error) {
      errors.push(`第 ${row.idx ?? '?'} 行保存失败: ${(error as Error).message}`)
    }
  }
  return errors
}

export const billClient = restTransport('accBills', api.finance.bills, {
  capabilities: { create: false },
  listOptions: listWireOptions,
})

export const billTransactionClient = restTransport(
  'accBillTransactions',
  api.finance['bill-transactions'],
  { listOptions: listWireOptions },
)

export function auditBillTransaction(id: string, postingDate?: string) {
  return apiData(
    api.finance['bill-transactions'][':id'].audit.$post({
      param: { id },
      json: (postingDate ? { postingDate } : { postingDate: '' }) as never }),
  )
}

export function voidBillTransaction(id: string) {
  return apiData(
    api.finance['bill-transactions'][':id'].void.$post({
      param: { id }}),
  )
}

export const billTransactionCommandAdapter = createRowCommandAdapter({
  audit: (id) => auditBillTransaction(id),
  void: voidBillTransaction,
})

export function ocrBillTransaction(fileId: string): Promise<FinanceOCRResult> {
  return apiData(
    api.finance['bill-transactions'].ocr.$post({
      json: { fileId }}),
  )
}

export const billHoldingClient = restTransport(
  'accBillHoldings',
  api.finance['bill-holdings'],
  {
    capabilities: { create: false, update: false, delete: false },
    listOptions: listWireOptions,
  },
)
