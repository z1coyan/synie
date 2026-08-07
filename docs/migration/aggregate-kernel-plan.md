# 聚合单据内核 · 实施计划报告

日期：2026-08-07 · 基线：main @ 638235fb · 前置证据：/tmp/architecture-review-20260807-114038.html

主线 = 架构评审候选 1（聚合单据进内核），配候选 3（领域基元下沉，前置减重）与候选 5（前端半边）。
候选 2 中与本批资源重合的 5 处手搓状态转移随各自资源的波次顺带迁入内核 workflow；`extraWhere` 作为廉价内核能力一并补齐。

---

## 一、目标与终态

**目标**：让「读懂一个单据资源」= 读一份 meta 描述符 + 一小撮领域钩子。把决策日志点名的「交易域五聚合写资源的唯一硬阻断」（内核动作自开事务 + 子行仅一层）拆掉，将 12+2 个聚合写资源迁入标准动作内核。

**终态验收（Definition of Done）**：

1. 下列 14 个资源的 create/update（聚合草稿）、子行写入、状态转移全部由 `platform/standard` 派生，模块侧只剩描述符 + 领域钩子：
   - trading：`salOrders`、`purOrders`、`salDeliveries`、`purReceipts`、`salReconciliations`、`purReconciliations`、`purOutsourcedIssues`、`purOutsourcedReceipts`，以及 `salQuotations`/`purQuotations` 的弹射动作（聚合 create/update + 孙级价格档）
   - manufacturing：`mfgDemands`、`mfgWorkOrders`、`mfgBoms`、`mfgProcessTemplates`
2. 聚合合同测试套件成立：新聚合迁入 = CASES 加一行描述符，免费继承全部合同断言。
3. `platform/posting/skeleton.ts` 与 `shapes.ts` 删除（活函数吸收进内核 workflow effect 惯用法）。
4. 前端：13 个骨架抽屉 + 15 个手写装载器统一到 `useDocumentDrawer`；15 个 `persist*`、8 份 `itemChanged` 收进草稿 Adapter 工厂。
5. wire 契约字节级不变（路由暂保手写），`bun run typecheck && bun test` 两侧全绿，E2E 全绿。
6. 文档：新 ADR、术语表新词条、`资源接入.md` 与 `模块结构.md` 更新、决策日志续记。

**非目标**（明确不做，防蔓延）：

- 不动 `engines/gl`、`engines/inventory` 的 interface。
- 不做候选 6（路由词表收口）——批量权限码扩面 + 角色数据迁移是独立决策，本计划路由一律保持手写、URL 与 DTO 字节冻结。
- 不动钩子纪律：跨资源流程（过账、占量、倒写安排、发票↔对账互锁）仍走 transition effect / 手写编排，不进聚合草稿。
- 不做业务演进（红冲扩面、库存估值等）。

---

## 二、设计决策（grilling 的书面化；标 ★ 的建议已可直接执行，标 ？的留到对应波次首日拍板）

**D1 ★ 在途事务变体的形态**：沿用 `numbering.nextInTx/assignedInTx` 先例——内核 root/child 服务的动作族增加 `*InTx(trx, permit, …)` 变体，外层事务由聚合层持有；`Permit` 仍是唯一入场券（授权凭证语义不变）。不采用「动作可选收 trx 参数」的重载形态，避免把事务边界藏进参数默认值。

**D2 ★ 聚合能力的落点**：新建 `platform/standard/aggregate.ts`，组合既有 root service 与 child service 的 InTx 变体，不扩宽 `StandardServiceOptions`。理由：平坦资源的 interface 保持小（depth 是 interface 的属性）；聚合描述符是另一个 module，有自己的合同测试面。

**D3 ★ 孙级子行**：child 描述符的 `parent.resource` 允许指向另一个 child 资源，装配期断言链深 ≤ 2（价格档、装箱行足够）。不做任意深度递归——YAGNI。

