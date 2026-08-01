import {
  unboundCommandAdapter,
  unboundResourceClient,
  unavailableResourceOperation,
} from './unbound'

export interface WorkOrderInlineBomInput {
  code?: string | null
  planName?: string | null
  note?: string | null
  components?: Array<{
    materialId: string
    unitId: string
    quantity: string
    lossRate?: string | null
    note?: string | null
  }>
  routes?: Array<{
    operationId: string
    seq: number
    requirement?: string | null
    isOutsourced?: boolean
  }>
  byproducts?: Array<{
    materialId: string
    unitId: string
    quantity: string
    note?: string | null
  }>
}

export interface ManufacturingSemanticOperations {
  applyRouteTemplate(id: string, templateId: string): Promise<unknown>
  applyWorkOrderBom(id: string, bomId: string | null): Promise<unknown>
  getWorkOrderBomSnapshot(id: string): Promise<unknown>
  createWorkOrderInlineBom(id: string, input: WorkOrderInlineBomInput): Promise<unknown>
  salesItemCandidates(companyId: string): Promise<unknown>
  salesItemOccupancies(ids: string[]): Promise<unknown>
}

let semanticOperations: ManufacturingSemanticOperations | null = null

export function activateManufacturingSemanticOperations(
  operations: ManufacturingSemanticOperations,
): void {
  semanticOperations = operations
}

function manufacturing(): ManufacturingSemanticOperations {
  if (!semanticOperations) {
    throw new Error('制造能力尚未由 Convex 应用壳装配')
  }
  return semanticOperations
}

export const applyRouteTemplate = (id: string, templateId: string) =>
  manufacturing().applyRouteTemplate(id, templateId)
export const applyWorkOrderBom = (id: string, bomId: string | null) =>
  manufacturing().applyWorkOrderBom(id, bomId)
export const getWorkOrderBomSnapshot = (id: string) =>
  manufacturing().getWorkOrderBomSnapshot(id)
export const createWorkOrderInlineBom = (
  id: string,
  input: WorkOrderInlineBomInput,
) => manufacturing().createWorkOrderInlineBom(id, input)
export const getSalesItemCandidates = (companyId: string) =>
  manufacturing().salesItemCandidates(companyId)
export const getSalesItemOccupancies = (ids: string[]) =>
  manufacturing().salesItemOccupancies(ids)

export const operationClient = unboundResourceClient('mfgOperations')
export const processTemplateClient = unboundResourceClient('mfgProcessTemplates')
export const processTemplateItemClient = unboundResourceClient('mfgProcessTemplateItems')
export const bomClient = unboundResourceClient('mfgBoms')
export const bomComponentClient = unboundResourceClient('mfgBomComponents')
export const bomRouteClient = unboundResourceClient('mfgBomRoutes')
export const bomByproductClient = unboundResourceClient('mfgBomByproducts')
export const demandClient = unboundResourceClient('mfgDemands')
export const demandItemClient = unboundResourceClient('mfgDemandItems')
export const workOrderClient = unboundResourceClient('mfgWorkOrders')
export const outputClient = unboundResourceClient('mfgOutputs')
export const outputItemClient = unboundResourceClient('mfgOutputItems')

export const demandCommandAdapter = unboundCommandAdapter({
  audit: 'row',
  close: 'row',
  void: 'row',
})
export const workOrderCommandAdapter = unboundCommandAdapter({
  void: {
    target: 'row',
    affectedResources: ['mfgDemandItems', 'mfgDemands'],
  },
})
export const outputCommandAdapter = unboundCommandAdapter({
  audit: {
    target: 'row',
    affectedResources: [
      'mfgOutputItems',
      'mfgWorkOrders',
      'mfgDemandItems',
      'mfgDemands',
      'invStockEntries',
    ],
  },
  void: {
    target: 'row',
    affectedResources: [
      'mfgOutputItems',
      'mfgWorkOrders',
      'mfgDemandItems',
      'mfgDemands',
      'invStockEntries',
    ],
  },
})
export const bomCommandAdapter = unboundCommandAdapter({
  activate: 'row',
  deactivate: 'row',
})

// 旧路由仍有类型导入的符号；生产执行一律由 registry 中的 Convex command 接管。
export const activateBom = unavailableResourceOperation
export const deactivateBom = unavailableResourceOperation
export const confirmDemand = unavailableResourceOperation
export const closeDemand = unavailableResourceOperation
export const voidDemand = unavailableResourceOperation
export const completeDemandItem = unavailableResourceOperation
export const changeDemandItemFulfillment = unavailableResourceOperation
export const voidWorkOrder = unavailableResourceOperation
export const auditOutput = unavailableResourceOperation
export const voidOutput = unavailableResourceOperation
