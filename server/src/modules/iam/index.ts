import type { Registry } from '~/platform/meta/registry.ts'
import { allIamResourceMetas } from './meta.ts'

export { createIamService, type IamService } from './service.ts'
export { iamUserRoutes, iamRoleRoutes } from './routes.ts'
export { allIamResourceMetas, userResourceMeta, roleResourceMeta } from './meta.ts'

export function registerIamResources(registry: Registry): void {
  for (const meta of allIamResourceMetas()) {
    registry.register(meta)
  }
}
