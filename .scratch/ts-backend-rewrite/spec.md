# Go → Bun/TS 后端重写（ts-backend-rewrite）

## 背景

Elixir→Go 迁移（2026-07-26 完成）后，决策层要求后端整体改用 TypeScript：全栈单一语言、
团队 TS 能力集中、前后端共享类型与工具链。2026-07-28 完成技术评估（Kysely / hono client /
纯 Bun 栈定案），同日由本会话完成 **monorepo 重构 + 平台层骨架**，本目录工单承接剩余业务层重建。

**部署前提（沿用 R3 定案）**：系统未上线，无生产数据，无双活/兼容义务；开发库可随时 reset。

## 技术栈定案（本次新增决策）

| 关注点 | 定案 | 否决/备选 | 理由 |
|--------|------|-----------|------|
| 运行时 | **Bun**（唯一运行时，禁止引入 Node 专属依赖） | Node LTS / Deno | 与 web/ 工具链统一；`Bun.password`/`Bun.serve`/`Bun.file` 原生能力足够 |
| HTTP | **Hono** + `@hono/zod-validator` | NestJS（重 DI 与现有显式服务风格冲突）、Fastify（生态可但 hc 类型链不如 Hono 一体） | 链式路由 → `ApiType` 类型推断 |
| 契约 | **hono/client（hc）**：`src/app.ts` 的 `ApiType` 为类型事实源 | 继续 OpenAPI codegen | 契约即代码；**wire 形状（URL/JSON/错误文案）与原 OpenAPI/Go 保持一致**——551 端点行为不变，仅类型来源变化 |
| 数据层 | **Kysely** + postgres.js（方言包 `kysely-postgres-js`） | pgtyped（维护活跃度一般）、Drizzle/Prisma（自带迁移体系，与 SQL 迁移冲突） | 类型安全 query builder + 显式 SQL 可控；类型由 kysely-codegen 从迁移后开发库生成 |
| 迁移 | `server/db/migrations/*.sql`（与 server-go 同源）+ `db/migrate.ts`（Bun，只跑 `-- +goose Up` 段） | 继续 goose CLI / node-pg-migrate | 纯 Bun；SQL 文件零改动复用 |
| 认证 | **Bun.password（argon2id）+ hono/jwt（HS256）** | Better Auth（自带 schema 与 sys_user/权限模型冲突）、@node-rs/argon2（Node napi） | PHC 串与 Go 种子哈希互通；登录限流单进程 10 次/5 分钟 |
| 金额 | `@synie/shared` decimal（decimal.js，half-up；金额 2/单价 4/数量 6 位，wire 字符串） | number（丢精度，红线） | 与 Elixir/Go 两版舍入口径一致 |
| 测试 | `bun test`；PG 集成门控 `SYNIE_TEST_DATABASE_URL` | vitest/jest | 与 Bun 一体；门控惯例同 server-go |
| 打印（工单 15） | zip+XML 最小侵入手术（JSZip/fflate + fast-xml-parser） | exceljs（重写整个 workbook 丢样式） | 对齐 Elixir/Go 渲染器语义 |

## 架构与骨架现状（2026-07-28 已交付并验证）

**Monorepo**：根 `package.json` Bun workspaces（`packages/*` + `server` + `web`，isolated 安装）；
`server/`（Go）改名 `server-go/` 作现行产品后端只读维护（同 `backend/` Elixir 先例）。

```
server/                       # @synie/server：目标后端
├── src/
│   ├── index.ts / app.ts / client.ts / env.ts
│   ├── platform/{http,auth,authz,meta}/     # 已实现：错误模型/zod 钩子/JWT/argon2id/
│   │                                        # 限流/Actor/权限通配/Registry+meta 端点
│   ├── platform/{audit,numbering,settings,files,printing,todo}/  # 骨架 README + 工单指针
│   ├── engines/{gl,inventory}/  # 骨架（工单 03）
│   ├── modules/                 # 业务域（本目录工单填充）
│   ├── db/{index,tx,filterbuild,types.d}    # Kysely 连接/事务约定/筛选构建器/生成类型
│   └── jobs/                    # 骨架（工单 14）
└── db/{migrations,migrate.ts,seed.ts,seed-admin.ts}
packages/shared/src/{decimal,error,filter,meta}.ts   # 前后端共享契约 + 单测
```

