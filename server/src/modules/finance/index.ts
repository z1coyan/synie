/**
 * 财务单据模块（工单 09：增值税发票；报销/票据见工单 12）。
 */
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import type { FileService } from '~/platform/files/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { ReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import { createVatInvoiceService } from './invoice-service.ts'
import { allFinanceResourceMetas } from './meta.ts'

export { createVatInvoiceService, type VatInvoiceService } from './invoice-service.ts'
export { vatInvoiceRoutes } from './routes.ts'
export { allFinanceResourceMetas, vatInvoiceResourceMeta } from './meta.ts'

export function registerFinanceResources(registry: Registry): void {
  for (const meta of allFinanceResourceMetas()) {
    registry.register(meta)
  }
}

export function createFinanceServices(
  db: Kysely<Database>,
  numbering: NumberingService,
  deps: {
    reconciliations: Pick<ReconciliationService, 'closeFromInvoice' | 'reopenFromInvoice'>
    files?: Pick<FileService, 'readStoredFile'> | null
  },
) {
  const gl = createGlEngine()
  return {
    invoices: createVatInvoiceService(db, numbering, {
      gl,
      reconciliations: deps.reconciliations,
      files: deps.files ?? null,
    }),
  }
}

export type FinanceServices = ReturnType<typeof createFinanceServices>
