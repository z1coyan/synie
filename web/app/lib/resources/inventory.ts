import type { Row } from '~/components/synie-data-grid/types'
import { unboundCommandAdapter, unboundResourceClient, unavailableResourceOperation } from './unbound'

export interface InventorySemanticOperations {
  stockBalance(input: Record<string, unknown>): Promise<{ count: number; results: Row[] }>
  refreshStockCount(id: string): Promise<Row>
  outsourcedWarehouses(partyType: 'SUPPLIER' | 'COMPANY', partyId: string): Promise<Row[]>
}

let semanticOperations: InventorySemanticOperations | null = null
export function activateInventorySemanticOperations(next: InventorySemanticOperations): void {
  semanticOperations = next
}
function inventory(): InventorySemanticOperations {
  if (!semanticOperations) throw new Error('库存能力尚未由 Convex 应用壳装配')
  return semanticOperations
}

export const materialCategoryClient = unboundResourceClient('invMaterialCategories')
export const materialClient = unboundResourceClient('invMaterials')
export const materialUnitClient = unboundResourceClient('invMaterialUnits')
export const warehouseClient = unboundResourceClient('invWarehouses')
export const stockEntryClient = unboundResourceClient('invStockEntries')
export const stockDocClient = unboundResourceClient('invStockDocs')
export const stockDocItemClient = unboundResourceClient('invStockDocItems')
export const stockTransferClient = unboundResourceClient('invStockTransfers')
export const stockTransferItemClient = unboundResourceClient('invStockTransferItems')
export const stockCountClient = unboundResourceClient('invStockCounts')
export const stockCountItemClient = unboundResourceClient('invStockCountItems')

export const stockDocCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: ['invStockEntries'] },
  void: { target: 'row', affectedResources: ['invStockEntries'] },
})
export const stockTransferCommandAdapter = unboundCommandAdapter({
  ship: { target: 'row', affectedResources: ['invStockTransferItems', 'invStockEntries'] },
  receive: { target: 'row', affectedResources: ['invStockTransferItems', 'invStockEntries'] },
})
export const stockCountCommandAdapter = unboundCommandAdapter({
  approve: { target: 'row', affectedResources: ['invStockEntries'] },
  cancel: { target: 'row', affectedResources: ['invStockEntries'] },
})

export const queryStockBalance = (input: Record<string, unknown>) => inventory().stockBalance(input)
export const refreshStockCount = (id: string) => inventory().refreshStockCount(id)
export const seedWarehouseDefaults = unavailableResourceOperation
export const queryOutsourcedWarehouses = (
  partyType: 'SUPPLIER' | 'COMPANY',
  partyId: string,
) => inventory().outsourcedWarehouses(partyType, partyId)