**已验证**（全部绿）：34 项单测、6 项 PG 集成（healthz/login/me/validation/meta/404）、
tsc 严格类型（真实生成类型）、migrate 全量迁移（101 表）、kysely-codegen 全量类型、
本地启动冒烟、Docker 镜像构建与容器冒烟、web tsc 无损、server-go 构建无损、CI（新增 server-ts job）。

**编码约定**（详见 `server/README.md`，工单执行必须遵守）：
1. **惯用 TS，拒绝 1:1 翻译**：server-go 是行为参考不是形态模板；模块用工厂闭包，禁 class（`ApiError` 除外）。
2. 金额只走 `@synie/shared` decimal；3. 事务接 `DbHandle`、边界归调用方 `withTx`，过账单事务；
4. 筛选只走 `filterbuild` 白名单；5. 错误 throw `ApiError`；6. 路由 `.route()` 链式 + `zValidator`（保 hc 类型链）；
7. 业务资源注册进 Meta Registry（权限/Grid/打印目录自动派生）；8. 用户可见文案中文。

## 工单一览（按依赖排序；验收锚点见各工单）

| # | 工单 | Blocked by | 验收锚点（verify 脚本） |
|---|------|-----------|------------------------|
| 01 | 平台层补全：settings/numbering/audit/files | 无 | verify-settings / verify-numbering |
| 02 | base 主数据 + IAM（用户/角色/公司授权/权限目录）+ 客商员工 | 01 | verify-system-ops / verify-party-employee |
| 03 | 事实引擎：GL + 库存 | 02 | 引擎不变量测试（配平/负库存/锁） |
| 04 | 库存单据（出入库/调拨/盘点/余额） | 03 | verify-inventory |
| 05 | 手工会计凭证 | 03 | verify-accounting / gl 契约 |
| 06 | 销售链（报价→订单→发货+装箱） | 03 | verify-quotation / verify-order / verify-fulfillment(standard) |
| 07 | 采购链（报价→订单→入库） | 03 | verify-quotation / verify-order / verify-fulfillment(standard) |
| 08 | 销售/采购对账 | 06, 07 | verify-supply-reconciliation |
| 09 | 发票（销项/进项/费用报销发票）+ 待办 | 08 | verify-finance-operations（发票段） |
| 10 | 委外（订单配置/发料/入库） | 07, 11 | verify-fulfillment(outsourced) |
| 11 | 制造（BOM/工艺/履约需求/工单/生产入库） | 03 | verify-manufacturing |
| 12 | 财务运营（银行/票据/报销单） | 05, 09 | verify-finance-operations |
| 13 | HR（员工档案/考勤导入/日考勤/工资/借款） | 02 | verify-hr-operations |
| 14 | 行情（品种/价点/取价/拉取调度 jobs） | 02 | verify-market |
| 15 | 打印引擎（模板管理/渲染/PDF/字段目录） | 01, 02 | verify-printing |
| 16 | setup 向导 + 全链示例数据 | 06, 07, 08, 10, 11, 12, 13 | setup e2e + demo 数据冒烟 |
| 17 | web 切 hono/client + Resource Client 改造 | 06–15（全部业务域 API） | web tsc + Playwright e2e |
| 18 | 清场切流：删 server-go/归档 contracts/CI 收敛/文档定稿 | 16, 17 | CI 全绿 + e2e 全绿 |

> verify 脚本在 `.scratch/migration/verify-*.ts`（独立 Bun 脚本，打活 API，`GO_API_URL` 指目标）。
> 各工单顺带把脚本 env 名泛化为 `SYNIE_API_URL`（保留 `GO_API_URL` 兼容对照 Go）。

## 非目标

- 不改变已定案业务规则（库存估值、行情挂钩定价等维持未定案现状）。
- 不做微服务拆分、不引入外部队列/Redis、不引入 Node 运行时。
- 不重写前端 UI（工单 17 只换传输层与 Resource Client 适配）。
- 不做双活/灰度切流（R3：未上线，测试绿即切）。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 金额精度纪律失守 | decimal 全部走 shared；评审红线；金额链 golden（contracts/fixtures 沿用） |
| `any` 渗漏（大体量 AI 生成） | strict tsconfig + `noUncheckedIndexedAccess` + tsc CI 门禁 + 评审 |
| 权限/公司隔离回归 | authz 语义已钉测试；权限矩阵规格随工单 02 移植；e2e 权限拒绝用例 |
| 打印渲染语义偏差 | 工单 15 以 server-go golden 测试对拍；禁换渲染思路 |
| hc 类型链断（路由非链式挂载） | README 约定 + 工单 DoD 含 `ApiType` 编译校验 |
