# 聚合单据内核·行为变更与设计决策日志

迁移分支：`feat/aggregate-kernel`（由 `feat/aggregate-kernel-w0` 改名延续；基线 `main` @ 638235fb；计划见 `.scratch/aggregate-kernel/plan.md` / `/tmp/aggregate-kernel-plan-20260807.md`）。

铁律：红测试 = 显式决策点；每一条有意的行为变更在此记一行（资源/旧行为/新行为/理由）。
报错文案与 wire 字节不变——调用点原有 code/status/字段键/中文文案逐字保留（用 label/字段参数化，不要统一成一种文案）。
禁止为绿测而改文案或删测。

| 日期 | 决策 | 内容 |
|------|------|------|
| 2026-08-07 | D10 | 三个领域基元落 `platform/posting/` 扩容；不新建 `platform/domain-primitives/` |
| 2026-08-07 | D11 | 受控投影累加器收 `afterAdjust` 回调，去掉对 manufacturing/arrangement 的动态 import |
| 2026-08-07 | D12 | mfgWorkOrders **不做**完整聚合草稿；头走 standard+InTx，void 走 workflow；配料/路线/副产品仅 BOM 快照整包写，不进 child/aggregate |

---

## D10 · 领域基元落点（W0 首日定名）

**定案**：扩容既有 `server/src/platform/posting/`，**不**新建 `platform/domain-primitives/` 顶层概念。

**理由**（与 plan 倾向一致，无强偏离理由）：

1. **先例**：`posting` 已是跨域单据共享层（过账骨架 `skeleton.ts` / 形状登记 `shapes.ts`；骨架内 `accountCurrencies` 已在此收口科目币种 SQL）。
2. **铁律**：platform 不 import domain（`docs/系统架构/模块结构.md`）。三基元自带 SQL（对齐 `numbering` 对 `sys_*` 表先例），禁止 `import '~/modules/*'`。
3. **不新增顶层概念**：W0 只是把 trading / inventory / manufacturing 里重复的「单据写路径基元」上提；`domain-primitives/` 会多一层目录语义，与现有 `posting` 边界重叠。

### 定案路径

| 基元 | 路径 | 吸收来源（W0 机械替换，本决策不改行为） |
|------|------|------------------------------------------|
| 物料口径 | `platform/posting/material-qty.ts` | `trading/common.ts` base_qty/物料快照；`inventory/helpers.ts` `projectStockItem`；`manufacturing/helpers.ts` `deriveItemProjection`（同一 join、6 位小数、报错文案按调用点 label 参数化逐字保留） |
| 仓库校验 | `platform/posting/warehouse.ts` | 叶子/同司/启用/外协绑定等 6 份实现、~20 调用点（`validateLeafWarehouse` / `validateWarehouse` 等） |
| 受控投影 | `platform/posting/controlled-projection.ts` | 5 个增量累加器：已发 / 已收 / 已对账 / 已安排相关 / 工单入库；排序锁、`FOR UPDATE`、负数守卫、容差闸门内置。**重算式**投影（`recomputeDemandItemProjections`）保持独立、不并入累加器 |

杂项（plan T0.4，同波可选落地）：

| 工具 | 路径 | 说明 |
|------|------|------|
| `runeLen` / `withIndexedFields` | `platform/posting/text.ts` | 不放进 `platform/standard/fields.ts`：后者专管 ResourceMeta wire/db 值转换，职责不同 |
| `lowerParty` | `platform/posting/text.ts` | 与 skeleton 内 `lowerPartyType` 同语义；调用点改静态 import 本 module |

**不做**：`platform/domain-primitives/`；platform 内任何对 `~/modules/*` 的静态或动态 import。

**与 plan 对照**：plan D10 标 `？`、倾向 `platform/posting/` 扩容——本表 ★ 定案采纳该倾向。

---

## D11 · 受控投影累加器循环依赖解法

