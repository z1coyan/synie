import { apiClient, apiData } from '../api/client'
import type { components } from '../api/schema'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type ListQuery = components['schemas']['ListQuery']
type AttendanceCorrectionCreate =
  components['schemas']['AttendanceCorrectionCreate']
type AttendanceCorrectionUpdate =
  components['schemas']['AttendanceCorrectionUpdate']
type PayrollCreate = components['schemas']['PayrollCreate']
type PayrollUpdate = components['schemas']['PayrollUpdate']
type PayrollPaymentCreate = components['schemas']['PayrollPaymentCreate']
type EmployeeLoanCreate = components['schemas']['EmployeeLoanCreate']
type EmployeeLoanUpdate = components['schemas']['EmployeeLoanUpdate']

export type AttendanceMonthSummary =
  components['schemas']['AttendanceMonthSummary']
export type PayrollMonthStats = components['schemas']['PayrollMonthStats']
export type PayrollGenerationResult =
  components['schemas']['PayrollGenerateResult']
export type EmployeeLoanBalance =
  components['schemas']['EmployeeLoanBalance']
export type AttendanceImportRow = components['schemas']['AttendanceImport']
export type PayrollPaymentRow = Omit<
  components['schemas']['PayrollPayment'],
  'kind'
> & {
  kind: components['schemas']['PayrollPaymentKind']
}

export type AttendanceImportExecution = Omit<
  AttendanceImportRow,
  | 'importedCount'
  | 'skippedExistingRows'
  | 'skippedUnmatchedRows'
  | 'autoCreatedCount'
> & {
  importedCount: number
  skippedExistingRows: number
  skippedUnmatchedRows: number
  autoCreatedCount: number
}

function queryBody(input: ResourceQuery): ListQuery {
  if (input.extraFields?.length || input.joinFields) {
    throw new Error('人力 REST 资源不支持额外字段或 joinFields')
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

async function meta(resource: string) {
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
  resource: string,
  operations: Omit<ResourceClient, 'id' | 'meta'>,
): ResourceClient {
  return {
    id: `rest:${resource}`,
    meta: () => meta(resource),
    ...operations,
  }
}

const punchWrite = unsupported('原始打卡')

export const attendancePunchClient = resourceClient('hrAttendancePunches', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/hr/attendance-punches/query', {
        body: queryBody(input),
      }),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/hr/attendance-punches/{id}', {
        params: { path: { id } },
      }),
    )) as unknown as Row
  },
  create: punchWrite,
  update: punchWrite,
  delete: async () => {
    await punchWrite()
  },
})

export const attendanceImportClient = resourceClient('hrAttendanceImports', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/hr/attendance-imports/query', {
        body: queryBody(input),
      }),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/hr/attendance-imports/{id}', {
        params: { path: { id } },
      }),
    )) as unknown as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/hr/attendance-imports', {
        body: input as unknown as components['schemas']['AttendanceImportCreate'],
      }),
    )) as unknown as Row
  },
  update: unsupported('考勤导入批次'),
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/hr/attendance-imports/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export async function createAttendanceImport(
  fileId: string,
): Promise<AttendanceImportRow> {
  return apiData(
    apiClient.POST('/hr/attendance-imports', {
      body: { fileId },
    }),
  )
}

export async function importAttendanceImport(
  id: string,
  autoCreateEmployees: boolean,
): Promise<AttendanceImportExecution> {
  const result = await apiData(
    apiClient.POST('/hr/attendance-imports/{id}/import', {
      params: { path: { id } },
      body: { autoCreateEmployees },
    }),
  )
  return result as AttendanceImportExecution
}

const dayWrite = unsupported('日考勤')

export const attendanceDayClient = resourceClient('hrAttendanceDays', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/hr/attendance-days/query', {
        body: queryBody(input),
      }),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/hr/attendance-days/{id}', {
        params: { path: { id } },
      }),
    )) as unknown as Row
  },
  create: dayWrite,
  update: dayWrite,
  delete: async () => {
    await dayWrite()
  },
})

export async function recalcAttendanceDays(
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  const result = await apiData(
    apiClient.POST('/hr/attendance-days/recalc', {
      body: { dateFrom, dateTo },
    }),
  )
  return result.count
}

export function fetchAttendanceMonthSummary(month: string) {
  return apiData(
    apiClient.GET('/hr/attendance-days/month-summary', {
      params: { query: { month } },
    }),
  )
}

