# 聚合单据内核（platform/standard aggregate）

日期：2026-08-07  
状态：已实施（分支 `feat/aggregate-kernel`，计划 [`docs/migration/aggregate-kernel-plan.md`](../../migration/aggregate-kernel-plan.md)）  
前置：[`2026-08-06-standard-actions-kernel.md`](2026-08-06-standard-actions-kernel.md)（平坦资源标准动作）  
决策细目与行为变更：[`docs/migration/aggregate-kernel-decisions.md`](../../migration/aggregate-kernel-decisions.md)

## 背景

标准动作内核（v1/v2）已收口平坦主数据的 CRUD、子行一层、workflow 与合同套件，但交易/制造域的**头+多子行整单草稿**仍手写：`withTx` 内嵌编号、逐行审计、缺失即删与状态转移循环在十余个 service 中重复。标准迁移决策日志曾点名硬阻断——**内核动作自开事务、子行仅一层**——使报价/订单/履约等聚合无法弹射。

架构目标：读懂一个单据资源 = **一份聚合描述符 + 一小撮领域钩子**；跨资源效果（过账、占量、发票互锁等）仍走 transition effect / 手写编排，不进草稿钩子。

## 决定

下列 D1–D12 全部定案（★）；实现已落地，细节以决策日志与源码为准。

| ID | 决定 | 落点 |
|----|------|------|
| **D1** | 在途事务变体：root/child 动作族增加 `*InTx(trx, permit, …)`；外层事务由聚合（或编排）持有；**不**采用「动作可选 trx」重载 | `platform/standard/service.ts`、`child.ts` |
| **D2** | 聚合能力落 `platform/standard/aggregate.ts`，组合 InTx；**不**扩宽 `StandardServiceOptions` | `createAggregateService` |
| **D3** | 孙级：child 的 `parent.resource` 可指另一 child；装配期链深 **≤ 2**（价格档、装箱行、委外材料/副产） | `child.ts` + 装配断言 |
| **D4** | `replaceDraft`：全集合快照、缺失即删；差异增/改/删逐行授权与审计；暂态空集不表示删除（前端 `assertAggregateDraftReady`）；**删行先于头更新** | `aggregate.ts`；术语表「聚合草稿 Adapter」 |
| **D5** | 快照冻结留钩子（`derivedFields` / `deriveChild` 等）；不进 meta 列清单 | 各域 service 钩子；W0 物料口径基元共用 |
| **D6** | 编号统一 `options.numbering` → `nextInTx` 系统生成；单号字节与「拒手填」政策对齐 | 头 `createStandardService` |
| **D7** | 状态转移随资源迁 workflow（audit/close/void/confirm…）；效果进 `effect`/`after` | 各域 workflow / transitions |
| **D8** | **路由与 wire 冻结**：草稿三连与既有 URL/DTO/错误 code/文案字节不变；路由暂保手写；不做词表收口 | 各 `routes.ts` |
| **D9** | 质量闸门：红测试 = 决策点；合同套件 CASES 描述符；决策日志续记；每波判官 | `aggregate-contract.postgres.test.ts` + 本日志 |
| **D10** | 领域基元落 `platform/posting/` 扩容（物料口径 / 仓库 / 受控投影 / text）；**不**建 `domain-primitives/` | `material-qty.ts` 等 |
| **D11** | 受控投影 `afterAdjust` 回调解环；platform **零** manufacturing import | `controlled-projection.ts` |
| **D12** | **mfgWorkOrders 不做完整聚合草稿**：头 standard+InTx；void→workflow；配料/路线/副产仅 BOM 快照整包助手；侧动作手写 | `work-order-service.ts` |

### 聚合草稿语义（与术语表一致）

- **loadDraft**：`withReadSnapshot`（repeatable-read）头+子树；投影口径与 list/get 同源（禁止裸 `SELECT *` 丢 join 键）。
- **createDraft / replaceDraft**：单事务；编号走 head numbering；子行走 child `*InTx`。
- **钩子纪律**：草稿只管持久化；过账/占量/倒写安排/发票↔对账互锁 → transition effect 或手写编排。
- **platform ↛ modules**：`platform/*` 禁止 import `~/modules/*`（注册入口与合同测夹具除外）。

### 迁入范围（本 ADR 覆盖的资源）

**完整聚合**（描述符 + 合同 CASES 行）：

