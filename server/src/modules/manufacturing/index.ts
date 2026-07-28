import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createDemandService } from './demand-service.ts'
import { adjustDemandOrdered, adjustDemandReceived } from './helpers.ts'
import { createMasterService } from './master-service.ts'
import { allManufacturingResourceMetas } from './meta.ts'
import { createOutputService } from './output-service.ts'
import { createWorkOrderService } from './work-order-service.ts'

export { manufacturingRoutes, type ManufacturingRouteDeps } from './routes.ts'
export { allManufacturingResourceMetas } from './meta.ts'
export { adjustDemandOrdered, adjustDemandReceived }

export function registerManufacturingResources(registry: Registry): void {
  for (const meta of allManufacturingResourceMetas()) {
    registry.register(meta)
  }
}

export function createManufacturingServices(
  db: Kysely<Database>,
  numbering: NumberingService,
) {
  const inventory = createInventoryEngine()
  const master = createMasterService(db, numbering)
  const demands = createDemandService(db, numbering)
  const workOrders = createWorkOrderService(db, numbering)
  const outputs = createOutputService(db, numbering, inventory)
  return { master, demands, workOrders, outputs }
}

export type ManufacturingServices = ReturnType<typeof createManufacturingServices>
