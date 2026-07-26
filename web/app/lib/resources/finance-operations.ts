import { apiClient, apiData } from '../api/client'
import type { components } from '../api/schema'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type ListQuery = components['schemas']['ListQuery']
type BankAccountCreate = components['schemas']['BankAccountCreate']
type BankAccountUpdate = components['schemas']['BankAccountUpdate']
type BankTransactionCreate = components['schemas']['BankTransactionCreate']
type BankTransactionUpdate = components['schemas']['BankTransactionUpdate']
type BankImportTemplateCreate =
  components['schemas']['BankImportTemplateCreate']
type BankImportTemplateUpdate =
  components['schemas']['BankImportTemplateUpdate']
type BankImportCreate = components['schemas']['BankImportCreate']
type BankImportItemUpdate = components['schemas']['BankImportItemUpdate']
type BankReconciliationCreate =
  components['schemas']['BankReconciliationCreate']
type BankReconciliationQuickCreate =
  components['schemas']['BankReconciliationQuickCreate']
type VatInvoiceCreate = components['schemas']['VatInvoiceCreate']
type VatInvoiceUpdate = components['schemas']['VatInvoiceUpdate']
type VatInvoiceReverse = components['schemas']['VatInvoiceReverse']
type ExpenseReportCreate = components['schemas']['ExpenseReportCreate']
type ExpenseReportUpdate = components['schemas']['ExpenseReportUpdate']
type ExpenseReportItemCreate =
  components['schemas']['ExpenseReportItemCreate']
type ExpenseReportItemUpdate =
  components['schemas']['ExpenseReportItemUpdate']
type BillUpdate = components['schemas']['BillUpdate']
type BillTransactionCreate = components['schemas']['BillTransactionCreate']
type BillTransactionUpdate = components['schemas']['BillTransactionUpdate']

export type BankImportRow = components['schemas']['BankImport']
export type BankImportItemRow = components['schemas']['BankImportItem']
export type BankReconciliationRow =
  components['schemas']['BankReconciliation']
export type FinanceOCRResult = components['schemas']['OCRResult']
export type ExpenseReportItemRow =
  components['schemas']['ExpenseReportItem']

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
    } as components['schemas']['FilterState'],
  }
}

async function meta(resource: FinanceMetaName) {
  return gridMeta(
    await apiData(
      apiClient.GET('/meta/resources/{name}', {
        params: { path: { name: resource } },
      }),
    ),
  )
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
  operations: Omit<ResourceClient, 'id' | 'meta'>,
): ResourceClient {
  return {
    id: `rest:${resource}`,
    meta: () => meta(resource),
    ...operations,
  }
}

const bankAmountFields = ['income', 'expense', 'balance'] as const

export const bankAccountClient = resourceClient('accBankAccounts', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/finance/bank-accounts/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/bank-accounts/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/finance/bank-accounts', {
        body: input as BankAccountCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/finance/bank-accounts/{id}', {
        params: { path: { id } },
        body: input as BankAccountUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/finance/bank-accounts/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const bankTransactionClient = resourceClient('accBankTransactions', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/finance/bank-transactions/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/bank-transactions/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/finance/bank-transactions', {
        body: decimalInput(input, bankAmountFields) as BankTransactionCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/finance/bank-transactions/{id}', {
        params: { path: { id } },
        body: decimalInput(input, bankAmountFields) as BankTransactionUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/finance/bank-transactions/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const bankImportTemplateClient = resourceClient(
  'accBankImportTemplates',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/finance/bank-import-templates/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/finance/bank-import-templates/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/finance/bank-import-templates', {
          body: input as BankImportTemplateCreate,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/finance/bank-import-templates/{id}', {
          params: { path: { id } },
          body: input as BankImportTemplateUpdate,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/finance/bank-import-templates/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export const bankImportClient = resourceClient('accBankImports', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/finance/bank-imports/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/bank-imports/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/finance/bank-imports', {
        body: input as BankImportCreate,
      }),
    )) as Row
  },
  update: unsupported('银行导入批次'),
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/finance/bank-imports/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export async function importBankImport(id: string): Promise<BankImportRow> {
  return apiData(
    apiClient.POST('/finance/bank-imports/{id}/import', {
      params: { path: { id } },
    }),
  )
}

