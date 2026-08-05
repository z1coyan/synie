import type { Registry } from '~/platform/meta/registry.ts'
import { allIamResourceMetas } from './meta.ts'

export { createIamService, type IamService } from './service.ts'
export {
  createDepartmentService,
  type Department,
  type DepartmentService,
} from './department-service.ts'
export { iamUserRoutes, iamRoleRoutes, iamDepartmentRoutes } from './routes.ts'
export {
  allIamResourceMetas,
  departmentResourceMeta,
  userResourceMeta,
  roleResourceMeta,
  DEPARTMENT_RESOURCE,
} from './meta.ts'

export function registerIamResources(registry: Registry): void {
  for (const meta of allIamResourceMetas()) {
    registry.register(meta)
  }
}
