import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  decodeCollectionTarget,
  defineCommand,
} from './catalog/commands'
import { restTransport } from './rest-transport'
import { encodeResourceWrite } from './resource-wire'
import type { ResourceClient } from './types'

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

export const attendancePunchClient = restTransport(
  'hrAttendancePunches',
  api.hr['attendance-punches'],
  {
    capabilities: { create: false, update: false, delete: false },
    listOptions: listWireOptions,
  },
)

export const attendanceImportClient = restTransport(
  'hrAttendanceImports',
  api.hr['attendance-imports'],
  {
    capabilities: { update: false },
    listOptions: listWireOptions,
  },
)

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

export const attendanceDayClient = restTransport(
  'hrAttendanceDays',
  api.hr['attendance-days'],
  {
    capabilities: { create: false, update: false, delete: false },
    listOptions: listWireOptions,
  },
)

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

export const attendanceCorrectionClient = restTransport(
  'hrAttendanceCorrections',
  api.hr['attendance-corrections'],
  { listOptions: listWireOptions },
)

export async function saveAttendanceCorrection(
  id: string | null,
  input: Record<string, unknown>,
) {
  return id
    ? attendanceCorrectionClient.update(id, input)
    : attendanceCorrectionClient.create(input)
}

/** 创建时的零值回填面（领域口径：未填即 0）；wire 编码本身由资源事实清单派生 */
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
): Record<string, unknown> {
  const result = encodeResourceWrite('hrPayrolls', input)
  for (const field of payrollDecimals) {
    if (result[field] == null) result[field] = '0'
  }
  for (const field of ['attendanceDays', 'missingDays'] as const) {
    if (result[field] == null || result[field] === '') result[field] = 0
  }
  return result
}

const payrollTransport = restTransport('hrPayrolls', api.hr.payrolls, {
  listOptions: listWireOptions,
})

export const payrollClient: ResourceClient = {
  ...payrollTransport,
  // 偏离标准形状：create 对 decimal 字段做零值回填并对天数列兜底 0。
  async create(input) {
    return (await apiData(
      api.hr.payrolls.$post({
        json: payrollCreateInput(input) as never}),
    )) as unknown as Row
  },
}

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

export const payrollPaymentClient = restTransport(
  'hrPayrollPayments',
  api.hr['payroll-payments'],
  {
    capabilities: { update: false },
    listOptions: listWireOptions,
  },
)

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

export const employeeLoanClient = restTransport(
  'hrEmployeeLoans',
  api.hr['employee-loans'],
  { listOptions: listWireOptions },
)

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