`salQuotations` / `purQuotations`（含孙级价格档）、`salOrders` / `purOrders`（委外子树经 `OutsourcedDraftPort` 同事务、不进描述符子树）、`salDeliveries`（条目 ∥ 箱→装箱行）、`purReceipts`、`salReconciliations` / `purReconciliations`、`purOutsourcedIssues` / `purOutsourcedReceipts`（材料/副产孙级独立 CRUD、**不进**入库草稿树以免 carry 被空数组抹掉）、`mfgDemands`、`mfgBoms`、`mfgProcessTemplates`。

**非聚合、已迁内核头/workflow**：`mfgWorkOrders`（D12）。

**顺带**：`extraWhere` 解锁 `accGlJournals` / `mfgOutputs` / `accBills` 的 list（及 bills get）弹射收口。

### 前端半边

- 草稿三连：`aggregateDraftTransport`（`web/app/lib/resources/aggregate-draft-transport.ts`）→ `DRAFT_ADAPTERS`。
- 无整单替换 URL 的资源：`persistChildRows` 统一 diff 循环。
- 抽屉管道：`useDocumentDrawer` + open 桥工厂；条目状态仍在呈现扩展。

## 后果

- 新聚合迁入 = 写 meta + 钩子 + `createAggregateService` 子树 +（若有 wire 草稿三连）挂工厂 Adapter + 合同 CASES 加一行；禁止再手搓 replace 循环。
- 模块 service 行数显著下降（见决策日志 W7 收线表）；内核 + 合同测行数上升，换一次编写全站摊销。
- 有意行为收敛（身份顶层文案、公司改键去 `header.` 前缀、子行审计三型、编号系统生成等）以决策日志为准；**禁止**为绿测改文案或删测。
- `posting/skeleton.ts` 与 `shapes.ts` 删除；过账编排归属各域 workflow effect。

## 否决 / 非目标

- 不动 `engines/gl`、`engines/inventory` interface。**后续更新（2026-08-21）**：经架构评审重开此条款——为 `engines/inventory` 读侧新增原语形方法 `onHand` / `onHandByMaterial` / `hasEntries`（收 `DbHandle` 只读），动机是「账面库存 = Σ 未作废分录」口径 4 份散落实现（helpers 手写 SUM、盘点两段原生 SQL、工单需求预览借用报表形 `balance()` 等）收口进引擎；`balance()` 报表形与写侧 interface（`post`/`cancel`）不变，`engines/gl` 不动。
- 不做路由词表收口与批量权限码扩面（独立决策）。
- 不做红冲扩面、库存估值等业务演进。
- 不为工单虚构 draft URL 或把只读快照 meta 改成可写 child（D12）。
- 不对账/委外/部分制造资源**本波新增**草稿三连 URL（服务与 CASES 已就绪；扩面另议）。**后续更新**：对账/委外四资源已于 2026-08-07 落地（决策日志 W8）；制造资源仍不新增。

## 后续（非本 ADR 范围）

- 对账/委外/需求/BOM 等草稿 URL 与前端 `DRAFT_ADAPTERS` 扩面（wire 增量，需产品确认）。**已完成（对账/委外四资源，决策日志 W8）**；mfgDemands / mfgBoms / mfgProcessTemplates 仍待产品确认。
- `mfgOutputItems` list 等仍弹射的投影 join。
- 类型级 wire 派生（const meta → 精确输入类型）——继承标准动作内核待办。**后续更新（2026-08-21）**：运行时半边已落地——`platform/standard/present.ts` `derivePresenter`（meta → wire DTO，fields/values 钩子挂键并集·改序·计算列）与 `wire.ts` `deriveDraftObject`/`deriveDraftSchemas`（meta → 草稿 zod，逐字段补丁），trading 的 returns/fulfillment/reconciliation 已迁移（presenter/草稿 zod 字段事实收回 meta，wire 字节经 `server/scripts/wire-equiv-dump.ts` 对拍冻结）；`_aggregateForContract` 的 toPayload+present 包装收进内核 `withAggregateWireAdapter`。DTO interface 仍保留为 hc 契约锚点；const meta → 精确类型推导（消灭 interface 锚点）仍为待办。order/quotation/outsourced 尚未迁移。
- 标准动作内核 ADR 中「审核/作废 + 单据迁入」：单据聚合路径由**本 ADR 完成**；平坦资源 workflow 仍按原 ADR 演进。
