import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { FileService } from '~/platform/files/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { EmployeeService } from '~/modules/party/party-service.ts'
import { allHrResourceMetas } from './meta.ts'
import { createAttendanceService } from './attendance-service.ts'
import { createPayrollService } from './payroll-service.ts'

export {
  createAttendanceService,
  type AttendanceService,
  type AttendanceServiceDeps,
} from './attendance-service.ts'
export {
  createPayrollService,
  type PayrollService,
  type PayrollServiceDeps,
} from './payroll-service.ts'
export type {
  AttendanceCorrection,
  AttendanceDay,
  AttendanceImport,
  AttendanceMonthSummary,
  AttendancePunch,
  EmployeeLoan,
  EmployeeLoanBalance,
  Payroll,
  PayrollInput,
  PayrollPayment,
} from './types.ts'
export {
  attendancePunchRoutes,
  attendanceImportRoutes,
  attendanceDayRoutes,
  attendanceCorrectionRoutes,
  payrollRoutes,
  payrollPaymentRoutes,
  employeeLoanRoutes,
} from './routes.ts'
export { HR_ATTENDANCE_DAY, type HrAttendanceDayPermission } from './permissions.ts'
export { allHrResourceMetas } from './meta.ts'
export {
  parseAttendanceFile,
  computeAttendanceDay,
  unmatchedDetail,
} from './rules.ts'

export function registerHrResources(registry: Registry): void {
  for (const meta of allHrResourceMetas()) {
    registry.register(meta)
  }
}

export function createHrServices(
  db: Kysely<Database>,
  files: FileService,
  deps: {
    employees: Pick<EmployeeService, 'autoCreateForAttendance'>
  },
) {
  return {
    attendance: createAttendanceService({
      db,
      files,
      employeeSeam: deps.employees,
    }),
    payroll: createPayrollService({ db }),
  }
}

export type HrServices = ReturnType<typeof createHrServices>
/** @deprecated 使用 AttendanceService | PayrollService；兼容旧装配名 */
export type HrService = HrServices['attendance'] & HrServices['payroll']
