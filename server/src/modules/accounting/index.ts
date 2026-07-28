import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createEntryService } from './entry-service.ts'
import { createJournalService } from './journal-service.ts'
import { allAccountingResourceMetas } from './meta.ts'

export {
  createJournalService,
  type JournalService,
  type CreateAndAuditJournalInput,
  type CreateAndAuditLineInput,
} from './journal-service.ts'
export { createEntryService, type EntryService } from './entry-service.ts'
export { accountingRoutes } from './routes.ts'
export { allAccountingResourceMetas } from './meta.ts'

export function registerAccountingResources(registry: Registry): void {
  for (const meta of allAccountingResourceMetas()) {
    registry.register(meta)
  }
}

export function createAccountingServices(db: Kysely<Database>, numbering: NumberingService) {
  const gl = createGlEngine()
  return {
    journals: createJournalService(db, numbering, gl),
    entries: createEntryService(db),
  }
}
