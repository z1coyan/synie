# Plan 005: 按事务闭包迁移全部业务域

> **执行者说明**：按“事务闭包”而不是按单张表迁移。每一波都必须完成 schema、mutation、
> query profile、Catalog、ResourceBinding、测试与 convex-mode E2E，才可标记完成。禁止双写、
> 禁止在一个命令中跨 legacy/Convex。遇到 STOP 条件立即报告。
>
> **漂移检查（首先运行）**：
> `git diff --stat 2da55d9..HEAD -- convex server/src/modules server/src/platform server/src/engines web/app/lib/resources web/app/routes packages/shared CONTEXT.md docs/产品文档 docs/adr .scratch/ts-backend-rewrite .scratch/resource-catalog`
> 若有变化，先对照“当前状态”和迁移 manifest；任何资源/事务边界变化均为 STOP 条件。

## 状态

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/004-port-ledger-inventory-and-projections.md`
- **Category**: migration
- **Planned at**: commit `2da55d9`, 2026-07-31

## 为什么要做

本仓库不是薄 CRUD：72,403 行现有后端生产 TypeScript 中有 279 个 `withTx` 调用，销售、采购、
库存、总账、制造、HR 通过跨表投影和状态机相连。按 HTTP endpoint 或 SQL table 逐个切会制造
无法原子跨越的半迁移状态。本计划沿用上一轮重写已经验证过的业务依赖顺序，把每个强关联
事务闭包完整搬到 Convex，并利用现有 ResourceBinding 只替换 transport，不重写 UI。

## 当前状态

- `.scratch/ts-backend-rewrite/spec.md:9` 明确“未上线、无生产数据、无双活/兼容义务、开发库可
  reset”；`81-86` 明确业务规则不变、不做双活/灰度。
- 同 spec `57-76` 已给出经过一次完整后端重写验证的依赖顺序：平台/base/IAM → GL/库存 →
  库存/会计/销售/采购 → 对账/发票/制造/HR/行情 → setup/web/清场。
- SQL 当前有 105 tables、319 foreign keys、77 checks、70 unique indexes；Plan 003 manifest 必须
  对每项给出 Convex disposition。
- Resource Catalog 基线为 97 resources、1383 fields、307 actions、53 declared commands。
- `docs/adr/2026-07-31-frontend-deep-module-seams.md:41-56` 规定完整单据只经业务
  `AggregateDraftAdapter` 保存，后端必须在单事务内 load/create/replace；客户端循环保存不等价。
- 同 ADR `122-125` 已列出六个聚合头：`purOrders`、`purQuotations`、`purReceipts`、
  `salDeliveries`、`salOrders`、`salQuotations`，普通 writer 不暴露 create/update。
- `server/src/modules/trading/posting.ts:113-224` 证明履约审核/作废跨业务投影、库存、GL、状态、
  audit 是一个事务闭包。
- `CONTEXT.md` 与 `docs/产品文档/` 是业务行为权威；技术迁移不得顺手“简化”状态机、快照、
  权限或金额规则。
- 当前测试约 14,195 行，旧 service/engine/PG integration tests 是行为 oracle。应移植断言，
  不逐行翻译 Kysely。

## 需要使用的命令

| 用途 | 命令 | 成功预期 |
|------|------|----------|
| Manifest | `bun run check:convex-manifest` | 105 tables、97 resources 全覆盖 |
| Convex tests | `bun test convex` | 全部通过 |
| 真实集成 | `bun test convex/test/self-hosted.integration.test.ts` | 全部通过 |
| Web tests | `cd web && bun test` | 全部通过 |
| Web build/type | `cd web && bun run check && bun run build && bun run typecheck` | exit 0 |
| E2E | `cd web && VITE_SYNIE_BACKEND=convex bun run e2e` | 全部通过 |
| Legacy oracle | `bun run test` | 旧测试仍全绿，直至 Plan 008 |

## 范围

**范围内：**

- `convex/domains/{base,iam,party,accounting,inventory,trading,finance,manufacturing,hr,market,todo}/**`
- `convex/schema.ts` 对应业务 tables/indexes/search indexes/projections
- `convex/setup/**` 的完整初始化、基础 seed、sample data
- `convex/catalog/**` 的其余资源声明和 query profiles
- `convex/migration/**` manifest/constraint/test coverage 状态
- `packages/shared/**` 中真正跨前后端的纯 contracts/codecs；禁止塞 DB service
- `web/app/lib/resources/**` 对应 Convex Reader/Writer/Draft/Command adapters
- `web/app/routes/**` 只做 transport/ID/cursor 接线，不重写产品 UI
- 现有/新增 unit、model、self-host integration、Playwright tests
- 每波次对应 ADR；业务行为有变化时同步 `CONTEXT.md` 与相关 `docs/产品文档/*.md`
- `advisor-plans/README.md` 状态

**范围外：**

- 产品文件、导入字节、OCR、行情网络调用/cron 的 action 实现（Plan 006）；业务域只依赖其明确 port。
- PDF worker（Plan 007）。
- 删除 legacy server/REST/SQL（Plan 008）。
- SQL→Convex 生产数据导入、CDC、双写、逐请求 fallback。
- 把所有业务资源收进通用 CRUD/通用 document 状态机。
- 改动产品规则以迁就实现；遇到 mutation limit 应 STOP 做决策。

## Git 工作流

- 分支：`advisor/005-convex-business-domains`
- 每个下述 wave 至少一个独立 commit；更推荐每个事务闭包一 commit。
- 提交示例：`feat(convex): 迁移销售订单事务闭包`。
- 任一 commit 都必须 typecheck/test green；不 push、不开 PR。

## 步骤

### Step 1: 从调用图生成事务闭包和波次闸门

在 Plan 003 manifest 上新增 `transactionClosure`、`dependsOnClosures`、`portedTests`、
`frontendRoutes`、`filePortRequired`、`printBuilderRequired` 字段。以以下证据构图：

- `withTx` 调用及传入的 service/engine；
- SQL FK/unique/check；
- `CommandSpec.affectedResources`；
- Aggregate Draft head/items/subtrees；
- product docs 中“审核/确认/作废同时…”规则；
- setup/sample seed 顺序。

生成 DAG 并 fail CI：closure 内任一资源不得单独标 `convex-verified`；循环依赖必须合并成一个
closure，不能靠 runtime 跨后端调用解环。

**Verify**：`bun run check:convex-closures` → DAG 无未解释 cycle，每个写 resource 恰属一个
closure，279 个非测试生产源码 `withTx` 调用点都有目标 mutation/closure/test disposition。

### Step 2: Wave A——平台主数据、IAM 与 Party

迁移后续所有业务依赖的闭包：

- system settings、业务 settings、companies、currencies、units、accounts；
- roles、role permissions、user-role、user-company（principal/Actor 已在 Plan 002）；
- customers、suppliers、employees/party reference；
- numbering rule resource、audit read resource（write engine 已在 Plan 004）；
- todos 的基础数据结构可先建，触发规则放对应业务 wave。

保留：公司数据范围、角色启用即时生效、科目树/角色/币种约束、公司创建的关联 seed、主数据
删除限制。所有 read 用 query profile；所有 FK label 由目标 resource lookup profile 提供。

**Verify**：Wave A 的旧 service tests 全部映射；受限公司用户无法通过 get/list/lookup/command
穿透；20 并发 unique create 只有一个成功；convex-mode 基础资料与系统管理 E2E 全绿。

### Step 3: Wave B——手工会计与库存单据

在 Plan 004 engines 上迁移：

- manual GL journal + lines 的 draft/audit/reverse/cancel；
- stock doc + items；
- stock transfer + items（draft→shipped→received）；
- stock count + items（snapshot/refresh/audit/void）；
- inventory balance/entry read models 与来源单据 preview。

每个 aggregate draft 都必须显式提交完整 subtree，missing collection fail-closed；loadDraft 在一个
Convex query snapshot 中完成。审核/作废直接调用同一 mutation context 的 engine helper，不得
`runMutation` 嵌套。库存盘点“快照后仓库有 movement 则拒绝”用稳定 warehouse revision 文档实现，
不要扫描事实。

**Verify**：覆盖所有状态 transition、失败全回滚、库存 concurrency、as-of、来源速览权限；
Wave B 的页面无 `/api/v1/accounting|inventory` 请求。

### Step 4: Wave C——报价、订单、履约与对账强关联闭包

按依赖顺序迁移，不能把 head/items 单独切：

1. sales/purchase quotations + tiers；
2. sales/purchase orders + items、issue/byproduct subtrees；
3. sales delivery + items + pack boxes/lines；purchase receipt + items；
4. outsourced issue/receipt + material/byproduct lines；
5. sales/purchase reconciliation + items；order-flow read projections。

必须保留六个已证明 Aggregate Draft seam；新增/替换草稿的 create/update/delete permission 按实际
diff 校验。履约审核/作废把受控投影、库存、可选 GL、状态、audit 同 mutation。快照字段永远从
单据行读，不在展示时 fallback 到已变化主数据。

**Verify**：每个 closure 执行 draft→audit/confirm→void/reverse 全流程和逐阶段故障注入；销售
发货/采购入库的 inventory+GL+数量投影与 head 同提交；对账消费/释放数量 model-based 对拍。

### Step 5: Wave D——发票、银行、票据与费用报销

迁移：VAT invoice、bank account/transaction/reconciliation、bill/holding/transaction、expense
report/items，以及关联的应收应付 read projections。文件解析/OCR 通过 Plan 006 port 调用；在
Plan 006 未完成时只用 deterministic fixture，不建立假 production fallback。

发票审核/红冲/作废与 GL、对账单状态、对向发票关系必须同 mutation；银行快速对账跨域 seam
沿用“调用方业务 capability 覆盖、被调 seam 不重复鉴权”的现有约定，并用类型/注释标记。

**Verify**：旧 finance/accounting PG tests 全映射；金额/税额/party projection 从 facts 对拍；
OCR/导入 port 的 success/failure/idempotency contract tests 通过；财务页面 convex-mode E2E 全绿。

### Step 6: Wave E——履约需求、制造、HR、行情与待办

按 `.scratch/ts-backend-rewrite/spec.md:68-74` 的依赖迁移：

- demand + items + arrangements；work orders + BOM snapshot subtrees；production outputs；
- BOM/components/routes/byproducts、operations/process templates；
- HR employees、attendance imports/punches/days/corrections、payroll/payments/loans；
- market instruments/points/settings/result data；
- todo rules/state；完整 setup/sample data。

生产工单/采购/委外对 demand arrangement 的倒写，生产入库对 inventory 与 demand completion 的
倒写，必须在同 mutation closure。行情 fetch、attendance large import 与 cron 由 Plan 006 action
分块，但每一块写入仍走本域 internal mutation 和 idempotency key。

**Verify**：需求超安排、工单多批、BOM snapshot、生产入库、考勤100k staging contract、工资
发放/借款、行情 decision/todo 圈人规则的旧测试全映射；convex-mode 对应 E2E 全绿。

### Step 7: 为所有资源接上 Convex ResourceBinding

每完成一个 closure：

- 注册 Reader/Writer/Draft/Command 的真实能力，unsupported 方法在类型上缺席。
- Catalog query profiles 与 schema indexes 对拍；页面不手写 Convex API function、query key 或
  transport id。
- `CommandSpec.affectedResources` 保留精确 effects；Convex subscription 已实时更新也不能删掉
  command 语义依赖测试。
- Presentation Extension 继续与业务模块共置；附件/OCR port 只经 `~/lib/files`/domain adapter。
- 在 convex mode 仅开放 closure 已全部 verified 的菜单；未知资源 fail-closed。

更新 ResourceBinding interface test：目标不是“96 个到 REST”，而是 manifest 中所有 active
资源恰有一个 Convex binding；`sysStorages` 由 Plan 006 retired 后不在 active denominator。

**Verify**：`bun run check:convex-bindings` → active resources 与 bindings 1:1，53 command declarations
全部有 adapter，六个 aggregate heads 只有 draft create/replace，0 REST fallback。

### Step 8: 完成 setup、sample data 和整链 E2E

在**全新** self-hosted deployment（不要导入旧 SQL）运行：

1. setup 首管理员、公司、币种、单位、科目/角色/编号规则、三仓 seed；
2. sample data，重复执行按现有语义幂等或明确 conflict；
3. 报价→订单→需求/采购/制造→发货/入库→对账→发票/报销→GL/库存报表；
4. 受限 actor 的公司与 capability 反向测试；
5. restart backend 后继续查询/command。

比较旧 E2E 的业务结果快照（不比较 UUID、时间戳、SQL 顺序）与 Convex 结果；差异必须映射为
已批准产品变更，否则修复。

**Verify**：全 convex-mode Playwright、self-host integration、manifest、typecheck 全绿；网络检查
业务请求为 Convex，不出现 `/api/v1`。

### Step 9: 冻结迁移矩阵并准备清场 gate

把 97 resource/105 table 全部置为 `convex-verified`、`projection/merged` 或有批准理由的 `retired`；
每项附测试、query profile/index、binding、产品文档链接。生成 Plan 008 可消费的 JSON report，
任何 `legacy|implementing|planned-*` 状态使清场失败。

**Verify**：`bun run check:convex-cutover-readiness` exit 0，报告：0 legacy resource、0 unexplained
table/constraint、0 REST binding、0 cross-backend closure、0 unmapped legacy behavioral test。

## 测试计划

- 每个 closure：happy path、每个状态错误、权限/公司、唯一/FK/check、故障注入全回滚、幂等。
- Aggregate Draft：完整 load、缺集合 fail-closed、create/update/delete diff 权限、并发 replace。
- Engine integration：所有有库存/GL 后果的 command 对事实与 projection 对拍。
- 查询：所有 profile/index/cursor，不允许 `.filter()`/collect fallback。
- UI：96 基线 binding（减 retired、加新增）能力对拍、53 commands、六 aggregate drafts。
- 全链：setup/sample 与跨域业务流程；legacy 只作 oracle，不在线双写。

## 完成条件

- [ ] 97 resources 与 105 tables 全有最终 disposition，0 legacy/implementing。
- [ ] 279 个非测试生产源码 `withTx` 调用点全部映射为 Convex mutation closure/test 或明确淘汰理由。
- [ ] 所有业务写遵守 Actor/permission/company、decimal、audit、numbering、engine 边界。
- [ ] 六个 aggregate drafts 和所有新聚合单 mutation 保存。
- [ ] 53 declared commands 全有 Convex adapter，无 REST fallback。
- [ ] 旧行为测试全部映射；Convex unit/self-host integration/Playwright 全绿。
- [ ] 全新 deployment 可完成 setup 和整条 ERP 流程，backend restart 后状态正确。
- [ ] 产品规则无未批准差异；必要 ADR/产品文档/CONTEXT 同步。
- [ ] readiness report exit 0；范围外无改动；计划索引 DONE。

## STOP 条件

- 一个事务闭包必须跨 legacy 与 Convex 才能工作。
- 任一合法聚合超过单 mutation 实测 limits，且无法在不改变业务原子性的情况下重构。
- 为迁移资源需要放宽权限、公司范围、FK/check/unique 或状态机。
- 旧代码、产品文档、CONTEXT 对同一规则冲突，无法由现有测试判定权威。
- query 只能全表 scan 或任意动态 sort 才能保持产品行为。
- 文件/OCR/外部 action port 的缺失被生产 fake/no-op 掩盖。
- 需要生产 SQL 数据同步/双写（这违背已知未上线前提，先确认前提是否变化）。
- 当前代码/manifest 与计划基线漂移。

## 维护说明

- 后续业务功能以 transaction closure 为代码与测试单元；不要恢复“route 调多个 mutation”的浅编排。
- 每加表/resource/command，都同时更新 manifest；CI 的 1:1 coverage 是防止下一次迁移/清场漏项的资产。
- legacy tests 在 Plan 008 删除前保持绿色；删除后保留已经移植的行为断言，不保留对 SQL 形状的测试。
- Convex subscription 不替代明确的业务 read model；跨域列表仍应由拥有者维护的 projection/query
  提供，不能在前端 join 多个实时 query 拼业务事实。
