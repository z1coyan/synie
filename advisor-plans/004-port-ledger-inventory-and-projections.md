# Plan 004: 移植编号、审计、总账、库存与受控投影

> **执行者说明**：本计划处理财务 ERP 中风险最高的原子性与并发不变量。旧代码是行为 oracle，
> 不是应机械翻译的 SQL 形状。所有外部 I/O 均在范围外；核心链必须在单个 deterministic
> Convex mutation 中完成。逐步验证，遇到 STOP 条件立即报告。
>
> **漂移检查（首先运行）**：
> `git diff --stat 2da55d9..HEAD -- convex server/src/db/tx.ts server/src/engines server/src/modules/trading/posting.ts server/src/platform/numbering server/src/platform/audit packages/shared/src/decimal.ts CONTEXT.md docs/产品文档/总账财务.md docs/产品文档/库存物料.md docs/adr`
> 范围内有变化时比对下列摘录，不一致即 STOP。

## 状态

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/003-cut-over-resource-plane.md`
- **Category**: migration
- **Planned at**: commit `2da55d9`, 2026-07-31

## 为什么要做

库存不足、借贷配平、红冲/作废、编号唯一和审计同事务，是该项目不能退化的正确性核心。
Convex 的 serializable OCC 可以替代 PostgreSQL advisory/row lock，但前提是 mutation 读取并写入
稳定的冲突文档，且所有事实、投影、状态和审计同一次提交。本计划先把这些深模块做对，后续
销售、采购、制造、财务域只组合它们，不各自发明并发策略。

## 当前状态

- `server/src/db/tx.ts:4-33` 规定 `withTx` 是唯一 `TrxHandle` 来源，事实引擎写方法只收事务
  handle；“过账必须单事务”由类型强制。
- `server/src/modules/trading/posting.ts:113-189` 当前审核顺序为“投影 → 库存 →（金额>0）总账 →
  状态 → 审计”；`192-224` 作废按反向顺序在同一事务回滚。
- `server/src/engines/inventory/engine.ts:39-75` 校验并追加库存分录；`362-421` 先对
  `(warehouse, material)` 加 advisory transaction lock，再检查当前余额+delta 不得为负。
- `server/src/engines/inventory/inventory.postgres.test.ts:327-354` 已证明两个并发出库只有一个成功，
  最终余额为 0。该场景必须原样迁移为 OCC 集成测试。
- `CONTEXT.md:47,53` 规定：负库存按“叶子仓×物料”校验；库存分录是唯一事实、只追加，作废
  标记不删，数量为默认单位 6 位小数。
- `server/src/engines/gl/gl.postgres.test.ts:190-234` 覆盖 post→reverse 归零、重复红冲 conflict、
  cancel 幂等、借贷不平整单无事实。
- `server/src/platform/numbering/service.ts:290-373,505-514` 取号与业务写同事务；counter 以
  `(rule_id, scope_key)` upsert 自增。
- `packages/shared/src/decimal.ts:3-21` 规定 DecimalString、half-up、金额2/单价4/数量6位。
- Convex 官方保证 mutation 原子、serializable OCC，并自动重试 deterministic conflict：
  <https://docs.convex.dev/database/advanced/occ>
- 当前官方默认限制包括 query/mutation 用户代码 1 秒；单事务 16MiB read、16MiB write、
  32,000 scanned docs、16,000 writes。实现必须设计和测量预算，不靠调大 self-host knob：
  <https://docs.convex.dev/production/state/limits>

## 需要使用的命令

| 用途 | 命令 | 成功预期 |
|------|------|----------|
| Convex codegen | `bunx convex codegen` | exit 0 |
| 单元/模型测试 | `bun test convex/engines convex/platform` | 全部通过 |
| 真实并发测试 | `bun test convex/test/self-hosted-engines.integration.test.ts` | 全部通过 |
| 推送函数 | `bunx convex dev --once` | exit 0 |
| 全仓验证 | `bun run typecheck && bun run test` | 全部通过 |

## 范围

**范围内：**

- `convex/schema.ts` 中 numbering/audit/GL/inventory/projection tables 与 indexes
- `convex/platform/numbering/**`
- `convex/platform/audit/**`
- `convex/engines/gl/**`
- `convex/engines/inventory/**`
- `convex/engines/posting/**`
- `convex/lib/{mutationContext,budget,idempotency}.ts`
- 上述模块的 `convex-test` 与真实 self-host integration/load tests
- Plan 003 三个 pilot 的正式 audit hook 接线
- `convex/migration/**` 状态/约束映射更新
- `docs/adr/2026-07-31-convex-facts-and-projections.md`（新建）
- 只有业务规则实际变化时才改 `CONTEXT.md`/产品文档
- `advisor-plans/README.md` 状态

**范围外：**

- 销售/采购/制造/HR 等业务 document mutation；Plan 005 负责组合。
- S3、OCR、行情 HTTP、PDF、scheduler action。
- 把过账拆成 eventual-consistent 多个 mutation。
- 改变现有会计、库存、编号、审计业务规则。
- 删除旧引擎或 SQL tests。

## Git 工作流

- 分支：`advisor/004-convex-fact-engines`
- 编号/审计、库存、GL、posting/projection 各自逻辑提交。
- 建议提交：`feat(convex): 移植总账库存事实引擎`。
- 不 push、不开 PR。

## 步骤

### Step 1: 建立不变量与事务预算矩阵

从 SQL constraints、`CONTEXT.md`、产品文档、旧 engine/service tests 提取机器可读矩阵，至少含：

- operation（post/cancel/reverse/number/audit）；
- read set、fact writes、projection writes、head/status writes、audit writes；
- idempotency key 和合法重复调用结果；
- expected conflict/validation error；
- 最坏 document 数/字节预算计算公式。

在测试中固定现有错误码/关键中文 message，不固定 SQL 实现。每个旧引擎测试必须映射为
`ported test` 或带理由的 `not applicable`；不得静默遗漏。

**Verify**：`bun run check:convex-engine-matrix` → 旧 GL/inventory/numbering/audit 测试 100% 有映射，
每个写入口有预算公式和幂等策略。

### Step 2: 定义事实表和分层 projection schema

使用 Plan 003 的 scaled bigint/date/ID 纪律，建立：

- `stockEntries`：来源类型/id/no、公司、仓、物料、业务日、signed base qty、seq、cancel state。
- `inventoryCurrentBalances`：每 `(company, warehouse, material)` 一个稳定冲突文档。
- `inventoryDailyDeltas` + `inventoryMonthlyDeltas`：支持截至日；查询“历史完整月 + 当前月截至日”，
  不从头扫描所有事实。
- `glEntries`：voucher ref、公司、账户、币种、借/贷、party、posting date、reverse/cancel ref。
- `glAccountDaily/Monthly` 与 `glPartyDaily/Monthly`：只维护现有报表实际维度；禁止先建通用 cube。
- `numberingRules/counters`、`auditLogs`。

所有常用读取都先写 query profile/index；每个 balance/projection document key 用字段唯一 index，
不能靠拼接后不校验的字符串主键。事实 document 不嵌入无限增长数组。

**Verify**：schema/index 与 engine matrix 对拍；seed 10 年每日 movement 后 as-of query 扫描量仍受
“月桶+当月日桶”上界约束，不随事实总行数线性增长。

### Step 3: 移植编号与审计原语

编号：

- `nextInMutation(ctx, resource, values)` 读取 sealed Catalog 的编号字段解析规则。
- 以 `(ruleId, scopeKey)` index 读取/创建 counter，read→patch；依靠 OCC 串行冲突。
- counter 更新与最终单据写在同一 mutation，后续失败时 counter 也回滚。
- 20+ 并发调用不得重复；是否连续以**成功提交**为口径。

审计：

- `writeAudit(ctx, actor, event)` 只能接 branded domain mutation context，和业务写同事务。
- 保留 resource/record/action/company/changes；过滤 password、secret、内部 email、capability token、
  S3 credential。
- diff 为纯函数；单次 audit document 超过 size 阈值时写字段摘要/截断标记，不拆成异步漏审计。

把 Plan 003 pilot 的临时 hook 替换为正式 audit，manifest 状态改 `convex-verified`。

**Verify**：100 个并发取号得到 100 个不重复已提交编号；注入业务 validation 后 counter 不前进；
CRUD/permission change 生成 audit，secret 字段无论嵌套层级都不出现。

### Step 4: 以余额冲突文档实现库存 OCC

`postInventoryInMutation` 必须在同一 mutation：

1. 校验 voucher 和非空 lines，normalize/group delta；
2. 读取所有仓/物料，验证公司、叶子、存在性；
3. 按稳定 key 顺序读取 `inventoryCurrentBalances`；
4. 对不允许负库存的仓校验 `current + delta >= 0`；
5. 逐原始 line 插入事实（不合并事实语义）；
6. patch current、daily、monthly projection。

两个并发出库都读同一 balance document；OCC 使一个提交、另一个重试后看到新余额并 conflict。
不要模拟 advisory lock，也不要用全局 singleton lock 把无关仓物料串行化。

`cancelInventoryInMutation` 以 voucher index 读取 live facts；重复 cancel 成功且不二次反向 projection；
作废导致负库存时整单拒绝。所有 writes、projection、调用方状态、audit 最终同事务。

**Verify**：移植全部 inventory tests；至少 50 个并发相同 key 出库只允许库存覆盖范围内成功，
不同 key 可并发；任何失败后 facts/current/daily/monthly/head/audit 都完全不变。

### Step 5: 移植 GL post、reverse、cancel 与查询 projection

保留现有规则：借贷配平、正负/零值、公司/科目/币种、汇总/停用科目、往来科目 party 必填、
voucher 幂等/冲突、reverse 成对、cancel 幂等。金额运算全程 scaled bigint，显示时才转 DecimalString。

- `postGlInMutation` 先完成全部验证，再插事实并更新 account/party daily+monthly projection。
- `reverseGlInMutation` 插入反向事实并标记原事实关系；重复 reverse conflict。
- `cancelGlInMutation` 标记事实并反向 projection；重复 cancel no-op。
- 报表 query 只查 projection/有界 fact index；对 projection 结果提供从事实重建/对拍工具。

**Verify**：移植现有 GL tests；随机生成配平凭证和 post/reverse/cancel 序列做 model-based test，
每一步 projection 等于从 live facts 离线重算结果。

### Step 6: 建立单 mutation posting 编排与类型边界

把当前 `auditFulfillmentInTx` 语义重建为只接受 branded `DomainMutationCtx` 的纯 orchestration：

```text
load+validate draft → controlled projections → inventory → optional GL
→ head state/auditedBy/auditedAt → audit log → one commit
```

严禁 helper 内调用 `ctx.runMutation`、scheduler、action 或 fetch；嵌套 mutation 会破坏原子边界。
调用方提供 domain-specific collect/projection callbacks，但 callbacks 不能持有 ActionCtx。

加入 `assertMutationBudget(plan)`：在任何写入前按行数和各类 projection fan-out 计算预计 documents/
bytes，超过 Convex 实际上限时返回稳定 validation。阈值从官方/self-host smoke 测出的上限集中配置，
不在各业务域散落魔法数字。若这带来用户可感知单据规模上限，必须先更新产品文档。

**Verify**：故障注入在每个阶段抛错，断言 facts/projections/head/audit 全回滚；架构测试禁止
`convex/engines/**` 出现 `fetch(`、`scheduler`、`runMutation` 或 `"use node"`。

### Step 7: 增加 reconciliation、重建与性能门禁

提供仅管理员/internal 可运行的 projection verify/rebuild 工具：

- verify 分页扫描 facts，在 action 中分块计算，然后每块用 mutation 对拍；生产默认只读报告。
- rebuild 写新 projection generation，完成全量校验后单 mutation 切 active generation；不要边删边建
  让用户看到半状态。
- 每日/CI 小数据 verify；发布前真实 self-host 压测热点 warehouse/material、numbering scope、GL
  account，并记录 P95/冲突重试/transaction bytes。

压测优先调整数据冲突粒度和 query/index；只有证据显示服务并发不足，才按 Plan 001 runbook 调
`APPLICATION_MAX_CONCURRENT_*`。

**Verify**：故意破坏一个 projection，verify 精确报告 key；rebuild 后与 facts 100% 对拍；基准
fixture 下 mutation 不触及 transaction/time limits，P95 与阈值记录进 ADR。

## 测试计划

- 编号：并发唯一、scope/company、回滚不耗号、格式/字段 lookup。
- 审计：同事务、diff、敏感字段过滤、超大 changes。
- 库存：所有旧校验、同 key 并发、不同 key 并发、cancel 幂等/负库存、6 位精度、as-of。
- GL：配平、科目/party/currency、reverse/cancel、2 位精度、projection model test。
- Posting：每阶段故障注入、预算 preflight、零金额跳 GL 但保留其他副作用。
- Rebuild：损坏检测、generation 原子切换、10 年桶查询扫描上界。
- 同时跑 `convex-test` 和真实 self-host；并发/OCC 结论不能只靠 mock harness。

## 完成条件

- [x] 旧 GL/inventory/numbering/audit 测试全部映射并通过，无静默遗漏。
- [x] 同 key 库存并发只提交合法数量；无全局锁热点。
- [x] post/reverse/cancel 后 facts 与所有 projections 始终一致，可自动重建对拍。
- [x] 编号与业务同 mutation，并发不重复、失败不耗号。
- [x] audit 与业务同 mutation，敏感值不落库。
- [x] posting 链是一项 mutation；无 action/network/scheduler 嵌入。
- [x] transaction budget 在写前可计算，基准不超过 self-host 实测限制。
- [x] Plan 003 三个 pilot 使用正式 audit，manifest 为 convex-verified。
- [x] codegen/typecheck/tests/self-host integration 全绿，ADR 完成，范围外无改动。
- [x] `advisor-plans/README.md` 状态 DONE。

## STOP 条件

- 任一现有业务操作的最坏合法单据无法在单个 Convex mutation 限制内完成，且拆分会破坏原子业务
  语义；必须先做架构决策，不能擅自 eventual consistency。
- 负库存只能靠扫描全部 stock facts 才能判断，无法维护稳定 current balance 冲突文档。
- GL/库存 projection 无法从 facts 确定性重建或对拍。
- 需要 action/网络调用参与同一过账事务。
- scaled bigint 溢出或出现 float 金额/数量。
- self-hosted OCC 在真实并发测试中不能提供文档化的原子/serializable 行为。
- 当前规则/测试与摘录漂移。

## 维护说明

- 事实是权威、projection 是可重建加速层；每加一个 projection 都必须同时加更新、verify、rebuild
  三条路径，否则不接受。
- 热点冲突应按真正不变量 key（仓×物料、rule×scope）收敛；不要用更粗 singleton 省代码。
- 月/日桶改变是数据 migration；先新 generation 重建再切，不原地混用算法。
- 业务域只能通过 engine facade 写 facts，不得直接 `ctx.db.insert('stockEntries'|'glEntries')`；用
  架构测试长期守住。
