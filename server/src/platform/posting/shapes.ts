/**
 * 单据过账形状登记表。
 *
 * 新单据类型出现时先在这里登记落点，再实现；不要按文件名考古抄实现。
 * 登记表只约束「形状必须显式选择」，不约束实现本身——例外形状（exception）
 * 必须在 note 里写清不套骨架的原因，原因消失时应回迁骨架。
 */

/** 过账骨架形状（见 ./skeleton.ts 头部注释） */
export type PostingShape =
  /** 库存 + 条件总账双分录 + 订单投影：auditFulfillmentInTx / voidFulfillmentInTx */
  | 'fulfillment'
  /** 仅库存引擎，投影可选：auditInventoryDocInTx / voidInventoryDocInTx */
  | 'inventory-doc'
  /** 仅 GL 引擎，副作用走 after* 钩子：auditGlDocInTx / voidGlDocInTx */
  | 'gl-doc'
  /** 无引擎段，纯状态机迁移 + 审计：flipDocStatusInTx */
  | 'status-flip'
  /** 不套骨架的例外，note 必须写明原因 */
  | 'exception'

export interface PostingShapeEntry {
  shape: PostingShape
  /** exception 必填：不套骨架的原因；骨架形状可写接入备注 */
  note?: string
}

function entry(shape: PostingShape, note?: string): PostingShapeEntry {
  return note ? { shape, note } : { shape }
}

/** key 为权限资源码（域.资源），与 CONTEXT.md 术语一致 */
export const POSTING_SHAPES = {
  // ---- 履约：库存 + 条件总账 + 订单投影 ----
  'sales.delivery': entry('fulfillment'),
  'purchase.receipt': entry('fulfillment'),
  'purchase.outsourced_receipt': entry('fulfillment'),

  // ---- 库存单据：仅库存引擎 ----
  'inv.stock_doc': entry('inventory-doc'),
  'inv.stock_count': entry('inventory-doc', 'actionName=approve/cancel，voidStatus=cancelled'),
  'mfg.output': entry('inventory-doc', 'postProjection 回写工单完工与需求行'),
  'purchase.outsourced_issue': entry(
    'inventory-doc',
    '投影行键为 orderItemMaterialId（非履约 PostingProjectionLine），经闭包 postProjection 注入',
  ),

  // ---- 总账单据：仅 GL 引擎 ----
  'acc.expense_report': entry('gl-doc'),
  'acc.bill': entry('gl-doc', 'REALLOCATE 经 skipGl；作废含 replayBill'),
  'acc.vat_invoice': entry('gl-doc', '红冲经 resolveGlEnd=reverse；flipToEnded 清对账关联'),

  // ---- 状态翻转：无引擎段 ----
  'sales.quotation': entry('status-flip', '审核校验条目非空与梯度完整'),
  'purchase.quotation': entry('status-flip', '同销售报价'),

  // ---- 例外：不套骨架（原因写在 note） ----
  'inv.stock_transfer': entry(
    'exception',
    '发货/收货两段状态机（draft→shipped→received），字段 shipped_at/received_at，收货还逐行写 received_qty 并各写审计；非单段 audit/void 形状',
  ),
  'acc.gl_journal': entry(
    'exception',
    '建头+行+审核一体的 createAndAuditJournal 无闸 seam，生命周期与单据审核不同；auditJournalInTx 本身已是单一实现',
  ),
  'sales.reconciliation': entry(
    'exception',
    '常规/赠送两类型状态机不对称（确认/结单/发票联动回退），已有内部 changeState 通用翻转；赠送单过账走 postGiftGL 特例',
  ),
  'purchase.reconciliation': entry('exception', '同销售对账单（镜像）'),
  'mfg.demand': entry(
    'exception',
    '确认含销售订单占用行锁校验，作废含下游拦截；本地 transitionDemand 已是通用翻转小骨架',
  ),
  'mfg.work_order': entry(
    'exception',
    '无审核迁移（创建即 in_progress），仅作废 + 安排倒写回滚；单次迁移不值得套骨架',
  ),
  'sales.order': entry(
    'exception',
    'audit/close/void 三迁移共用 transition，含 verifyItems 与需求占量副作用；候选：后续可迁 status-flip（beforeFlip 钩子）',
  ),
  'purchase.order': entry('exception', '同销售订单'),
  'mfg.bom': entry(
    'exception',
    'activate/deactivate 互转，本地 setBomStatus 已是通用翻转小骨架',
  ),
} as const satisfies Record<string, PostingShapeEntry>

export type PostingShapeResource = keyof typeof POSTING_SHAPES