**问题**：platform 若直接依赖「安排重算」，会违反 platform↛domain；今日以 3 处动态 import 绕环：

1. `modules/trading/order/projection.ts`（采购入库同步 `mfg_demand_item.received_qty` 后）
2. `modules/trading/order/service.ts`（订单条目挂钩/解钩 `mfg_demand_arrangement` 后）
3. `modules/manufacturing/output-service.ts`（工单 `received_base_qty` 更新后）

均 `await import('…/arrangement.ts')` 再调 `recomputeDemandItemProjections(db, demandItemId)`。

**定案**：累加器 API 收 **`afterAdjust`** 可选回调；由组合根 / 领域调用方注入安排重算。`controlled-projection.ts` **实现处不再知道 manufacturing**。

### `afterAdjust` 签名草图

```ts
import type { DbHandle } from '~/db/tx.ts'
import type { Decimal } from '@synie/shared'

/** 单行投影调整完成后的领域副作用（可选） */
export type AfterAdjust = (
  db: DbHandle,
  ctx: {
    /** 被锁并更新的投影行主键（订单条目 / 需求行 / 工单等） */
    rowId: string
    /** 调整后的投影数量 */
    next: Decimal
    /** +1 审核累加 / −1 作废回滚（与现有 direction 一致） */
    direction: 1 | -1
  },
) => Promise<void>

/** 受控投影描述符（草图；W0 实现时按 5 个累加器收口字段，可增不可改语义） */
export interface ControlledProjectionSpec {
  // table / column / 锁序 / 负数文案 / 容差 … 由实现定
  /**
   * 投影列 UPDATE 成功后、进入下一行之前调用。
   * 缺省 = 无副作用（如纯 shipped_qty / reconciled_qty）。
   * 需要倒写需求安排投影时由调用方注入 recompute。
   */
  afterAdjust?: AfterAdjust
}

// 调用方注入示例（领域侧静态 import，platform 零感知）：
// afterAdjust: async (db, { rowId }) => {
//   await recomputeDemandItemProjections(db, rowId)
// }
```

**注入点约定**：

- 履约已收→需求行：`adjustDemandReceived` 迁入累加器后，`afterAdjust` 在 `received_qty` 写成功后触发；`rowId` = `mfg_demand_item.id`。
- 工单入库投影：`updateWorkOrderProjection` 迁入后同理；`rowId` 取 `demandItemId`（重算键是需求行，不是工单 id——与现 `recomputeDemandItemProjections(db, order.demandItemId)` 一致）。
- 订单条目安排挂钩（`order/service.ts` 动态 import）：不属「单列增量累加器」核心环，但同纪律——**静态** import `arrangement.ts`，或抽本地 `onDemandTouched(db, lineId)` 闭包；禁止再 `await import(...)` 绕环。W0 替换时二选一，行为字节不变。

**明确不并**：`recomputeDemandItemProjections` 本身仍属 manufacturing（从安排事实全量重算 `arranged_qty`/`completed_qty`/行状态），**不**搬进 `controlled-projection.ts`。

**与 plan 对照**：plan D11 标 `？`、建议 `afterAdjust` 由组合根注入——本表 ★ 定案采纳；签名在 plan 一句建议之上补 `ctx.next` / `ctx.direction`，便于日后审计钩，调用方可只解构 `rowId`。

---

## 行为变更表（有意变更时续记）

