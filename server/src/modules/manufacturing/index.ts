import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createDemandService } from './demand-service.ts'
import { adjustDemandOrdered, adjustDemandReceived } from './helpers.ts'
import { createMasterService } from './master-service.ts'
import { allManufacturingResourceMetas } from './meta.ts'
import { createMoldDesignService } from './mold-design-service.ts'
import { createOutputService } from './output-service.ts'
import { createWorkOrderService } from './work-order-service.ts'
import { registerManufacturingSettingResources } from './settings.ts'

export { manufacturingRoutes, type ManufacturingRouteDeps } from './routes.ts'
export { allManufacturingResourceMetas } from './meta.ts'
export {
  createWorkOrderDocBuilder,
  registerWorkOrderDocBuilder,
} from './work-order-docbuilder.ts'
export { adjustDemandOrdered, adjustDemandReceived }
export {
  createManufacturingSettingService,
  manufacturingSettingResourceMeta,
  registerManufacturingSettingResources,
  type ManufacturingSettingService,
  type ManufacturingSetting,
  type ManufacturingUpdate,
  MFG_RESOURCE_NAME,
} from './settings.ts'

export function registerManufacturingResources(registry: Registry): void {
  for (const meta of allManufacturingResourceMetas()) {
    registry.register(meta)
  }
  registerManufacturingSettingResources(registry)
}

export function createManufacturingServices(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const inventory = createInventoryEngine()
  const master = createMasterService(db, numbering)
  const demands = createDemandService(db, numbering, registry)
  const workOrders = createWorkOrderService(db, numbering, registry)
  const outputs = createOutputService(db, numbering, inventory, registry)
  const moldDesigns = createMoldDesignService(db, numbering)
  return { master, demands, workOrders, outputs, moldDesigns }
}

export type ManufacturingServices = ReturnType<typeof createManufacturingServices>
