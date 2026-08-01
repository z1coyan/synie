import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  decodeCollectionTarget,
  defineCommand,
} from './catalog/commands'
import { unboundResourceClient } from './unbound'

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

export interface HrSemanticOperations {
  createAttendanceImport(fileId: string): Promise<AttendanceImportRow>
  commitAttendanceImport(id: string, autoCreateEmployees: boolean): Promise<AttendanceImportExecution>
  removeAttendanceImport(id: string): Promise<void>
  recalcAttendanceDays(dateFrom: string, dateTo: string): Promise<number>
  fetchAttendanceMonthSummary(month: string): Promise<AttendanceMonthSummary[]>
  refreshPayroll(id: string): Promise<Row>
  generatePayrolls(month: string): Promise<PayrollGenerationResult>
  fetchPayrollMonthStats(month: string): Promise<PayrollMonthStats>
  payRemainingPayroll(payrollId: string, paidOn: string, remarks?: string): Promise<PayrollGenerationResult>
  fetchEmployeeLoanBalances(): Promise<EmployeeLoanBalance[]>
}

let semanticOperations: HrSemanticOperations | null = null

export function activateHrSemanticOperations(operations: HrSemanticOperations): void {
  semanticOperations = operations
}

function hr(): HrSemanticOperations {
  if (!semanticOperations) throw new Error('人力能力尚未由 Convex 应用壳装配')
  return semanticOperations
}

export const attendancePunchClient = unboundResourceClient('hrAttendancePunches')
export const attendanceImportClient = unboundResourceClient('hrAttendanceImports')
export const attendanceDayClient = unboundResourceClient('hrAttendanceDays')
export const attendanceCorrectionClient = unboundResourceClient('hrAttendanceCorrections')
export const payrollClient = unboundResourceClient('hrPayrolls')
export const payrollPaymentClient = unboundResourceClient('hrPayrollPayments')
export const employeeLoanClient = unboundResourceClient('hrEmployeeLoans')

export const createAttendanceImport = (fileId: string) =>
  hr().createAttendanceImport(fileId)
export const importAttendanceImport = (id: string, autoCreateEmployees: boolean) =>
  hr().commitAttendanceImport(id, autoCreateEmployees)
export const removeAttendanceImport = (id: string) =>
  hr().removeAttendanceImport(id)
export const recalcAttendanceDays = (dateFrom: string, dateTo: string) =>
  hr().recalcAttendanceDays(dateFrom, dateTo)
export const fetchAttendanceMonthSummary = (month: string) =>
  hr().fetchAttendanceMonthSummary(month)
export const refreshPayroll = (id: string) => hr().refreshPayroll(id)
export const generatePayrolls = (month: string) => hr().generatePayrolls(month)
export const fetchPayrollMonthStats = (month: string) =>
  hr().fetchPayrollMonthStats(month)
export const payRemainingPayroll = (
  payrollId: string,
  paidOn: string,
  remarks?: string,
) => hr().payRemainingPayroll(payrollId, paidOn, remarks)
export const fetchEmployeeLoanBalances = () => hr().fetchEmployeeLoanBalances()

export type AttendanceRecalcInput = { dateFrom: string; dateTo: string }

export const attendanceDayCommandAdapter = createCommandAdapter({
  recalc: defineCommand('collection', async (input: unknown) => {
    const payload = decodeCollectionTarget<AttendanceRecalcInput>(input)
    const { dateFrom, dateTo } = payload
    if (typeof dateFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      throw new Error('recalc 需要合法 dateFrom（YYYY-MM-DD）')
    }
    if (typeof dateTo !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      throw new Error('recalc 需要合法 dateTo（YYYY-MM-DD）')
    }
    return recalcAttendanceDays(dateFrom, dateTo)
  }),
})

export const saveAttendanceCorrection = (
  id: string | null,
  input: Record<string, unknown>,
) => id
  ? attendanceCorrectionClient.update(id, input)
  : attendanceCorrectionClient.create(input)

export const savePayroll = (
  id: string | null,
  input: Record<string, unknown>,
) => id ? payrollClient.update(id, input) : payrollClient.create(input)

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
  })
  return (result.results as PayrollPaymentRow[]).sort((left, right) =>
    left.paidOn.localeCompare(right.paidOn) || left.id.localeCompare(right.id))
}

export const createPayrollPayment = (input: Record<string, unknown>) =>
  payrollPaymentClient.create(input)
export const deletePayrollPayment = (id: string) => payrollPaymentClient.delete(id)

export const saveEmployeeLoan = (
  id: string | null,
  input: Record<string, unknown>,
) => id ? employeeLoanClient.update(id, input) : employeeLoanClient.create(input)