**D4 ★ replaceDraft 语义（照抄术语表既有定义）**：全集合快照、缺失即删除；差异按新增/更新/删除拆分，逐行保留原 create/update/delete 授权语义与逐行审计；加载中的暂态空集合不能表示删除（前端闸门已有 `assertAggregateDraftReady`）。删行先于头更新（保留三份手写实现里同一条注释记载的对手/币种切换时序）。

**D5 ★ 快照冻结留在钩子**：各聚合的 `deriveChild(trx, ctx)` 钩子负责快照列、base_qty、图纸挂接复制——冻结列集在 14 个资源间差异过大（发货行 11 列订单快照 vs 委外发料 5 列），进 meta 会把 interface 撑肥。W0 落地的「物料口径 module」是这些钩子的公共实现。

**D6 ★ 编号统一走 `options.numbering`**：手写聚合现有 22 处 `numbering.assignedInTx` 手拼调用点，迁入时改由内核按 draft 全量派生 values（finance 三单据先例：键名天然一致后已可切换）。单号字节不变为验收项。

**D7 ★ 状态转移随波迁移**：order（audit/close/void）、reconciliation（changeState + invoiceState）、demand、BOM 启停、work-order 作废这 5 处手搓循环，在各自资源波次里改声明 `transitions`；效果（占量、倒写安排、级联删派生草稿）原样进 `effect`/`after` 钩子。发票↔对账互锁（`invoiceState`）语义逐字冻结。

**D8 ★ 路由与 wire 冻结**：草稿端点三连（GET `:id/draft` / POST / PUT `:id`）与全部现有 URL、DTO、错误 code/文案字节不变（决策日志纪律照旧：变更必须记行）。web `hc` 类型链不动。

**D9 ★ 质量闸门沿用过夜迁移打法**：红测试 = 显式决策点；每波收线跑「判官」对抗评审（上一轮它抓出了内核丢写缺陷）；决策日志续记在 `docs/migration/` 新文件。

**D10 ？ 领域基元的落点**：物料口径 / 仓库校验 / 受控投影三个 module 放 `platform/posting/` 扩容（先例：posting 本就是跨域单据共享层，`accountCurrencies` 已在此收口）还是新开 `platform/domain-primitives/`。倾向前者（不新增顶层概念）；W0 首日定名。注意 `模块结构.md` 铁律：platform 不 import domain——三个基元自带 SQL（同 numbering 对 sys_ 表的先例），不引用模块代码。

**D11 ？ 受控投影累加器的循环依赖解法**：现 3 处 `await import('~/modules/manufacturing/arrangement.ts')` 绕环。建议累加器收 `afterAdjust` 回调参数、由组合根注入安排重算，实现处不再知道 manufacturing。W0 拍板。

**D12 ★ work-order 子行的形态**：不做完整聚合草稿。头 standard + `*InTx`；void→workflow（级联/占量进 effect）；配料/路线/副产品仅 BOM 整包快照助手（`copyBomSnapshot`/`clear`），不进 child/aggregate/CASES。`applyBom`/`createInlineBom`/`generateMaterialDemand` 保持手写编排。定案见 `docs/migration/aggregate-kernel-decisions.md` D12。

---

## 三、分波实施

> 波与波之间独立合并（各自 PR），任一波可整体 revert；「派生与手写对路由不可区分」保证逐动作弹射的逃生舱全程可用。

### W0 · 前置减重（候选 3）——不动 wire，纯内部收口

| 工单 | 内容 | 验收 |
|---|---|---|
| T0.1 | 物料口径 module：合并 `trading/common.ts:87-157`、`inventory/helpers.ts:84-151`、`manufacturing/helpers.ts:77-127` 三份 base_qty 折算+物料快照（同一 SQL join、同一报错文案、6 位小数一处定义） | 三处调用点机械替换；报错文案字节不变 |
| T0.2 | 仓库校验 module：6 份实现（叶子/同司/启用/外协绑定）收一，20 个调用点替换 | 同上 |
| T0.3 | 受控投影 module：5 个增量累加器（已发/已收/已对账/已安排/工单入库）收一——排序锁、FOR UPDATE、负数守卫、容差闸门内置；`afterAdjust` 回调解掉 3 处动态 import（D11）。重算式投影（arrangement recompute）保持独立不并 | 并发/负数/容差既有测试全绿 |
| T0.4 | 杂项：`lowerParty` ×3、`runeLen` ×4、`withIndexedFields` ×3 收口（后两者从内核导出） | typecheck 挡漏 |