export const bankImportItemClient = resourceClient('accBankImportItems', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/finance/bank-import-items/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/bank-import-items/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  create: unsupported('银行导入暂存行'),
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/finance/bank-import-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, bankAmountFields) as BankImportItemUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/finance/bank-import-items/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const bankReconciliationClient = resourceClient(
  'accBankReconciliations',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/finance/bank-reconciliations/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/finance/bank-reconciliations/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/finance/bank-reconciliations', {
          body: decimalInput(input, ['amount']) as BankReconciliationCreate,
        }),
      )) as Row
    },
    update: unsupported('银行对账记录'),
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/finance/bank-reconciliations/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export async function fetchBankReconciliationRemaining(
  bankTransactionId: string,
  journalId: string,
) {
  const result = await apiData(
    apiClient.GET('/finance/bank-reconciliations/remaining', {
      params: { query: { bankTransactionId, journalId } },
    }),
  )
  return result.amount
}

export function quickCreateBankReconciliation(
  input: BankReconciliationQuickCreate,
): Promise<BankReconciliationRow> {
  return apiData(
    apiClient.POST('/finance/bank-reconciliations/quick-create', {
      body: {
        ...input,
        amount: String(input.amount),
      },
    }),
  )
}

const invoiceAmounts = ['netTotal', 'taxTotal', 'grossTotal'] as const

export const vatInvoiceClient = resourceClient('accVatInvoices', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/finance/vat-invoices/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/vat-invoices/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/finance/vat-invoices', {
        body: decimalInput(input, invoiceAmounts) as VatInvoiceCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/finance/vat-invoices/{id}', {
        params: { path: { id } },
        body: decimalInput(input, invoiceAmounts) as VatInvoiceUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/finance/vat-invoices/{id}', {
        params: { path: { id } },
      }),
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
    apiClient.POST('/finance/vat-invoices/{id}/audit', {
      params: { path: { id } },
      body: postingDate ? { postingDate } : {},
    }),
  )
}

export function voidVatInvoice(id: string) {
  return apiData(
    apiClient.POST('/finance/vat-invoices/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export function reverseVatInvoice(id: string, input: VatInvoiceReverse) {
  return apiData(
    apiClient.POST('/finance/vat-invoices/{id}/reverse', {
      params: { path: { id } },
      body: input,
    }),
  )
}

export function ocrVatInvoice(fileId: string): Promise<FinanceOCRResult> {
  return apiData(
    apiClient.POST('/finance/vat-invoices/ocr', {
      body: { fileId },
    }),
  )
}

export const expenseReportClient = resourceClient('accExpenseReports', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/finance/expense-reports/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/expense-reports/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/finance/expense-reports', {
        body: input as ExpenseReportCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/finance/expense-reports/{id}', {
        params: { path: { id } },
        body: input as ExpenseReportUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/finance/expense-reports/{id}', {
        params: { path: { id } },
      }),
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
    apiClient.POST('/finance/expense-reports/{id}/audit', {
      params: { path: { id } },
      body: postingDate ? { postingDate } : {},
    }),
  )
}

export function voidExpenseReport(id: string) {
  return apiData(
    apiClient.POST('/finance/expense-reports/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export const expenseReportItemClient = resourceClient(
  'accExpenseReportItems',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/finance/expense-report-items/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/finance/expense-report-items/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/finance/expense-report-items', {
          body: decimalInput(input, ['amount']) as ExpenseReportItemCreate,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/finance/expense-report-items/{id}', {
          params: { path: { id } },
          body: decimalInput(input, ['amount']) as ExpenseReportItemUpdate,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/finance/expense-report-items/{id}', {
          params: { path: { id } },
        }),
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
      apiClient.POST('/finance/bills/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/bills/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  create: unsupported('承兑票据'),
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/finance/bills/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['faceAmount']) as BillUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/finance/bills/{id}', {
        params: { path: { id } },
      }),
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
      apiClient.POST('/finance/bill-transactions/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/bill-transactions/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/finance/bill-transactions', {
        body: decimalInput(input, billAmounts) as BillTransactionCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/finance/bill-transactions/{id}', {
        params: { path: { id } },
        body: decimalInput(input, billAmounts) as BillTransactionUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/finance/bill-transactions/{id}', {
        params: { path: { id } },
      }),
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
    apiClient.POST('/finance/bill-transactions/{id}/audit', {
      params: { path: { id } },
      body: postingDate ? { postingDate } : {},
    }),
  )
}

export function voidBillTransaction(id: string) {
  return apiData(
    apiClient.POST('/finance/bill-transactions/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export function ocrBillTransaction(fileId: string): Promise<FinanceOCRResult> {
  return apiData(
    apiClient.POST('/finance/bill-transactions/ocr', {
      body: { fileId },
    }),
  )
}

const holdingWrite = unsupported('承兑持有投影')

export const billHoldingClient = resourceClient('accBillHoldings', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/finance/bill-holdings/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/finance/bill-holdings/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  create: holdingWrite,
  update: holdingWrite,
  delete: async () => {
    await holdingWrite()
  },
})