| 资源 | 旧行为 | 新行为 | 理由 |
|------|--------|--------|------|
| — | — | — | W0 定名阶段无行为变更；实现波次若红测暴露差异，先记本表再改 |
| 内核 standard | list/load 无 extraWhere；accGlJournals/mfgOutputs/accBills list 弹射 | `StandardServiceOptions.extraWhere`（list/get/写前锁共用）；三资源 list（及 bills get）改描述符 | T1.5；可见性/行筛选语义字节冻结，见 v2 extraWhere 合同 |
| salQuotations / purQuotations | 手写 `*InTx` 草稿/子行/孙级；身份校验顶层文案「报价草稿子记录身份不合法」；字段「不属于该报价单/报价条目」；公司改键 `header.companyId` | 聚合内核 `createAggregateService` + child 孙级；身份校验统一 `报价草稿参数不合法`；字段「不属于该{资源 label}」；公司改键 `companyId`（与合同套件一致） | W2 迁入聚合；无测钉死旧身份文案；公司键对齐内核 D4 合同 |
| 同上 | 条目/档独立 CRUD 与草稿各一套手写 | 同一 child InTx + 公开 create/update/remove 包装；草稿走 aggregate | 一份实现两入口，wire 端点不变 |
| purReceipts | 手写草稿/子行；身份文案「采购入库草稿子记录身份不合法」；公司改键 `header.companyId`；子行删/改无审计；头审计键 `number`/`document_date`/`head_id` | 聚合内核 + child；身份统一「采购入库草稿参数不合法」；公司键 `companyId`；子行增/改/删三型审计；头审计键 meta 原列 `receipt_no`/`receipt_date`/`receipt_id` | W2 迁入；与合同套件/报价收敛一致；子行审计补齐属合同强化 |
| salOrders / purOrders | 手写草稿/子行/audit·close·void；公司键 `header.companyId`；身份顶层「订单草稿子记录身份不合法」 | 标准头/子行 + InTx 草稿 + OutsourcedDraftPort；workflow 三转移；公司键 `companyId`；身份「订单草稿参数不合法」 | W3；D7 状态转移；委外子树端口保留 |
| salDeliveries | 手写草稿/条目/装箱；公司键 `header.companyId`；身份顶层「销售发货草稿子记录身份不合法」；装箱行身份按「属本发货单」 | 聚合内核（条目 + 箱→行平行子树）；公司键 `companyId`；身份「销售发货草稿参数不合法」；孙级行身份按「属该装箱箱」 | W3；D3 孙级第二消费者；与合同/报价收敛 |
| 同上 | 条目独立改/删无审计 | 子行增/改/删三型审计 | 合同强化，同 purReceipts |
| 同上 | pack meta 无独立 `label` | `label: 装箱箱/装箱行`（permissionLabel 仍共享发货单前缀） | 标准子行校验文案「装箱行参数不合法」字节保留 |
| salReconciliations / purReconciliations | 手写头/子行/confirm·unconfirm·audit·void；改/删分文案 | 标准头/子行 + 聚合 + workflow 双状态机；mutableMessage「仅草稿…可修改或删除」 | W3；D7 |
| 同上 | 条目 join 投影列为物理 + audit.exclude | 投影列 calculated；item audit 仅物理列 | 标准 child 分离 |
| 同上 | 编号 assignedInTx 可选手填 | 内核 numbering nextInTx 系统生成 | D6 |
| purOutsourcedIssues / purOutsourcedReceipts | 手写头/四类子行/audit·void；编号 assignedInTx | 标准 + 聚合 + workflow；nextInTx 系统编号 | W4；D6/D7 |
| 同上 | 材料跨公司删 not_found 委外入库单不存在 | 委外入库成品行不存在（锁直接母行） | 孙级同 salDeliveries |
| 同上 | skeleton 审核编排 | effect 内联；删 skeleton/shapes | 候选 2 收尾 |
| 同上 | 非草稿再 audit：经 lockDraft 文案「仅草稿…可编辑」 | workflow audit guardMessage「仅草稿…可审核」 | W4 判官；与全站 audit 门对齐；mutableMessage 仍「可编辑」 |
| 同上 | 成品行 PATCH warehouseId 不经 present（服务 `?? before`） | 路由补 warehouseIdPresent；schema nullable.optional | W4 判官：present 写路径下否则静默丢写 |
| mfgDemands | 手写头/行 CRUD；confirm/close/void 手搓；服务 API 枚举小写；编号 assignedInTx 可选手填 | 标准头/子行 + 聚合 + workflow；wire 形大写（对齐 mfgOutputs）；nextInTx 系统编号 | W5；D6/D7 |
| mfgDemands | 条目 meta 销售来源 readonly；快照列可写 | salesOrderItemId createOnly；快照/baseQty/status readonly + derived；label「需求行」 | 标准 child 可写面；「需求行参数不合法」保留 |
| mfgDemands | 确认占量与作废下游闸手写事务内 | 进 transition effect | 钩子纪律；dispatch 非状态转移仍手写 |