规模：一个专注会话（或半个过夜）。预计净删 ~1,200 行。

### W1 · 内核三能力 + 合同测试（候选 1 的地基）

| 工单 | 内容 | 验收 |
|---|---|---|
| T1.1 | root/child 服务动作族 `*InTx` 变体（D1） | v2 合成资源测试：外层事务回滚则全链无痕 |
| T1.2 | 孙级子行（D3）：parent 链声明 + 装配期断言 | v2 测试：孙级 CRUD、越母单 not_found 语义与 `invMaterialUnits` 先例一致 |
| T1.3 | `platform/standard/aggregate.ts`：聚合描述符 → `loadDraft`（repeatable-read 一致快照）/`createDraft`/`replaceDraft` 派生；D4 语义；`options.numbering` 接入（D6） | v2 合成聚合全套 |
| T1.4 | 聚合合同套件（一次编写全站摊销）：整单原子性（任一行失败全败）、缺失即删除、暂态空集不删、逐行审计三型、越权 fail-closed、无差异不落库、公司创建后不可改 | CASES 描述符机制同 `standard-contract` |
| T1.5 | `extraWhere`（list/load 行筛选谓词）：顺带解锁 `accGlJournals`/`mfgOutputs`/`accBills` 三处 list 弹射 | 三处弹射改描述符；可见性语义测试冻结 |

规模：1–2 个专注会话。内核预计 +800~1,000 行（含测试）。

### W2 · 试点：报价单（两侧）+ 采购入库

选它们开局的理由：报价单 CRUD/workflow 已在内核，只差聚合 create/update 与孙级价格档——增量最小、孙级能力首消费者；采购入库是最简单的 2 层聚合（78 行 replace）。

每资源固定动作（此后各波同）：
1. 描述符 + 钩子迁移（`deriveChild` 用 W0 基元）；
2. 手写草稿/子行 CRUD 删除；
3. wire 冻结断言 + E2E 冒烟；
4. 聚合 CASES 加行；
5. 决策日志记行（如有行为变更）；
6. 判官评审。

验收目标：`quotation/service.ts` 1,799 → ≤600 行；`fulfillment/service.ts` 采购入库段收缩过半。

### W3 · 订单 + 销售发货 + 对账（trading 主力）

- 订单：聚合草稿 + 委外侧树保留 `OutsourcedDraftPort` 端口原样挂钩子；audit/close/void 迁 workflow（D7），审核时报价复核/占量进 effect。
- 销售发货：3 层平行子树（条目 + 装箱箱→装箱行，孙级能力第二消费者）；金额分摊、装箱相等校验留钩子。
- 两侧对账：双状态机（常规/赠样）迁 workflow 双 transitions；`invoiceState` 互锁逐字冻结；条目聚合化。

验收目标：`order/service.ts` 1,988 → ≤800；`fulfillment/service.ts` 2,105 → ≤800；`reconciliation/service.ts` 1,531 → ≤700。

### W4 · 委外（最大单文件）

`outsourced/service.ts` 2,894 行：发料/入库两聚合 + 四类子行（171/245/181/181 行的四段同构 CRUD 全删）；三向收料（成品入/材料扣/副产物入）与 `carryReceiptChildren` 留钩子；posting skeleton 仅存的 4 个调用点在此波清零。

验收目标：2,894 → ≤1,100 行；skeleton 活函数吸收、`shapes.ts` 与死代码删除（候选 2 收尾）。

### W5 · manufacturing 四资源

- demand：聚合 + workflow（确认占量、下游拦截进 effect）；
- BOM + 工艺模板：3 子表/1 子表聚合，启停迁 workflow；
- work-order：按 D12 评估后定形态（快照复制、作废级联留钩子/after）。

验收目标：`master-service.ts` 1,710 → ≤700；`demand-service.ts` 1,378 → ≤600；`work-order-service.ts` 1,262 → ≤700。

