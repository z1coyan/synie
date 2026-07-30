import type { ListQuery } from '@synie/shared'
import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import type { ResourceClient, ResourceQuery } from './types'

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

function queryBody(input: ResourceQuery): ListQuery {
  if (input.extraFields?.length || input.joinFields) {
    throw new Error('财务 REST 资源不支持额外字段或 joinFields')
  }
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    } as FilterState,
  }
}

function decimalInput(
  input: Record<string, unknown>,
  fields: readonly string[],
) {
  const result = { ...input }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    result[field] = value == null || value === '' ? null : String(value)
  }
  return result
}

const unsupported =
  (label: string) =>
  async (): Promise<Row> => {
    throw new Error(`${label}不支持此操作`)
  }

function resourceClient(
  resource: FinanceMetaName,
  operations: Omit<ResourceClient, 'id'>,
): ResourceClient {
  return {
    id: `rest:${resource}`,
        ...operations,
  }
}

const bankAmountFields = ['income', 'expense', 'balance'] as const

export const bankAccountClient = resourceClient('accBankAccounts', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance['bank-accounts'].query.$post({
        json: queryBody(input)}),
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
    await apiData<void>(
      api.finance['bank-accounts'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bankTransactionClient = resourceClient('accBankTransactions', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance['bank-transactions'].query.$post({
        json: queryBody(input)}),
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
        json: decimalInput(input, bankAmountFields) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['bank-transactions'][':id'].$patch({
        param: { id },
        json: decimalInput(input, bankAmountFields) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.finance['bank-transactions'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bankImportTemplateClient = resourceClient(
  'accBankImportTemplates',
  {
    async query(input) {
      const result = await apiData<{ count: number; results: Row[] }>(
        api.finance['bank-import-templates'].query.$post({
          json: queryBody(input)}),
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
      await apiData<void>(
        api.finance['bank-import-templates'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const bankImportClient = resourceClient('accBankImports', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance['bank-imports'].query.$post({
        json: queryBody(input)}),
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
  update: unsupported('银行导入批次'),
  async delete(id) {
    await apiData<void>(
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance['bank-import-items'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['bank-import-items'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  create: unsupported('银行导入暂存行'),
  async update(id, input) {
    return (await apiData(
      api.finance['bank-import-items'][':id'].$patch({
        param: { id },
        json: decimalInput(input, bankAmountFields) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.finance['bank-import-items'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bankReconciliationClient = resourceClient(
  'accBankReconciliations',
  {
    async query(input) {
      const result = await apiData<{ count: number; results: Row[] }>(
        api.finance['bank-reconciliations'].query.$post({
          json: queryBody(input)}),
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
          json: decimalInput(input, ['amount']) as never}),
      )) as Row
    },
    update: unsupported('银行对账记录'),
    async delete(id) {
      await apiData<void>(
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
  const result = await apiData<{ amount: string }>(
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
  reconcile: defineCommand('row', async (input: unknown) => {
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
  }),
})

const invoiceAmounts = ['netTotal', 'taxTotal', 'grossTotal'] as const

export const vatInvoiceClient = resourceClient('accVatInvoices', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance['vat-invoices'].query.$post({
        json: queryBody(input)}),
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
        json: decimalInput(input, invoiceAmounts) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['vat-invoices'][':id'].$patch({
        param: { id },
        json: decimalInput(input, invoiceAmounts) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.finance['vat-invoices'][':id'].$delete({
        param: { id }}),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditVatInvoice(id)
      else if (key === 'void') await voidVatInvoice(id)
      else throw new Error(`增值税发票 REST Client 未实现动作 ${key}`)
    }
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

export function ocrVatInvoice(fileId: string): Promise<FinanceOCRResult> {
  return apiData(
    api.finance['vat-invoices'].ocr.$post({
      json: { fileId }}),
  )
}

export const expenseReportClient = resourceClient('accExpenseReports', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance['expense-reports'].query.$post({
        json: queryBody(input)}),
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
    await apiData<void>(
      api.finance['expense-reports'][':id'].$delete({
        param: { id }}),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditExpenseReport(id)
      else if (key === 'void') await voidExpenseReport(id)
      else throw new Error(`报销单 REST Client 未实现动作 ${key}`)
    }
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

export const expenseReportItemClient = resourceClient(
  'accExpenseReportItems',
  {
    async query(input) {
      const result = await apiData<{ count: number; results: Row[] }>(
        api.finance['expense-report-items'].query.$post({
          json: queryBody(input)}),
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
          json: decimalInput(input, ['amount']) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.finance['expense-report-items'][':id'].$patch({
          param: { id },
          json: decimalInput(input, ['amount']) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance.bills.query.$post({ json: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance.bills[':id'].$get({
        param: { id }}),
    )) as Row
  },
  create: unsupported('承兑票据'),
  async update(id, input) {
    return (await apiData(
      api.finance.bills[':id'].$patch({
        param: { id },
        json: decimalInput(input, ['faceAmount']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance['bill-transactions'].query.$post({
        json: queryBody(input)}),
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
        json: decimalInput(input, billAmounts) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.finance['bill-transactions'][':id'].$patch({
        param: { id },
        json: decimalInput(input, billAmounts) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.finance['bill-transactions'][':id'].$delete({
        param: { id }}),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditBillTransaction(id)
      else if (key === 'void') await voidBillTransaction(id)
      else throw new Error(`承兑交易 REST Client 未实现动作 ${key}`)
    }
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

export function ocrBillTransaction(fileId: string): Promise<FinanceOCRResult> {
  return apiData(
    api.finance['bill-transactions'].ocr.$post({
      json: { fileId }}),
  )
}

const holdingWrite = unsupported('承兑持有投影')

export const billHoldingClient = resourceClient('accBillHoldings', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.finance['bill-holdings'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.finance['bill-holdings'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  create: holdingWrite,
  update: holdingWrite,
  delete: async () => {
    await holdingWrite()
  },
})