---

## T1.5 · extraWhere（list/load 行筛选谓词）

**定案**：`platform/standard` 描述符增加可选 `extraWhere?: (ctx) => { where?, query? }`。

- **list**：解析后 `where` AND 进 `listAuthorized`；`query` 可改写（剥离 filter 伪字段，如 journal `lines`）。
- **load**（get / 写前 `loadBare` / 投影重载）：以空 query 调用；`where` AND 进 `loadAuthorized` / `loadAuthorizedFrom`。依赖 query 的筛选在 get 上自然失效（与既有弹射一致）。
- **child** 同语义可选挂载。
- **不**扩宽 `listAuthorized` 调用方契约以外的授权模型——领域谓词仍由模块描述符声明。

### 三资源收口

| 资源 | 旧弹射 | 新描述符 |
|------|--------|----------|
| accGlJournals | 手写 list + EXISTS 行筛选 | `extraWhere` 剥离 `filter.lines` + EXISTS |
| mfgOutputs | 手写 listOutputs + companyId | `extraWhere` 读 query.companyId |
| accBills | 手写 list/get + EXISTS 可达交易 | 内核 list/get + `extraWhere` 可见性；update/delete 写前锁同谓词 |

**行为**：wire URL/DTO/错误码/可见性语义不变。bills 内部 wire 时间戳仍出 ISO 字符串（`asBill` 适配层）。

---

## W2 · salQuotations / purQuotations 聚合迁入

**定案**：报价头 create/update（整单草稿）与条目/孙级价格档 CRUD 改由 `platform/standard` 派生：

- 头：`createStandardService`（numbering `quotationNo` + workflow audit/void 保留）
- 条目：`createStandardChildService`（via 头；物料快照 `derivedFields`；梯度→固定价 `afterWrite` purge 审计 actionName 仍为 `purge`）
- 价格档：`createStandardChildService`（via 条目，孙级 D3；草稿门 + 仅数量梯度可维护档）
- 草稿三连：`createAggregateService`（`validationMessage: 报价草稿参数不合法`）

**路由/URL/DTO 冻结**；`resolveForOrder` 仍手写。

**有意差异**（见行为变更表）：身份校验顶层文案与「不属于该…」字段文案收敛到内核通用句式；公司不可改字段键去 `header.` 前缀。既有 quotation-draft / quotation-audit 测未钉死这些键。

**验收**：`quotation/service.ts` 1782→≤600（拆 `domain.ts` / `projection.ts` / `types.ts`）；聚合 CASES 加 sal/pur 两行。

---

## W2 · purReceipts 采购入库聚合迁入

**定案**：采购入库头/条目 CRUD 与整单草稿三连改由 `platform/standard` 派生：

- 头：`createStandardService`（numbering `receiptNo`；workflow 仅草稿可变门，审核/作废仍弹射 `auditFulfillmentInTx`/`voidFulfillmentInTx` skeleton）
- 条目：`createStandardChildService`（订单快照 `derivedFields` + `deriveItem`；图纸挂接 `afterWrite`/`beforeDelete`）
- 草稿三连：`createAggregateService`（`validationMessage: 采购入库草稿参数不合法`）
- 销售发货仍手写（W3）

**路由/URL/DTO 冻结**；服务层 `PurchaseReceiptDraftInput` 仍用内部 `no`/`documentDate`，进聚合前映射为 `receiptNo`/`receiptDate`。

