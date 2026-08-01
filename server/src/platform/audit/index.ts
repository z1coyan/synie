import type { Registry } from '../meta/registry.ts'
import { auditLogResourceMeta } from './meta.ts'

export { writeAudit, auditDiff, auditCreated, auditDestroyed, filterSensitive, FILTERED_PLACEHOLDER } from './write.ts'
export { createAuditService, type AuditService } from './service.ts'
export { auditRoutes } from './routes.ts'
export { auditLogResourceMeta } from './meta.ts'

export function registerAuditResources(registry: Registry): void {
  registry.register(auditLogResourceMeta())
}