export const attendanceCorrectionClient = resourceClient(
  'hrAttendanceCorrections',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/hr/attendance-corrections/query', {
          body: queryBody(input),
        }),
      )
      return {
        count: result.count,
        results: result.results as unknown as Row[],
      }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/hr/attendance-corrections/{id}', {
          params: { path: { id } },
        }),
      )) as unknown as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/hr/attendance-corrections', {
          body: input as unknown as AttendanceCorrectionCreate,
        }),
      )) as unknown as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/hr/attendance-corrections/{id}', {
          params: { path: { id } },
          body: input as AttendanceCorrectionUpdate,
        }),
      )) as unknown as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/hr/attendance-corrections/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export async function saveAttendanceCorrection(
  id: string | null,
  input: Record<string, unknown>,
) {
  return id
    ? attendanceCorrectionClient.update(id, input)
    : attendanceCorrectionClient.create(input)
}

const payrollDecimals = [
  'workdays',
  'overtimeHours',
  'dailyWage',
  'allowance',
  'bonus',
  'fine',
  'loanDeduction',
] as const

function payrollCreateInput(
  input: Record<string, unknown>,
): PayrollCreate {
  const result = decimalInput(input, payrollDecimals)
  for (const field of payrollDecimals) {
    if (result[field] == null) result[field] = '0'
  }
  for (const field of ['attendanceDays', 'missingDays'] as const) {
    if (result[field] == null || result[field] === '') result[field] = 0
  }
  return result as unknown as PayrollCreate
}

export const payrollClient = resourceClient('hrPayrolls', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/hr/payrolls/query', { body: queryBody(input) }),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/hr/payrolls/{id}', {
        params: { path: { id } },
      }),
    )) as unknown as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/hr/payrolls', {
        body: payrollCreateInput(input),
      }),
    )) as unknown as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/hr/payrolls/{id}', {
        params: { path: { id } },
        body: decimalInput(input, payrollDecimals) as PayrollUpdate,
      }),
    )) as unknown as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/hr/payrolls/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export async function savePayroll(
  id: string | null,
  input: Record<string, unknown>,
) {
  return id ? payrollClient.update(id, input) : payrollClient.create(input)
}

export function refreshPayroll(id: string) {
  return apiData(
    apiClient.POST('/hr/payrolls/{id}/refresh', {
      params: { path: { id } },
    }),
  )
}

export function generatePayrolls(
  month: string,
): Promise<PayrollGenerationResult> {
  return apiData(
    apiClient.POST('/hr/payrolls/generate', {
      body: { month },
    }),
  )
}

export function fetchPayrollMonthStats(
  month: string,
): Promise<PayrollMonthStats> {
  return apiData(
    apiClient.GET('/hr/payrolls/month-stats', {
      params: { query: { month } },
    }),
  )
}

export const payrollPaymentClient = resourceClient('hrPayrollPayments', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/hr/payroll-payments/query', {
        body: queryBody(input),
      }),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/hr/payroll-payments/{id}', {
        params: { path: { id } },
      }),
    )) as unknown as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/hr/payroll-payments', {
        body: decimalInput(input, ['amount']) as unknown as PayrollPaymentCreate,
      }),
    )) as unknown as Row
  },
  update: unsupported('工资发放记录'),
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/hr/payroll-payments/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export async function queryPayrollPayments(
  payrollId: string,
): Promise<PayrollPaymentRow[]> {
  const result = await payrollPaymentClient.query({
    limit: 200,
    offset: 0,
    fixedFilter: {
      payrollId: {
        kind: 'fk',
        op: 'in',
        values: [payrollId],
        labels: [],
      },
    },
    sort: { column: 'paidOn', direction: 'ascending' },
  })
  return result.results as unknown as PayrollPaymentRow[]
}

export function createPayrollPayment(input: Record<string, unknown>) {
  return payrollPaymentClient.create(input)
}

export function deletePayrollPayment(id: string) {
  return payrollPaymentClient.delete(id)
}

export function payRemainingPayroll(
  payrollId: string,
  paidOn: string,
  remarks?: string,
) {
  return apiData(
    apiClient.POST('/hr/payroll-payments/pay-remaining', {
      body: { payrollId, paidOn, remarks },
    }),
  )
}

export const employeeLoanClient = resourceClient('hrEmployeeLoans', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/hr/employee-loans/query', {
        body: queryBody(input),
      }),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/hr/employee-loans/{id}', {
        params: { path: { id } },
      }),
    )) as unknown as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/hr/employee-loans', {
        body: decimalInput(input, ['amount']) as unknown as EmployeeLoanCreate,
      }),
    )) as unknown as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/hr/employee-loans/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['amount']) as EmployeeLoanUpdate,
      }),
    )) as unknown as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/hr/employee-loans/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export async function saveEmployeeLoan(
  id: string | null,
  input: Record<string, unknown>,
) {
  return id
    ? employeeLoanClient.update(id, input)
    : employeeLoanClient.create(input)
}

export function fetchEmployeeLoanBalances(): Promise<EmployeeLoanBalance[]> {
  return apiData(apiClient.GET('/hr/employee-loans/balances'))
}