**有意差异**（见行为变更表）：身份/公司键文案收敛；子行补齐 destroy/update 审计；头审计列名回归 meta 原列（不再 rename 为 number/document_date）。

**验收**：手写采购草稿/子行 CRUD 删除；聚合 CASES 加 purReceipts 一行；fulfillment.postgres + 合同套件绿。

---

## W3 · salOrders / purOrders 聚合迁入

**定案**：订单头 create/update/delete 与条目 CRUD、整单草稿三连改由 `platform/standard` 派生；audit/close/void 迁 workflow（D7）。

- 头：`createStandardService`（numbering `orderNo` + workflow audit/close/void）
- 条目：`createStandardChildService`（物料快照 + 金额派生 `derivedFields`；图纸挂接 afterWrite/beforeDelete）
- 草稿三连：头+条目走 InTx（与 aggregate D4 同序）；采购委外发料/副产物仍走 **OutsourcedDraftPort**（`outsourced-config.draft`）同事务挂钩——子树非 standard child，不进聚合描述符
- 审核 effect：`verifyItems` 报价复核；采购 `adjustDemandOnAudit(occupy)` 占量
- 作废 effect：`ensureVoidable` 下游闸 + 采购占量释放
- 关闭：纯状态转移

**路由/URL/DTO 冻结**。

**有意差异**（见行为变更表）：

| 资源 | 旧行为 | 新行为 | 理由 |
|------|--------|--------|------|
| salOrders/purOrders | 草稿公司改键 `header.companyId`；子记录身份顶层文案「订单草稿子记录身份不合法」 | 公司键 `companyId`（合同套件一致）；身份统一「订单草稿参数不合法」 | W2 报价/入库同收敛；无测钉死旧键/旧顶层文案 |
| 同上 | 头改/删文案分「仅草稿订单可修改」「仅草稿订单可删除」 | workflow `mutableMessage`「仅草稿订单可修改或删除」 | 内核单门；条目门仍「仅草稿订单可编辑条目」 |
| 同上 | 独立 update 条目未带 taxRate 时会重解析报价税率 | update 合并后默认保留既有 taxRate（全量草稿仍显式提交） | child 钩子不见原始 patch；合同/草稿测不依赖该边角 |

**验收**：`order/service.ts` ≤800；聚合 CASES 加 salOrders/purOrders 两行；order-draft + 合同套件绿。

---

## W3 · salDeliveries 销售发货聚合迁入

**定案**：销售发货头/条目/装箱箱/装箱行与整单草稿三连改由 `platform/standard` 派生：

- 头：`createStandardService`（numbering `deliveryNo`；workflow 仅草稿可变门；审核/作废仍弹射 skeleton）
- 条目：`createStandardChildService`（订单快照 `derivedFields` + `deriveItem`；图纸挂接 afterWrite/beforeDelete）
- 装箱箱：`createStandardChildService`（`boxNo` 派生自单内 MAX+1；无可写用户列）
- 装箱行：孙级 via 箱（D3）；`inheritFields: companyId+deliveryId`；物料快照 `derivedFields`
- 草稿三连：`createAggregateService`（`items` ∥ `packBoxes→lines`；`validationMessage: 销售发货草稿参数不合法`）
- 金额分摊（审核 collect）/装箱相等（`validatePackEquality`）留在 audit effect 路径，不进聚合钩子

**路由/URL/DTO 冻结**；服务层 `SalesDraftInput` 仍用内部 `no`/`documentDate`，进聚合前映射为 `deliveryNo`/`deliveryDate`。

**有意差异**（见行为变更表）：公司键/身份顶层文案收敛；装箱行身份相对箱（更严于「属本单」）；条目补齐 destroy/update 审计；pack meta 补 `label`。

**验收**：`fulfillment/service.ts` ≤800；聚合 CASES 加 salDeliveries 一行；fulfillment.postgres + 合同套件绿。

---

