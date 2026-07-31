import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  createRowCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import {
  decimalWireInput,
  resourceListBody,
} from './resource-wire'
import type { ResourceQuery, ResourceTransport } from './types'

type BankAccountCreate = Record<string, unknown>
type BankAccountUpdate = Record<string, unknown>
type BankTransactionCreate = Record<string, unknown>
type BankTransactionUpdate = Record<string, unknown>
type BankImportTemplateCreate =
  Record<string, unknown>
type BankImportTemplateUpdate =
  Record<string, unknown>
type BankImportCreate = Record<string, unknown>
type BankImportItemUpdate = Record<string, unknown>
type BankReconciliationCreate =
  Record<string, unknown>
type BankReconciliationQuickCreate =
  Record<string, unknown>
type VatInvoiceCreate = Record<string, unknown>
type VatInvoiceUpdate = Record<string, unknown>
type VatInvoiceReverse = Record<string, unknown>
type ExpenseReportCreate = Record<string, unknown>
type ExpenseReportUpdate = Record<string, unknown>
type ExpenseReportItemCreate =
  Record<string, unknown>
type ExpenseReportItemUpdate =
  Record<string, unknown>
type BillUpdate = Record<string, unknown>
type BillTransactionCreate = Record<string, unknown>
type BillTransactionUpdate = Record<string, unknown>

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

const metaNames = [
  'accBankAccounts',
  'accBankTransactions',
  'accBankImportTemplates',
  'accBankImports',
  'accBankImportItems',
  'accBankReconciliations',
  'accVatInvoices',
  'accExpenseReports',
  'accExpenseReportItems',
  'accBills',
  'accBillTransactions',
  'accBillHoldings',
] as const

type FinanceMetaName = (typeof metaNames)[number]

const listWireOptions = {
  resourceLabel: '财务',
  extraFields: 'reject',
  joinFields: 'reject',
} as const

type ResourceOperations = Pick<ResourceTransport, 'query' | 'get'> &
  Partial<Pick<ResourceTransport, 'create' | 'update' | 'delete'>>

function resourceClient<const TOperations extends ResourceOperations>(
  resource: FinanceMetaName,
  operations: TOperations,
): { id: string } & TOperations {
  return {
    id: `rest:${resource}`,
    ...operations,
  }
}

const bankAmountFields = ['income', 'expense', 'balance'] as const

export const bankAccountClient = resourceClient('accBankAccounts', {
  async query(input) {
    const result = await apiData(
      api.finance['bank-accounts'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['bank-accounts'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.finance['bank-accounts'].$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['bank-accounts'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.finance['bank-accounts'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bankTransactionClient = resourceClient('accBankTransactions', {
  async query(input) {
    const result = await apiData(
      api.finance['bank-transactions'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['bank-transactions'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.finance['bank-transactions'].$post({
        json: decimalWireInput(input, bankAmountFields) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['bank-transactions'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, bankAmountFields) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.finance['bank-transactions'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bankImportTemplateClient = resourceClient(
  'accBankImportTemplates',
  {
    async query(input) {
      const result = await apiData(
        api.finance['bank-import-templates'].query.$post({
          json: resourceListBody(input, listWireOptions)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.finance['bank-import-templates'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.finance['bank-import-templates'].$post({
          json: input as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.finance['bank-import-templates'][':id'].$patch({
          param: { id },
          json: input as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.finance['bank-import-templates'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const bankImportClient = resourceClient('accBankImports', {
  async query(input) {
    const result = await apiData(
      api.finance['bank-imports'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['bank-imports'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.finance['bank-imports'].$post({
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.finance['bank-imports'][':id'].$delete({
        param: { id }}),
    )
  },
})

export async function importBankImport(id: string): Promise<BankImportRow> {
  return apiData(
    api.finance['bank-imports'][':id'].import.$post({
      param: { id }}),
  )
}

export const bankImportItemClient = resourceClient('accBankImportItems', {
  async query(input) {
    const result = await apiData(
      api.finance['bank-import-items'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['bank-import-items'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['bank-import-items'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, bankAmountFields) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.finance['bank-import-items'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bankReconciliationClient = resourceClient(
  'accBankReconciliations',
  {
    async query(input) {
      const result = await apiData(
        api.finance['bank-reconciliations'].query.$post({
          json: resourceListBody(input, listWireOptions)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.finance['bank-reconciliations'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.finance['bank-reconciliations'].$post({
          json: decimalWireInput(input, ['amount']) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.finance['bank-reconciliations'][':id'].$delete({
          param: { id }}),
      )
    },
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

const invoiceAmounts = ['netTotal', 'taxTotal', 'grossTotal'] as const

export const vatInvoiceClient = resourceClient('accVatInvoices', {
  async query(input) {
    const result = await apiData(
      api.finance['vat-invoices'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['vat-invoices'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.finance['vat-invoices'].$post({
        json: decimalWireInput(input, invoiceAmounts) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['vat-invoices'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, invoiceAmounts) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.finance['vat-invoices'][':id'].$delete({
        param: { id }}),
    )
  },
})

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

export const expenseReportClient = resourceClient('accExpenseReports', {
  async query(input) {
    const result = await apiData(
      api.finance['expense-reports'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['expense-reports'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.finance['expense-reports'].$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['expense-reports'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.finance['expense-reports'][':id'].$delete({
        param: { id }}),
    )
  },
})

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

export const expenseReportItemClient = resourceClient(
  'accExpenseReportItems',
  {
    async query(input) {
      const result = await apiData(
        api.finance['expense-report-items'].query.$post({
          json: resourceListBody(input, listWireOptions)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.finance['expense-report-items'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.finance['expense-report-items'].$post({
          json: decimalWireInput(input, ['amount']) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.finance['expense-report-items'][':id'].$patch({
          param: { id },
          json: decimalWireInput(input, ['amount']) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.finance['expense-report-items'][':id'].$delete({
          param: { id }}),
      )
    },
  },
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

export const billClient = resourceClient('accBills', {
  async query(input) {
    const result = await apiData(
      api.finance.bills.query.$post({ json: resourceListBody(input, listWireOptions) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance.bills[':id'].$get({
        param: { id }}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance.bills[':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['faceAmount']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.finance.bills[':id'].$delete({
        param: { id }}),
    )
  },
})

const billAmounts = [
  'amount',
  'discountRate',
  'interest',
  'netAmount',
] as const

export const billTransactionClient = resourceClient('accBillTransactions', {
  async query(input) {
    const result = await apiData(
      api.finance['bill-transactions'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['bill-transactions'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.finance['bill-transactions'].$post({
        json: decimalWireInput(input, billAmounts) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['bill-transactions'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, billAmounts) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.finance['bill-transactions'][':id'].$delete({
        param: { id }}),
    )
  },
})

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

export const billHoldingClient = resourceClient('accBillHoldings', {
  async query(input) {
    const result = await apiData(
      api.finance['bill-holdings'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['bill-holdings'][':id'].$get({
        param: { id }}),
    )) as Row
  },
})
