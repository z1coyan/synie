import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  decodeCollectionTarget,
  defineCommand,
} from './catalog/commands'
import {
  decimalWireInput,
  resourceListBody,
} from './resource-wire'
import type { ResourceQuery, ResourceTransport } from './types'

type AttendanceCorrectionCreate =
  Record<string, unknown>
type AttendanceCorrectionUpdate =
  Record<string, unknown>
type PayrollCreate = Record<string, unknown>
type PayrollUpdate = Record<string, unknown>
type PayrollPaymentCreate = Record<string, unknown>
type EmployeeLoanCreate = Record<string, unknown>
type EmployeeLoanUpdate = Record<string, unknown>

export interface AttendanceMonthSummary {
  employeeId: string
  employeeCode: string | null
  employeeName: string | null
  days: number
  missingDays: number
  normalHours: string
  overtimeHours: string
  bonusWorkdays: string
  workdays: string
}
export interface PayrollMonthStats {
  count: number
  pendingCount?: number
  [key: string]: unknown
}
export interface PayrollGenerationResult {
  created?: number
  skipped?: number
  [key: string]: unknown
}
export interface EmployeeLoanBalance {
  employeeId: string
  employeeCode?: string | null
  employeeName?: string | null
  borrowed?: string
  repaid?: string
  balance: string
}
export type AttendanceImportRow = Record<string, unknown> & {
  id: string
  status?: string
  error?: string | null
  totalRows?: number | null
  matchedRows?: number | null
  unmatchedRows?: number | null
  importedCount?: number | null
  skippedExistingRows?: number | null
  skippedUnmatchedRows?: number | null
  autoCreatedCount?: number | null
}
export type PayrollPaymentKind = string
export interface PayrollPaymentRow {
  id: string
  month: string | null
  paidOn: string
  amount: string
  kind: PayrollPaymentKind
  remarks: string | null
  insertedAt: string
  updatedAt: string
  payrollId: string
  employeeId: string | null
  createdById: string | null
  [key: string]: unknown
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

const listWireOptions = {
  resourceLabel: '人力',
  extraFields: 'reject',
  joinFields: 'reject',
} as const

type ResourceOperations = Pick<ResourceTransport, 'query' | 'get'> &
  Partial<Pick<ResourceTransport, 'create' | 'update' | 'delete'>>

function resourceClient<const TOperations extends ResourceOperations>(
  resource: string,
  operations: TOperations,
): { id: string } & TOperations {
  return {
    id: `rest:${resource}`,
    ...operations,
  }
}

export const attendancePunchClient = resourceClient('hrAttendancePunches', {
  async query(input) {
    const result = await apiData(
      api.hr['attendance-punches'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      api.hr['attendance-punches'][':id'].$get({
        param: { id }}),
    )) as unknown as Row
  },
})

export const attendanceImportClient = resourceClient('hrAttendanceImports', {
  async query(input) {
    const result = await apiData(
      api.hr['attendance-imports'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      api.hr['attendance-imports'][':id'].$get({
        param: { id }}),
    )) as unknown as Row
  },
  async create(input) {
    return (await apiData(
      api.hr['attendance-imports'].$post({
        json: input as never}),
    )) as unknown as Row
  },
  async delete(id) {
    await apiData(
      api.hr['attendance-imports'][':id'].$delete({
        param: { id }}),
    )
  },
})

export async function createAttendanceImport(
  fileId: string,
): Promise<AttendanceImportRow> {
  return apiData(
    api.hr['attendance-imports'].$post({
      json: { fileId }}),
  )
}

export async function importAttendanceImport(
  id: string,
  autoCreateEmployees: boolean,
): Promise<AttendanceImportExecution> {
  const result = await apiData(
    api.hr['attendance-imports'][':id'].import.$post({
      param: { id },
      json: { autoCreateEmployees }}),
  )
  return result as AttendanceImportExecution
}

export const attendanceDayClient = resourceClient('hrAttendanceDays', {
  async query(input) {
    const result = await apiData(
      api.hr['attendance-days'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      api.hr['attendance-days'][':id'].$get({
        param: { id }}),
    )) as unknown as Row
  },
})

export async function recalcAttendanceDays(
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  const result = await apiData(
    api.hr['attendance-days'].recalc.$post({
      json: { dateFrom, dateTo }}),
  )
  return result.count ?? 0
}

export type AttendanceRecalcInput = { dateFrom: string; dateTo: string }

/** hrAttendanceDays 语义命令：recalc 为 collection，不伪造记录 ID */
export const attendanceDayCommandAdapter = createCommandAdapter({
  recalc: defineCommand('collection', async (input: unknown) => {
    const payload = decodeCollectionTarget<AttendanceRecalcInput>(input)
    const dateFrom = payload.dateFrom
    const dateTo = payload.dateTo
    if (typeof dateFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      throw new Error('recalc 需要合法 dateFrom（YYYY-MM-DD）')
    }
    if (typeof dateTo !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      throw new Error('recalc 需要合法 dateTo（YYYY-MM-DD）')
    }
    return recalcAttendanceDays(dateFrom, dateTo)
  }),
})

export function fetchAttendanceMonthSummary(month: string) {
  return apiData(
    api.hr['attendance-days']['month-summary'].$get({
      query: { month },
    }),
  )
}

export const attendanceCorrectionClient = resourceClient(
  'hrAttendanceCorrections',
  {
    async query(input) {
      const result = await apiData(
        api.hr['attendance-corrections'].query.$post({
          json: resourceListBody(input, listWireOptions)}),
      )
      return {
        count: result.count,
        results: result.results as unknown as Row[],
      }
    },
    async get(id) {
      return (await apiData(
        api.hr['attendance-corrections'][':id'].$get({
          param: { id }}),
      )) as unknown as Row
    },
    async create(input) {
      return (await apiData(
        api.hr['attendance-corrections'].$post({
          json: input as never}),
      )) as unknown as Row
    },
    async update(id, input) {
      return (await apiData(
        api.hr['attendance-corrections'][':id'].$patch({
          param: { id },
          json: input as never}),
      )) as unknown as Row
    },
    async delete(id) {
      await apiData(
        api.hr['attendance-corrections'][':id'].$delete({
          param: { id }}),
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
  const result = decimalWireInput(input, payrollDecimals)
  for (const field of payrollDecimals) {
    if (result[field] == null) result[field] = '0'
  }
  for (const field of ['attendanceDays', 'missingDays'] as const) {
    if (result[field] == null || result[field] === '') result[field] = 0
  }
  return result as unknown as never
}

export const payrollClient = resourceClient('hrPayrolls', {
  async query(input) {
    const result = await apiData(
      api.hr.payrolls.query.$post({ json: resourceListBody(input, listWireOptions) }),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      api.hr.payrolls[':id'].$get({
        param: { id }}),
    )) as unknown as Row
  },
  async create(input) {
    return (await apiData(
      api.hr.payrolls.$post({
        json: payrollCreateInput(input) as never}),
    )) as unknown as Row
  },
  async update(id, input) {
    return (await apiData(
      api.hr.payrolls[':id'].$patch({
        param: { id },
        json: decimalWireInput(input, payrollDecimals) as never}),
    )) as unknown as Row
  },
  async delete(id) {
    await apiData(
      api.hr.payrolls[':id'].$delete({
        param: { id }}),
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
    api.hr.payrolls[':id'].refresh.$post({
      param: { id }}),
  )
}

export function generatePayrolls(
  month: string,
): Promise<PayrollGenerationResult> {
  return apiData(
    api.hr.payrolls.generate.$post({
      json: { month },
    }),
  )
}

export function fetchPayrollMonthStats(
  month: string,
): Promise<PayrollMonthStats> {
  return apiData(
    api.hr.payrolls['month-stats'].$get({
      query: { month },
    }),
  )
}

export const payrollPaymentClient = resourceClient('hrPayrollPayments', {
  async query(input) {
    const result = await apiData(
      api.hr['payroll-payments'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      api.hr['payroll-payments'][':id'].$get({
        param: { id }}),
    )) as unknown as Row
  },
  async create(input) {
    return (await apiData(
      api.hr['payroll-payments'].$post({
        json: decimalWireInput(input, ['amount']) as never as unknown as never}),
    )) as unknown as Row
  },
  async delete(id) {
    await apiData(
      api.hr['payroll-payments'][':id'].$delete({
        param: { id }}),
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
): Promise<PayrollGenerationResult> {
  return apiData(
    api.hr['payroll-payments']['pay-remaining'].$post({
      json: { payrollId, paidOn, remarks }}),
  )
}

export const employeeLoanClient = resourceClient('hrEmployeeLoans', {
  async query(input) {
    const result = await apiData(
      api.hr['employee-loans'].query.$post({
        json: resourceListBody(input, listWireOptions)}),
    )
    return {
      count: result.count,
      results: result.results as unknown as Row[],
    }
  },
  async get(id) {
    return (await apiData(
      api.hr['employee-loans'][':id'].$get({
        param: { id }}),
    )) as unknown as Row
  },
  async create(input) {
    return (await apiData(
      api.hr['employee-loans'].$post({
        json: decimalWireInput(input, ['amount']) as never as unknown as never}),
    )) as unknown as Row
  },
  async update(id, input) {
    return (await apiData(
      api.hr['employee-loans'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['amount']) as never}),
    )) as unknown as Row
  },
  async delete(id) {
    await apiData(
      api.hr['employee-loans'][':id'].$delete({
        param: { id }}),
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
  return apiData(api.hr['employee-loans'].balances.$get())
}