## W3 · salReconciliations / purReconciliations 聚合迁入

**定案**：对账头/条目 CRUD 与整单草稿三连改由 `platform/standard` 派生；常规 confirm/unconfirm 与赠样 audit/void 双状态机迁 workflow（D7）；发票↔对账互锁（`closeFromInvoice`/`reopenFromInvoice`/`invoiceState`）仍手写 Actor+外层 trx，语义逐字冻结。

- 头：`createStandardService`（numbering `reconciliationNo` + workflow 四转移）
- 条目：`createStandardChildService`（来源快照 `derivedFields` baseQty/amount/baseAmount）
- 草稿三连：`createAggregateService`（`validationMessage: 对账草稿参数不合法`；路由暂无草稿端点，CASES/`_aggregateForContract` 暴露）
- 常规 effect：confirm 占量+开待办；unconfirm 发票关联闸+释放占量+关待办
- 赠样 effect：audit 占量+可选 GL + posting_date；void gl.cancel+释放占量
- 发票接缝：`invoice-seams.ts` 独立 module，不经 workflow

**路由/URL/DTO 冻结**（头/条目 CRUD + confirm/unconfirm/audit/void）。

**有意差异**（见行为变更表）：改/删统一 mutableMessage；编号系统生成；条目投影列 calculated。

**验收**：`reconciliation/service.ts` ≤700；聚合 CASES 加 sal/pur 两行；reconciliation.postgres + 合同套件绿。

---

## W4 · purOutsourcedIssues / purOutsourcedReceipts 聚合迁入

**定案**：委外发料/入库头与四类子行 CRUD、整单草稿三连改由 `platform/standard` 派生；audit/void 迁 workflow（D7）；原 posting skeleton 四调用点与履约侧 fulfillment 调用点一并内联到领域 effect，删除 `skeleton.ts` / `shapes.ts`。

- 发料头：`createStandardService`（numbering `issueNo` + workflow audit/void；effect 库存双分录 + issued_qty 投影）
- 发料行：`createStandardChildService`（订单材料快照 `derivedFields`）
- 入库头：`createStandardService`（numbering `receiptNo` + workflow audit/void；effect 三向收料 + 投影 + 条件 GL）
- 入库成品行：`createStandardChildService`；`afterWrite` 钩子 **carryReceiptChildren** 比例带出材料/副产物
- 材料/副产物：`createStandardChildService`（via 成品行，孙级 D3）；独立 CRUD，**不进**聚合草稿树（空数组会抹掉 carry）
- 草稿三连：`createAggregateService`（发料 `items`；入库仅 `items`；`validationMessage: 委外发料/入库草稿参数不合法`）
- 借贷科目币种：`platform/posting/account-currency.ts`（原 skeleton 内联）

**路由/URL/DTO 冻结**（头/子行 CRUD + audit/void；无新增草稿 URL）。

**有意差异**（见行为变更表续行）：

| 资源 | 旧行为 | 新行为 | 理由 |
|------|--------|--------|------|
| purOutsourcedIssues/Receipts | 编号 assignedInTx 可选手填 | 内核 numbering nextInTx 系统生成 | D6 |
| 同上 | 材料删跨公司 not_found「委外入库单不存在」 | 锁直接母行 →「委外入库成品行不存在」 | 与 salDeliveries 孙级同收敛 |
| 材料/副产物 | 审计键 rename `source_id`/`warehouse_id` | 物理列名 `order_item_material_id` 等 | 标准 child 审计面 |
| 投影列 | audit.exclude 列出头快照列 | meta `calculated`，无需 exclude | 与 fulfillment 条目同形态 |
| audit 门 | 非草稿 audit 经 lockDraft →「仅草稿…可编辑」 | `guardMessage`「仅草稿…可审核」 | W4 判官；全站 audit 口径；改/删仍「可编辑」 |
| 成品行 PATCH warehouseId | 服务 `input.warehouseId ?? before`（无 present） | 路由 `warehouseIdPresent` + nullable schema | W4 判官丢写；对齐头/副产物/履约 |

