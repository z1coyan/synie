# 下一轮 Agent 提示词（Goal：用 Grok Build workflow 完成 Bun/TS 业务层重写）

把下面「复制区」整段粘贴给 Grok Build（建议直接要求其用 **create-workflow** 技能编排）。
仓库根目录：`/home/zyan/code/synie`。骨架已就绪并全绿（2026-07-28），本 prompt 承接业务层重建。

---

## 复制区开始

```
# Goal：按 .scratch/ts-backend-rewrite 的 spec 与工单，用 workflow 完成 Synie 后端的 Bun/TS 业务层重写

## 身份与硬约束
你是在 Synie ERP 仓库工作的实现型工程 agent 编排者。项目第一语言是中文文档；代码标识符英文。

**铁律（违反即返工）**
- 运行时只有 **Bun**：禁止引入 Node 专属依赖（runtime 依赖必须 Bun 原生可跑；dev 工具如 kysely-codegen 除外）。
- **惯用 TS，拒绝 1:1 翻译**：`server-go/` 是行为参考不是形态模板；模块一律工厂闭包（createXxx(deps)），
  禁 class（ApiError 除外）；严格 TS（strict + noUncheckedIndexedAccess），禁止 any 渗漏。
- **wire 形状不变**：URL/JSON/错误文案与 server-go、原 OpenAPI 完全一致（551 端点行为契约）；
  变化的只是类型来源（src/app.ts 的 ApiType → hono/client）。
- 金额只走 @synie/shared decimal（half-up；金额 2/单价 4/数量 6 位，wire 字符串）。
- 事务纪律：函数接 DbHandle；过账（审核/作废）单事务 withTx，经 engines 写分录；引擎/深模块禁自起事务。
- 筛选/排序只走 filterbuild（Meta 白名单+参数化）。
- 路由必须 .route() 链式挂载 + zValidator 输入校验（保 hc 类型链）；业务资源注册 Meta Registry。
- 小步绿测提交：每工单/子任务完成即 bun test + tsc 绿后提交；不 dump 无关大文件。

## 必读（按顺序）
1. `.scratch/ts-backend-rewrite/spec.md`（技术栈定案、骨架现状、工单 DAG）
2. `server/README.md` 与 `server/AGENTS.md`（编码约定）
3. `CONTEXT.md`（领域术语唯一来源）；实现触及域时再读对应 `docs/产品文档/*` 与 `docs/adr/*`
4. 行为参考实现：`server-go/internal/**`（只读，勿改）；验收脚本：`.scratch/migration/verify-*.ts`

## 环境
- `bun install`（仓库根）；`docker compose up -d postgres`（PG 在 localhost:5441）
- 测试库：`createdb synie_test` 后 `cd server && DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable bun run db:migrate`
- 全量测试：`cd server && SYNIE_TEST_DATABASE_URL=<同上> bun test`；类型：`bunx tsc --noEmit`
- 启动：`cd server && bun run dev`（8080；与 server-go 并用时 PORT=8081）
- verify 脚本：`SYNIE_API_URL=http://localhost:8081/api/v1 bun .scratch/migration/verify-<域>-rest.ts`
  （admin 种子：`bun run db:seed`，admin/admin123；脚本 env 名在工单 01 已泛化）

## 执行策略（workflow 编排）
用 create-workflow 技能编写 Rhai 脚本，按工单 DAG 分阶段，**并行扇出仅限相互无阻断的工单**：

- 阶段 A（串行打底）：01 平台补全 → 02 base 主数据+IAM → 03 引擎
- 阶段 B（并行，blocked by 03/02）：04 库存单据、05 手工凭证、06 销售链、07 采购链、11 制造、13 HR、14 行情、15 打印引擎(也只需 01,02)
- 阶段 C：08 对账（待 06+07）
- 阶段 D（并行）：09 发票+待办（待 08）、10 委外（待 07+11）
- 阶段 E：12 财务运营（待 05+09）
- 阶段 F：16 setup 向导（待业务链齐）
- 阶段 G：17 web 切 hc（待全部业务 API）→ 18 清场切流

每工单一个子 agent（或复杂工单拆 2 个：实现 + 验收修复）；每阶段结束跑**验证面板**：
`bun test`（含 PG 集成）+ `tsc --noEmit` + 该阶段工单对应的 verify 脚本（打活 API）。
agent_budget 建议 48–64。工单文件即任务卡：先读 issues/NN-*.md 全文再动手；
完成后在工单 `## Comments` 追加一行结果（完成内容/验证证据/遗留），不要把 Status 改成非约定词。

## 每工单 Definition of Done
1. issues/NN-*.md 的「验收」节全部满足（verify 脚本绿为硬性）
2. 新增/变更行为有测试：纯函数单测 + PG 集成（门控 SYNIE_TEST_DATABASE_URL）
3. meta 注册 + 路由链式挂载；`bunx tsc --noEmit` 绿（ApiType 不断链）
4. 用户可见文案中文；触及领域语义时同步 `docs/产品文档/` 与 `CONTEXT.md`
5. 工单 Comments 留痕；git 小步提交

## 明确不做
- 不改已定案业务规则（库存估值、行情挂钩定价维持未定案）
- 不引入 Redis/消息队列/微服务/Node 运行时/exceljs（打印用 zip+XML 手术）
- 不动 web/ UI（工单 17 才准碰，且只换传输层）
- 不做双活/兼容层（R3 未上线）；不重写骨架已交付的 platform/auth/authz/meta/db 基础设施
  （发现骨架缺陷可修，但须加测试并在工单 Comments 说明）

## 完成定义（Goal Done）
- 18 个工单全部验收绿；`.scratch/migration/verify-*.ts` 全套对 Bun server 绿
- CI（server-ts + frontend）全绿；Playwright e2e 关键路径全绿
- server-go 已按工单 18 清场；README/AGENTS/迁移记录定稿

## 第一步（立即执行）
1. 通读 spec 与工单 01–03；起 PG + 迁移测试库；把骨架测试跑绿确认基线。
2. 用 create-workflow 按上述阶段结构编写 workflow 脚本（先 validate_only 冒烟一条路径），
   确认无误后启动阶段 A；每阶段结束汇报验证面板结果再继续。
开始工作。遇到 spec 与代码冲突：领域语义听 CONTEXT/产品文档/ADR；栈与传输听本 Goal 与 server/README。
```

## 复制区结束

---

## 使用建议

| 场景 | 建议 |
|------|------|
| 全量编排 | 直接贴「复制区」，要求其 create-workflow 并启动 |
| 只做阶段 A 打底 | 末尾加：`本会话范围仅限工单 01–03，完成后停下汇报` |
| 断点续跑 | 开头加：`继续 Goal：当前已完成工单 01–0X，下一阶段从 0Y 开始` |
| 人工先行验证 | 先手动跑通「第一步」的环境基线再贴全量 |

**体量提示**：18 个工单覆盖 ERP 全域（参照系：server-go 手写代码 ~93k LOC）。
单次 workflow 运行 realistically 能完成阶段 A + 部分阶段 B；用「断点续跑」格式接力，
每阶段验证面板绿是继续的前提。
