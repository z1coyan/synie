import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createEntryService } from './entry-service.ts'
import { createJournalService, type JournalServiceDeps } from './journal-service.ts'
import { allAccountingResourceMetas } from './meta.ts'

export {
  createJournalService,
  JOURNAL_LINE_RESOURCE_NAME,
  JOURNAL_RESOURCE_NAME,
  type JournalService,
  type JournalServiceDeps,
  type CreateAndAuditJournalInput,
  type CreateAndAuditLineInput,
} from './journal-service.ts'
export {
  createEntryService,
  GL_ENTRY_RESOURCE_NAME,
  type EntryService,
} from './entry-service.ts'
export { accountingRoutes } from './routes.ts'
export { allAccountingResourceMetas } from './meta.ts'
export {
  AR_AP_RESOURCE_NAME,
  AR_AP_PERMISSION_PREFIX,
} from './meta.ts'
export { createArApDocBuilder, registerArApDocBuilder } from './docbuilder.ts'

export function registerAccountingResources(registry: Registry): void {
  for (const meta of allAccountingResourceMetas()) {
    registry.register(meta)
  }
}

export function createAccountingServices(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
  deps: JournalServiceDeps = {},
) {
  const gl = createGlEngine()
  return {
    journals: createJournalService(db, numbering, gl, registry, deps),
    entries: createEntryService(db, registry),
  }
}