**验收**：`outsourced/service.ts` ≤1100；四类子行手写 CRUD 删除；skeleton/shapes 删除；聚合 CASES 加 issue/receipt 两行。

---

## W5 · mfgDemands 聚合迁入

**定案**：履约需求单头/条目 CRUD 与整单草稿三连改由 `platform/standard` 派生；confirm/close/void 迁 workflow（D7）；确认销售占用校验与作废下游拦截进 effect；dispatch / 安排 / 销售占用 / 点完成兼容 / 工单派生受信任写仍手写。

- 头：`createStandardService`（numbering `demandNo` + workflow confirm/close/void）
- 条目：`createStandardChildService`（物料快照 `derivedFields`；图纸 `afterWrite`/`beforeDelete`；投影可安排量）
- 草稿三连：`createAggregateService`（`validationMessage: 履约需求单草稿参数不合法`；路由暂无草稿 URL，CASES/`_aggregateForContract` 暴露）
- confirm effect：至少一行 + 销售来源占用校验（原 confirmDemand 事务体）
- void effect：锁行 + 未作废工单 / 已审核采购闸
- close：纯状态转移

**路由/URL/DTO 冻结**（头/条目 CRUD + confirm/close/void/dispatch + 安排）。

**有意差异**（见行为变更表）：服务层枚举改 wire 大写；编号系统生成；meta 可写面收口。

**验收**：`demand-service.ts` ≤600；手写草稿/子行 CRUD 删除；聚合 CASES 加 mfgDemands 一行；manufacturing 相关测绿。

---

## D12 · mfgWorkOrders 子行形态（W5 首日·调用面定案）

**问题**（plan D12 标 `？`）：工单配料 / 路线 / 副产品三表由 BOM 快照复制写入、用户不逐行 CRUD——是否只需 InTx 变体 + workflow，而不需要完整聚合草稿（`createAggregateService` / `replaceDraft`）。

### 调用面证据（`work-order-service.ts` + `routes.ts` + meta）

| 出口 | 子表写/读 | 用户形态 |
|------|-----------|----------|
| `createWorkOrder` | 可选 `copyBomSnapshotToWorkOrder`（`bomId`） | 头从需求行派生；无子行入参 |
| `updateWorkOrder` | 无 | 仅 `workOrderNo`（创建后不可改号） |
| `deleteWorkOrder` / `voidWorkOrder` | 级联删派生草稿；不改 BOM 子表内容 | 头状态/生命周期 + effect |
| `applyBom` | **整包** clear + copy 三表，或 clear+`bom_id=null` | 选/清 BOM，非逐行 |
| `createInlineBom` | 写 **mfg_bom** 主数据 + 整包复制到工单快照 | 跨资源编排（BOM create + 工单 update） |
| `getBomSnapshot` | 只读 join 三表 | 展示 / 打印 / 派生弹窗 |
| `getMaterialDemandPreview` / `generateMaterialDemand` | 只读配料；派生 **mfg_demand** 草稿 | 跨资源编排，非子行 CRUD |
| 路由 | **无** `GET/POST/PUT …/draft`；**无** `work-order-components|routes|byproducts` CRUD | wire 本就无草稿三连、无子行端点 |
| meta 子资源 | `mfgWorkOrderComponents/Routes/Byproducts` | `presentation: none`；`actions: [read]`；注释「打印循环区」 |

产品文档 [`docs/业务模块/生产工单.md`](../业务模块/生产工单.md) 一致：选 BOM 后快照到私有子表；内嵌创建 BOM 是「建正式 BOM 并选入」；生成物料需求读快照配料。

### 定案 ★

**不做完整聚合草稿。** W5 对 `mfgWorkOrders` 的内核形态为：