### W6 · 前端半边（候选 5，W2 起可与后端并行推进）

| 工单 | 内容 |
|---|---|
| T6.1 | 草稿 Adapter 工厂：6 个各 ~23 行的 GET/POST/PUT 三连收成一个工厂（端点形状随后端各波统一后逐资源切换） |
| T6.2 | `persist*` 收编：15 个删缺失→建新增→改变更循环 + 8 份 `itemChanged` + 18 个 COMPARE_KEYS 收进工厂（暂无整单替换端点的资源先统一 diff 循环于一处，后端波次到位后切 replaceDraft） |
| T6.3 | `useDocumentDrawer` 全覆盖：15 个手写装载器（`-stock-doc.tsx` 的手写状态机、`expense-reports`/`counts`/`transfers` 的 useState 三件套等）退役；13 份 Context/Provider 样板收进骨架 |
| T6.4 | 顺手项：4 个 standalone 呈现扩展的 `submit*Form` 改用 `require-writer.ts`（38 处已用，这 4 处漏网） |

验收：前端 typecheck+test+E2E 全绿；预计净删 ~2,500 行。

### W7 · 收尾与文档

- 决策日志收线汇总；判官全量终审。
- ADR ×2：「聚合单据内核」（D1–D12 定案）+ 补记「放弃 Convex 迁移」（PR #45/#46 → 01dd2960，防止重议）。
- 术语表：新词条「聚合单据描述符」；「聚合草稿 Adapter」词条补一句内核派生来源。
- `资源接入.md` 第 4 步更新（聚合资源接入法）；`模块结构.md` 补 aggregate 段。

---

## 四、风险与对策

| 风险 | 对策 |
|---|---|
| 丢写级缺陷（内核上次的判官级缺陷有先例） | 合同测试先行（W1 先于一切迁移）；红测试=决策点；每波判官对抗评审 |
| wire 兼容破坏 web hc 类型链 | 路由全程手写不动；URL/DTO/错误码字节冻结断言；每波 E2E 冒烟 |
| 审计语义漂移（逐行审计、snapshot 走 toDbValue 的大小写类差异） | 合同套件钉死逐行审计三型；差异必须进决策日志（先例已有成熟处理） |
| 锁序/事务边界变化引入死锁 | 保持 parent→child 锁序（child.ts 既有）；W0 投影 module 集中排序锁；v2 并发测试 |
| 范围蔓延进过账效果 | 钩子纪律铁律：聚合草稿只管持久化，效果只在 transition effect；计划非目标节明文 |
| 波次做大失控 | 每波独立 PR、可整体 revert；逐动作弹射逃生舱全程可用 |

---

## 五、度量（前后对比可验证）

| 指标 | 现状 | 目标 |
|---|---|---|
| 内核派生 service | 31/105 | ≥45/105 |
| 11 个最大手写 service 行数 | 15,920 | ≤7,000 |
| 手写审计 snap 函数 | 44 | ≤10（非聚合区残留） |
| 子行 CRUD 手写行数 | ~4,000–5,000 | ~0（聚合区） |
| posting skeleton + shapes | 790 行（240 死代码） | 0 |
| 前端 persist*/itemChanged | 15 / 8 份 | 1 / 1 |
| 聚合合同 CASES | 0 | 14 |
| 预计净删（两侧合计） | — | −9,000 ~ −12,000 行（内核 +~1,000） |

工期参照：上次过夜迁移一晚完成内核 v2 + 21 资源。本计划 W0+W1 约 1–2 个专注会话；W2–W5 各 1 个会话或合并 1–2 次过夜跑；W6 可并行；全程约 2–3 次过夜跑 + 少量白天收线。

---

## 六、开局指令（W0 启动时可直接粘贴）

> 按 /tmp/aggregate-kernel-plan-20260807.md 的 W0 执行：在 worktree 里落地三个领域基元 module（落点先按 D10 拍板并记决策日志），机械替换全部调用点，报错文案与 wire 字节不变，跑全量测试后提 PR。红测试一律停下来按决策日志纪律记行再改。
