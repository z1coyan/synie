import type { Kysely } from 'kysely'
import { createInventoryEngine } from '~/engines/inventory/index.ts'
import type { DB as Database } from '~/db/types.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createMaterialCategoryService } from './category-service.ts'
import { createMaterialService } from './material-service.ts'
import { createMaterialUnitService } from './material-unit-service.ts'
import { allInventoryResourceMetas } from './meta.ts'
import { inventoryRoutes } from './routes.ts'
import { createStockCountService } from './stock-count-service.ts'
import { createStockDocService } from './stock-doc-service.ts'
import { createStockEntryService } from './stock-entry-service.ts'
import { createStockTransferService } from './stock-transfer-service.ts'
import { createWarehouseService } from './warehouse-service.ts'

export { inventoryRoutes } from './routes.ts'
export { inventoryMasterRoutes } from './master-routes.ts'
export { allInventoryResourceMetas } from './meta.ts'
export type { MaterialCategoryService } from './category-service.ts'
export type { MaterialService } from './material-service.ts'
export type { MaterialUnitService } from './material-unit-service.ts'
export type { WarehouseService } from './warehouse-service.ts'
export type { StockDocService } from './stock-doc-service.ts'
export type { StockTransferService } from './stock-transfer-service.ts'
export type { StockCountService } from './stock-count-service.ts'
export type { StockEntryService } from './stock-entry-service.ts'

export function registerInventoryResources(registry: Registry): void {
  for (const meta of allInventoryResourceMetas()) {
    registry.register(meta)
  }
}

/** 装配库存域全部服务（主数据 + 单据 + 分录/余额） */
export function createInventoryServices(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const inventory = createInventoryEngine()
  return {
    inventory,
    categories: createMaterialCategoryService(db, registry),
    materials: createMaterialService(db, numbering, registry),
    materialUnits: createMaterialUnitService(db, registry),
    warehouses: createWarehouseService(db, numbering, registry),
    stockDocs: createStockDocService(db, numbering, inventory, registry),
    stockTransfers: createStockTransferService(db, numbering, inventory, registry),
    stockCounts: createStockCountService(db, numbering, inventory, registry),
    stockEntries: createStockEntryService(db, inventory, registry),
  }
}

export type InventoryServices = ReturnType<typeof createInventoryServices>
