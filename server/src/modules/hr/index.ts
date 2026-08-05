import type { Kysely } from 'kysely'
import type { AuthzEnforcer } from '~/platform/authz/enforce.ts'
import type { DB as Database } from '~/db/types.ts'
import type { FileService } from '~/platform/files/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { EmployeeService } from '~/modules/party/party-service.ts'
import { allHrResourceMetas } from './meta.ts'
import { createAttendanceService } from './attendance-service.ts'
import { createPayrollService } from './payroll-service.ts'

export {
  createAttendanceService,
  ATTENDANCE_CORRECTION_RESOURCE,
  ATTENDANCE_DAY_RESOURCE,
  ATTENDANCE_IMPORT_RESOURCE,
  ATTENDANCE_PUNCH_RESOURCE,
  type AttendanceService,
  type AttendanceServiceDeps,
} from './attendance-service.ts'
export {
  createPayrollService,
  EMPLOYEE_LOAN_RESOURCE,
  PAYROLL_PAYMENT_RESOURCE,
  PAYROLL_RESOURCE,
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
    /** 考勤导入自动建档的分支内二次授权 */
    authz: AuthzEnforcer
    /** 判定归宿解析（三个执行点共用） */
    registry: Registry
  },
) {
  return {
    attendance: createAttendanceService({
      db,
      files,
      employeeSeam: deps.employees,
      authz: deps.authz,
      registry: deps.registry,
    }),
    payroll: createPayrollService({ db, registry: deps.registry }),
  }
}

export type HrServices = ReturnType<typeof createHrServices>
/** @deprecated 使用 AttendanceService | PayrollService；兼容旧装配名 */
export type HrService = HrServices['attendance'] & HrServices['payroll']
