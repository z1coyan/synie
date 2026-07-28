import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import type { FileService } from '~/platform/files/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { EmployeeService } from '~/modules/party/party-service.ts'
import { allHrResourceMetas } from './meta.ts'
import { createHrService } from './service.ts'

export { createHrService, type HrService } from './service.ts'
export {
  attendancePunchRoutes,
  attendanceImportRoutes,
  attendanceDayRoutes,
  attendanceCorrectionRoutes,
  payrollRoutes,
  payrollPaymentRoutes,
  employeeLoanRoutes,
} from './routes.ts'
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
    hr: createHrService({
      db,
      files,
      employeeSeam: deps.employees,
    }),
  }
}
