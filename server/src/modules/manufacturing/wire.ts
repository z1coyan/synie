import type {
  Bom,
  BomByproduct,
  BomComponent,
  BomRoute,
  Demand,
  DemandItem,
  Operation,
  Output,
  OutputItem,
  ProcessTemplate,
  SalesOccupancy,
  TemplateItem,
  WorkOrder,
} from './types.ts'

function upper(s: string): string {
  return s.toUpperCase()
}

export function operationWire(item: Operation) {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    note: item.note,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function templateWire(item: ProcessTemplate) {
  return operationWire(item)
}

export function templateItemWire(item: TemplateItem) {
  return {
    id: item.id,
    seq: item.seq,
    requirement: item.requirement,
    isOutsourced: item.isOutsourced,
    templateId: item.templateId,
    operationId: item.operationId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function bomWire(item: Bom) {
  return {
    id: item.id,
    code: item.code,
    planName: item.planName,
    note: item.note,
    materialId: item.materialId,
    status: upper(item.status),
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function bomComponentWire(item: BomComponent) {
  return {
    id: item.id,
    quantity: item.quantity,
    lossRate: item.lossRate,
    note: item.note,
    bomId: item.bomId,
    materialId: item.materialId,
    unitId: item.unitId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function bomRouteWire(item: BomRoute) {
  return {
    id: item.id,
    seq: item.seq,
    requirement: item.requirement,
    isOutsourced: item.isOutsourced,
    bomId: item.bomId,
    operationId: item.operationId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function bomByproductWire(item: BomByproduct) {
  return {
    id: item.id,
    quantity: item.quantity,
    note: item.note,
    bomId: item.bomId,
    materialId: item.materialId,
    unitId: item.unitId,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function demandWire(item: Demand) {
  return {
    id: item.id,
    demandNo: item.demandNo,
    demandDate: item.demandDate,
    remarks: item.remarks,
    status: upper(item.status),
    companyId: item.companyId,
    createdById: item.createdById,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function demandItemWire(item: DemandItem) {
  return {
    id: item.id,
    demandId: item.demandId,
    companyId: item.companyId,
    idx: item.idx,
    materialId: item.materialId,
    unitId: item.unitId,
    qty: item.qty,
    baseQty: item.baseQty,
    orderedQty: item.orderedQty,
    receivedQty: item.receivedQty,
    arrangedQty: item.arrangedQty,
    completedQty: item.completedQty,
    remainingArrangeableQty: item.remainingArrangeableQty,
    needDate: item.needDate,
    fulfillmentMethod: item.fulfillmentMethod ? upper(item.fulfillmentMethod) : null,
    status: upper(item.status),
    salesOrderItemId: item.salesOrderItemId,
    materialCode: item.materialCode,
    materialName: item.materialName,
    materialSpec: item.materialSpec,
    unitName: item.unitName,
    remarks: item.remarks,
    ordered: item.ordered,
    remainingOrderableQty: item.remainingOrderableQty,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function workOrderWire(item: WorkOrder) {
  return {
    id: item.id,
    workOrderNo: item.workOrderNo,
    qty: item.qty,
    baseQty: item.baseQty,
    receivedBaseQty: item.receivedBaseQty,
    remainingBaseQty: item.remainingBaseQty,
    needDate: item.needDate,
    materialCode: item.materialCode,
    materialName: item.materialName,
    materialSpec: item.materialSpec,
    unitName: item.unitName,
    status: upper(item.status),
    companyId: item.companyId,
    demandId: item.demandId,
    demandItemId: item.demandItemId,
    materialId: item.materialId,
    unitId: item.unitId,
    bomId: item.bomId,
    createdById: item.createdById,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function outputWire(item: Output) {
  return {
    id: item.id,
    outputNo: item.outputNo,
    outputDate: item.outputDate,
    remarks: item.remarks,
    status: upper(item.status),
    auditedAt: item.auditedAt?.toISOString() ?? null,
    companyId: item.companyId,
    warehouseId: item.warehouseId,
    createdById: item.createdById,
    auditedById: item.auditedById,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function outputItemWire(item: OutputItem) {
  return {
    id: item.id,
    outputId: item.outputId,
    companyId: item.companyId,
    idx: item.idx,
    workOrderId: item.workOrderId,
    materialId: item.materialId,
    unitId: item.unitId,
    warehouseId: item.warehouseId,
    qty: item.qty,
    baseQty: item.baseQty,
    materialCode: item.materialCode,
    materialName: item.materialName,
    materialSpec: item.materialSpec,
    unitName: item.unitName,
    remarks: item.remarks,
    insertedAt: item.insertedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }
}

export function occupancyWire(item: SalesOccupancy) {
  return {
    salesOrderItemId: item.salesOrderItemId,
    orderedBaseQty: item.orderedBaseQty,
    occupiedBaseQty: item.occupiedBaseQty,
    remainingBaseQty: item.remainingBaseQty,
  }
}

export function listWire<T, W>(
  result: { count: number; results: T[] },
  map: (item: T) => W,
): { count: number; results: W[] } {
  return { count: result.count, results: result.results.map(map) }
}
