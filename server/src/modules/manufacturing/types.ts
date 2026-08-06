/** 制造域类型：DB 存小写状态/履约方式，wire 见 wire.ts 转大写 */

export type DemandStatus = 'draft' | 'confirmed' | 'closed' | 'voided'
export type DemandItemStatus = 'pending' | 'scheduled' | 'completed'
/** @deprecated 行级履约方式已取消；存量只读兼容 */
export type FulfillmentMethod = 'make' | 'buy' | 'outsource' | 'stock'
export type WorkOrderStatus = 'in_progress' | 'completed' | 'voided'
export type OutputStatus = 'draft' | 'audited' | 'voided'
export type BomStatus = 'draft' | 'active' | 'inactive'
export type ArrangementType = 'make' | 'purchase' | 'outsource' | 'stock' | 'close'

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
  status: BomStatus
  insertedAt: Date
  updatedAt: Date
}

export interface DemandArrangement {
  id: string
  demandItemId: string
  companyId: string
  arrangementType: ArrangementType
  qty: string
  baseQty: string
  workOrderId: string | null
  purchaseOrderItemId: string | null
  remarks: string | null
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
  /** 下发车间（指派部门）：草稿态随表单改，已确认后走 dispatch 动作 */
  assignedDeptId: string | null
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
  arrangedQty: string
  completedQty: string
  remainingArrangeableQty: string
  needDate: string | null
  /** 存量兼容；新行为空 */
  fulfillmentMethod: FulfillmentMethod | null
  status: DemandItemStatus
  salesOrderItemId: string | null
  /** 来源生产工单（物料需求派生写入）：与销售来源互斥，派生行不占销售占用 */
  sourceWorkOrderId: string | null
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
  bomId: string | null
  createdById: string | null
  /** 归属部门：创建时按创建人部门盖章，无部门用户创建即 null */
  ownerDeptId: string | null
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
  /** 列表 join 母单投影；单条 create/update 响应可空 */
  outputNo: string | null
  outputDate: string | null
  outputStatus: OutputStatus | null
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