1. **头**：`createStandardService`（或等价派生）+ 既有/新增 `*InTx` 变体；创建仍由需求行弹射编排（占量 `upsertMakeArrangement`、图纸 `syncDrawingAttachments`、可选 BOM 快照）在外层 `withTx` 内调 InTx / 受信任写。
2. **void**：迁 **workflow** `transitions`（D7）；effect 保留：`removeMakeArrangementByWorkOrder`、`cascadeDeleteDerivedDrafts`、已审核入库闸（`hasAuditedOutput`）。delete 的级联同属 effect / 钩子纪律，不进草稿。
3. **三子表**：**不**注册 `createStandardChildService`，**不**进 `createAggregateService` 子树，**不**加聚合 CASES 行（计划 DoD「14 聚合」中 work-order **从聚合计数剔除**，或计为「头+workflow 迁入、非聚合」——见下「计划对照」）。
4. **快照写**保留模块内私有助手（今日 `copyBomSnapshotToWorkOrder` / `clearWorkOrderBomSnapshot` 及 `createInlineBom` 内联同构段可抽一处）：仅被 `create` / `applyBom` / `createInlineBom` 同事务调用；语义仍是 **整集合替换**（先删后插），不是用户 diff 的 replaceDraft。
5. **领域动作原样手写弹射**（路由/URL/DTO 冻结）：`apply-bom`、`create-bom`、`bom-snapshot`、`material-demand-preview`、`generate-material-demand`。生成物料需求是跨资源持久化，按铁律走编排而非聚合钩子。

### 为何不是聚合草稿

| 聚合草稿前提（D4 / 交易域） | 工单实际 |
|------------------------------|----------|
| 用户编辑头+多子行，GET/POST/PUT draft 三连 | **无** draft 端点；头 update 几乎空操作 |
| 子行独立 create/update/remove 授权与逐行审计 | 子 meta 只读；写路径无逐行审计，仅头 `apply_bom` / `create_inline_bom` 痕 |
| `replaceDraft` 缺失即删、暂态空集闸 | 快照由服务端从 BOM **整包**复制；用户不能提交 partial children |
| 聚合 CASES 合同面 | 无可替换的草稿 wire 可钉 |

强行挂聚合会：虚构 draft wire（违反 D8 冻结或扩面）、把只读打印 meta 变成可写 child、或把 BOM 主数据创建塞进 `deriveChild`——均违背钩子纪律与 YAGNI。

### 与 plan / DoD 对照

- plan D12 倾向「可能只需 InTx + workflow」——**本表采纳**。
- 终态 DoD「14 个资源 … 聚合草稿」中 **`mfgWorkOrders` 降级为：标准头 + workflow + 快照助手**；聚合合同 CASES **不加** work-order 行。度量「聚合 CASES = 14」改为 **交易+制造中真正有草稿三连/子行 CRUD 的资源数**（实现波次更新 plan 度量时改数，本决策不改代码）。
- W5 验收行数目标 `work-order-service.ts` ≤700 仍适用：删手写状态转移循环、收口快照复制重复，**不**引入 aggregate 描述符。

**不做（本决策）**：为工单新增 draft URL；为三快照表开标准 child CRUD；把 `generateMaterialDemand` / `createInlineBom` 塞进聚合 `afterWrite`。

**行为**：本决策纯形态定案，**无 wire/语义变更**；实现波次若红测暴露差异，先记行为变更表再改。

---

## 非目标（本日志边界）

- 不动 `engines/gl` | `engines/inventory` interface。
- 不做路由词表收口；wire URL/DTO/错误码字节冻结。
- mfgOutputItems list 仍弹射（母单投影 join，非 extraWhere 能单独解锁）。
- 本波不对账路由新增草稿三连 URL（前端仍逐条 CRUD；聚合服务已就绪供合同/后续）。
- 本波不对委外路由新增草稿三连 URL（聚合服务已就绪供合同/后续）。
- mfgWorkOrders **不做**聚合草稿三连（D12）；子表非用户 CRUD。
