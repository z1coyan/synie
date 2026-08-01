/**
 * HR 领域 wire 类型（考勤 / 工资 / 借款）。
 */
export interface AttendancePunch {
  id: string
  attendanceNo: string
  punchedAt: Date
  insertedAt: Date
  employeeId: string
  importId: string
}

export interface AttendanceImport {
  id: string
  status: string
  error: string | null
  totalRows: number | null
  badRows: number | null
  dupRows: number | null
  matchedRows: number | null
  unmatchedRows: number | null
  unmatchedDetail: string | null
  importedCount: number | null
  skippedExistingRows: number | null
  skippedUnmatchedRows: number | null
  autoCreatedCount: number | null
  importedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  fileId: string
  createdById: string | null
  importedById: string | null
  punchCount: number
}

export interface AttendanceDay {
  id: string
  date: string
  morningIn: string | null
  morningOut: string | null
  afternoonIn: string | null
  afternoonOut: string | null
  normalHours: string
  overtimeHours: string
  bonusWorkday: string
  status: string
  insertedAt: Date
  updatedAt: Date
  employeeId: string
}

export interface AttendanceMonthSummary {
  employeeId: string
  employeeCode: string
  employeeName: string
  days: number
  missingDays: number
  normalHours: string
  overtimeHours: string
  bonusWorkdays: string
  workdays: string
}

export interface AttendanceCorrection {
  id: string
  date: string
  times: string[]
  note: string | null
  insertedAt: Date
  updatedAt: Date
  employeeId: string
  createdById: string | null
}

export interface Payroll {
  id: string
  month: string
  workdays: string
  attendanceDays: number
  missingDays: number
  overtimeHours: string
  dailyWage: string
  baseAmount: string
  allowance: string
  bonus: string
  fine: string
  loanDeduction: string
  payable: string
  status: string
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  employeeId: string
  paidTotal: string | null
}

export interface PayrollPayment {
  id: string
  month: string | null
  paidOn: string
  amount: string
  kind: string | null
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  payrollId: string
  employeeId: string | null
  createdById: string | null
}

export interface EmployeeLoan {
  id: string
  kind: string
  occurredOn: string
  amount: string
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  employeeId: string
  payrollId: string | null
  createdById: string | null
}

export interface EmployeeLoanBalance {
  employeeId: string
  employeeCode: string
  employeeName: string
  borrowed: string
  repaid: string
  balance: string
}

export interface PayrollInput {
  employeeId: string
  month: string
  workdays?: string
  attendanceDays?: number
  missingDays?: number
  overtimeHours?: string
  dailyWage?: string
  allowance?: string
  bonus?: string
  fine?: string
  loanDeduction?: string
  remarks?: string | null
}
