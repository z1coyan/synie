/**
 * 单据状态胶囊配色(enumColors)与行操作显隐(ACTION_VISIBLE)的共享口径。
 *
 * 逐点抄自 routes/_app 各页面现状:不同状态家族口径本就不同
 * (如需求单 CONFIRMED 绿、对账单 CONFIRMED 蓝;盘点单是 CANCELLED 而非 VOIDED),
 * 这里只按家族命名沉淀,不统一各家族口径。未列入的页面级特例见各家族注释。
 */
import type { EnumChipColor, Row } from '~/components/synie-data-grid/types'

// ── enumColors 状态家族 ─────────────────────────────────

/** 审核型单据(草稿灰/已审核绿/已作废红):出入库、发货、报价、委外、费用报销、其他出入库等 */
export const AUDIT_DOC_STATUS_ENUM_COLORS = {
  DRAFT: 'default',
  AUDITED: 'success',
  VOIDED: 'danger',
} satisfies Record<string, EnumChipColor>

/** 订单型单据(草稿灰/已审核绿/已关闭黄/已作废红):销售订单、采购订单(头与条目页同套) */
export const ORDER_DOC_STATUS_ENUM_COLORS = {
  DRAFT: 'default',
  AUDITED: 'success',
  CLOSED: 'warning',
  VOIDED: 'danger',
} satisfies Record<string, EnumChipColor>

/** 生产需求单(草稿灰/已确认绿/已关闭黄/已作废红):注意 CONFIRMED 是绿,与对账单家族不同 */
export const DEMAND_DOC_STATUS_ENUM_COLORS = {
  DRAFT: 'default',
  CONFIRMED: 'success',
  CLOSED: 'warning',
  VOIDED: 'danger',
} satisfies Record<string, EnumChipColor>

/** 对账单(草稿灰/已确认蓝/已结单绿/已作废红):销售/采购对账头与条目页同套 */
export const RECONCILIATION_DOC_STATUS_ENUM_COLORS = {
  DRAFT: 'default',
  CONFIRMED: 'accent',
  CLOSED: 'success',
  VOIDED: 'danger',
} satisfies Record<string, EnumChipColor>

/** 调拨单(草稿灰/在途蓝/已收货绿) */
export const TRANSFER_DOC_STATUS_ENUM_COLORS = {
  DRAFT: 'default',
  SHIPPED: 'accent',
  RECEIVED: 'success',
} satisfies Record<string, EnumChipColor>

/** 盘点单(草稿灰/已审核绿/已取消红):终态是 CANCELLED 不是 VOIDED */
export const COUNT_DOC_STATUS_ENUM_COLORS = {
  DRAFT: 'default',
  AUDITED: 'success',
  CANCELLED: 'danger',
} satisfies Record<string, EnumChipColor>

/** 生产工单(进行中蓝/已完工绿/已作废红) */
export const WORK_ORDER_STATUS_ENUM_COLORS = {
  IN_PROGRESS: 'accent',
  COMPLETED: 'success',
  VOIDED: 'danger',
} satisfies Record<string, EnumChipColor>

/** 生产需求条目(待排产灰/已排产蓝/已完成绿) */
export const DEMAND_ITEM_STATUS_ENUM_COLORS = {
  PENDING: 'default',
  SCHEDULED: 'accent',
  COMPLETED: 'success',
} satisfies Record<string, EnumChipColor>

/** 销售订单分型(常规灰/样品蓝) */
export const SALES_ORDER_TYPE_ENUM_COLORS = {
  REGULAR: 'default',
  SAMPLE: 'accent',
} satisfies Record<string, EnumChipColor>

/** 采购订单分型(常规灰/零星蓝) */
export const PURCHASE_ORDER_TYPE_ENUM_COLORS = {
  REGULAR: 'default',
  SPOT: 'accent',
} satisfies Record<string, EnumChipColor>

/** 薪资发放类型(正常绿/补发蓝) */
export const PAYROLL_PAYMENT_KIND_ENUM_COLORS = {
  NORMAL: 'success',
  SUPPLEMENT: 'accent',
} satisfies Record<string, EnumChipColor>

/** 工资单状态(待发放黄/已发放绿) */
export const PAYROLL_SLIP_STATUS_ENUM_COLORS = {
  PENDING: 'warning',
  PAID: 'success',
} satisfies Record<string, EnumChipColor>

/** 借款/还款(借款黄/还款绿) */
export const PAYROLL_LOAN_KIND_ENUM_COLORS = {
  BORROW: 'warning',
  REPAY: 'success',
} satisfies Record<string, EnumChipColor>

/** 考勤导入批次(已解析蓝/解析失败红/已导入绿) */
export const ATTENDANCE_IMPORT_STATUS_ENUM_COLORS = {
  PARSED: 'accent',
  FAILED: 'danger',
  IMPORTED: 'success',
} satisfies Record<string, EnumChipColor>

/** 考勤日(正常绿/缺卡红) */
export const ATTENDANCE_DAY_STATUS_ENUM_COLORS = {
  OK: 'success',
  MISSING: 'danger',
} satisfies Record<string, EnumChipColor>

// ── ACTION_VISIBLE 工厂与家族预设 ───────────────────────

/**
 * 行操作显隐工厂:按「动作 → 放行状态集」生成 actionVisible 映射。
 * 缺省读 row.status;条目页状态在订单头字段上,传 statusField(如 'orderStatus')。
 * 判定与页面手写版逐点一致(严格相等);未列出的动作 key 不进映射,
 * 由 SynieDataGrid 的 vis() 缺省 true 放行——不要在生成映射里补默认。
 */
export function docActionVisible(
  spec: Record<string, readonly string[]>,
  statusField = 'status',
): Record<string, (row: Row) => boolean> {
  const out: Record<string, (row: Row) => boolean> = {}
  for (const [key, statuses] of Object.entries(spec)) {
    out[key] = (row) => statuses.some((s) => row[statusField] === s)
  }
  return out
}

/** 订单型单据行操作:草稿可审核/删除,已审核可关闭/作废(销售/采购订单页共用) */
export const ORDER_DOC_ACTION_VISIBLE = docActionVisible({
  audit: ['DRAFT'],
  close: ['AUDITED'],
  void: ['AUDITED'],
  delete: ['DRAFT'],
})

/** 审核型单据行操作:草稿可审核/删除,已审核可作废(出入库/发货/报价/委外等) */
export const AUDIT_DOC_ACTION_VISIBLE = docActionVisible({
  audit: ['DRAFT'],
  void: ['AUDITED'],
  delete: ['DRAFT'],
})

/** 审核型单据(含编辑门控):草稿才可编辑/审核/删除,已审核可作废(-stock-doc、费用报销同款) */
export const AUDIT_DOC_EDIT_ACTION_VISIBLE = docActionVisible({
  audit: ['DRAFT'],
  void: ['AUDITED'],
  edit: ['DRAFT'],
  delete: ['DRAFT'],
})
