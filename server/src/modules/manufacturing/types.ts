/** 制造域类型：DB 存小写状态/履约方式，wire 见 wire.ts 转大写 */

export type DemandStatus = 'draft' | 'confirmed' | 'closed' | 'voided'
export type DemandItemStatus = 'pending' | 'scheduled' | 'completed'
export type FulfillmentMethod = 'make' | 'buy' | 'outsource' | 'stock'
export type WorkOrderStatus = 'in_progress' | 'completed' | 'voided'
export type OutputStatus = 'draft' | 'audited' | 'voided'

export interface Operation {
  id: string
  code: string
  name: string
  note: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface ProcessTemplate {
  id: string
  code: string
  name: string
  note: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface TemplateItem {
  id: string
  seq: number
  requirement: string | null
  isOutsourced: boolean
  templateId: string
  operationId: string
  insertedAt: Date
  updatedAt: Date
}

export interface Bom {
  id: string
  code: string
  planName: string | null
  note: string | null
  materialId: string
  insertedAt: Date
  updatedAt: Date
}

export interface BomComponent {
  id: string
  quantity: string
  lossRate: string | null
  note: string | null
  bomId: string
  materialId: string
  unitId: string
  insertedAt: Date
  updatedAt: Date
}

export interface BomRoute {
  id: string
  seq: number
  requirement: string | null
  isOutsourced: boolean
  bomId: string
  operationId: string
  insertedAt: Date
  updatedAt: Date
}

export interface BomByproduct {
  id: string
  quantity: string
  note: string | null
  bomId: string
  materialId: string
  unitId: string
  insertedAt: Date
  updatedAt: Date
}

export interface Demand {
  id: string
  demandNo: string
  demandDate: string
  remarks: string | null
  status: DemandStatus
  companyId: string
  createdById: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface DemandItem {
  id: string
  demandId: string
  companyId: string
  idx: number
  materialId: string
  unitId: string
  qty: string
  baseQty: string
  orderedQty: string
  receivedQty: string
  needDate: string | null
  fulfillmentMethod: FulfillmentMethod
  status: DemandItemStatus
  salesOrderItemId: string | null
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  remarks: string | null
  ordered: boolean
  remainingOrderableQty: string
  insertedAt: Date
  updatedAt: Date
}

export interface WorkOrder {
  id: string
  workOrderNo: string
  qty: string
  baseQty: string
  receivedBaseQty: string
  remainingBaseQty: string
  needDate: string | null
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  status: WorkOrderStatus
  companyId: string
  demandId: string
  demandItemId: string
  materialId: string
  unitId: string
  createdById: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface Output {
  id: string
  outputNo: string
  outputDate: string
  remarks: string | null
  status: OutputStatus
  auditedAt: Date | null
  companyId: string
  warehouseId: string | null
  createdById: string | null
  auditedById: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface OutputItem {
  id: string
  outputId: string
  companyId: string
  idx: number
  workOrderId: string
  materialId: string
  unitId: string
  warehouseId: string
  qty: string
  baseQty: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
}

export interface SalesOccupancy {
  salesOrderItemId: string
  orderedBaseQty: string
  occupiedBaseQty: string
  remainingBaseQty: string
}

import type { ListQuery } from '@synie/shared'

export type ListQueryInput = Partial<ListQuery> & {
  companyId?: string
}
