/** 制造域类型：DB 存小写状态/履约方式；Demand/DemandItem 已迁标准内核为 wire 形大写 */

/** 履约需求单已迁标准动作内核：wire 形枚举大写（库内仍小写） */
export type DemandStatus = 'DRAFT' | 'CONFIRMED' | 'CLOSED' | 'VOIDED'
export type DemandItemStatus = 'PENDING' | 'SCHEDULED' | 'COMPLETED'
/** 单头指派类型（纯路由声明）：采购/生产/库存/关闭；MAKE ⇔ 下发车间非空 */
export type DemandAssignType = 'PURCHASE' | 'MAKE' | 'STOCK' | 'CLOSE'
/** @deprecated 行级履约方式已取消；存量只读兼容（wire 大写） */
export type FulfillmentMethod = 'MAKE' | 'BUY' | 'OUTSOURCE' | 'STOCK'
export type WorkOrderStatus = 'in_progress' | 'completed' | 'voided'
/** 生产入库已迁标准动作内核：Output/OutputItem 是 wire 形（枚举大写，库内仍小写） */
export type OutputStatus = 'DRAFT' | 'AUDITED' | 'VOIDED'
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
  /** 指派类型（纯路由声明）：草稿保存即必填；MAKE 时下发车间必填，其余类型必须为空 */
  assignType: DemandAssignType
  /** 单头需求日：新增行的行需求日默认值；改单头不追溯既有行 */
  needDate: string | null
  remarks: string | null
  status: DemandStatus
  companyId: string
  /** 下发车间（指派部门）：草稿态随表单改，已确认后走 dispatch 动作 */
  assignedDeptId: string | null
  createdById: string | null
  insertedAt: Date
  updatedAt: Date
  /** 标准动作内核的 StandardItem 约束 */
  [key: string]: unknown
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
  /** 需求日：必填（草稿保存即校验） */
  needDate: string
  /** 存量兼容；新行为空 */
  fulfillmentMethod: FulfillmentMethod | null
  status: DemandItemStatus
  /** 来源销售订单条目：创建时定型，更新路径不可改 */
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
  /** 标准动作内核的 StandardItem 约束 */
  [key: string]: unknown
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
  /** 标准动作内核的 StandardItem 约束（meta 派生记录，键即 apiName） */
  [key: string]: unknown
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
  /** 标准动作内核的 StandardItem 约束（meta 派生记录，键即 apiName） */
  [key: string]: unknown
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
