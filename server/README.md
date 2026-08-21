# @synie/server — Synie Bun/TS 后端

Synie ERP 的**产品后端**：**Bun + Hono + Kysely + PostgreSQL**，与 `web/`（TanStack Start）
经 `hono/client` 共享全链路类型（契约即代码）。

- 领域语义唯一来源：`docs/术语表.md` + `docs/业务模块/` + `docs/系统架构/adr/`
- 历史 Go 栈见 git tag `server-go-final`

## 技术栈定案

| 关注点 | 选型 | 说明 |
|--------|------|------|
| 运行时 | **Bun**（唯一，不引入 Node 专属依赖） | `Bun.serve` / `Bun.password` / `Bun.file` |
| HTTP | **Hono** + `@hono/zod-validator` | 路由链式定义，类型供 `hc<ApiType>` 推断 |
| 客户端契约 | **hono/client（hc）** | `src/app.ts` 的 `ApiType` 是契约事实源 |
| 数据层 | **Kysely** + postgres.js（官方 PostgresJSDialect） | 纯 JS 驱动，Bun 原生；类型由 kysely-codegen 从迁移后开发库生成（`bun run db:codegen`，生成物提交） |
| 迁移 | `db/migrations/*.sql` + `db/migrate.ts` | 纯 SQL，每文件一事务，advisory lock 串行；无回滚，未上线期改历史即压平重建 baseline |
| 认证 | **Bun.password（argon2id）+ hono/jwt（HS256）** | PHC 串互通；登录限流单进程 10 次/5 分钟 |
| 金额 | `@synie/shared` decimal（decimal.js，half-up） | wire 一律字符串；金额 2 位 / 单价 4 位 / 数量 6 位 |
| 测试 | `bun test`；PG 集成测试门控 `SYNIE_TEST_DATABASE_URL` | 未设则集成用例 Skip |

## 常用命令

```bash
bun install                 # 仓库根（workspace 安装）
bun run dev                 # 开发（--hot），需先备好 .env 见 .env.example
bun test                    # 单测；设置 SYNIE_TEST_DATABASE_URL 后含 PG 集成
bun run typecheck           # tsc --noEmit
bun run db:migrate          # 执行 SQL 迁移（DATABASE_URL）
bun run db:seed             # 可选：幂等管理员（admin/admin123）；常规用初始化向导
bun run db:reset            # 开发库复位到未 setup（仅本地/dev DSN）
bun run db:codegen          # 从开发库重新生成 src/db/types.d.ts
```

## 目录

```
src/
├── index.ts            # 入口：env → db → auth/registry → composition 装配 → Bun.serve
├── composition.ts      # 服务装配组合根（生产与测试共用，全量服务图唯一来源）
├── app.ts              # Hono 装配 + ApiType（hc 类型源）
├── client.ts           # hono/client 工厂（web/e2e/测试共用）
├── env.ts              # zod 解析的环境配置
├── platform/           # 横切平台层（不含业务）
│   ├── http/           # 统一错误模型、zod 校验钩子、上下文类型
│   ├── auth/           # 登录/JWT/限流/Actor 装配
│   ├── authz/          # 权限码通配匹配、公司数据范围
│   ├── meta/           # ResourceMeta 权威模型 + Registry + meta 端点
│   ├── standard/       # 标准动作 + 聚合草稿（service/child/record/aggregate/load-bare + 合同套件）
│   ├── posting/        # 跨域单据共享：material-qty/warehouse/controlled-projection/text/account-currency（无 skeleton）
│   ├── audit|numbering|settings|files|printing|todo|setup/
├── engines/            # gl / inventory
├── modules/            # 业务域
├── db/                 # Kysely 连接、事务约定、filterbuild、listFromSource、mapWriteError、生成类型
└── jobs/               # 后台作业（行情调度等）
db/
├── migrations/         # SQL 迁移
├── migrate.ts          # 迁移执行器
├── seed.ts / seed-admin.ts / reset.ts
```
## 编码约定（重要，违反视为返工）

1. **惯用 TS，拒绝机械 1:1 翻译**：模块用 **工厂闭包**（`createXxx(deps) => ({...})`），
   不用 class（异常：`ApiError extends Error`）；数据形状用 interface/type；
   依赖显式注入，禁止全局单例（registry/db 由 index.ts 入口创建，服务图由 composition.ts 装配）。
2. **金额纪律**：计算只走 `@synie/shared` 的 decimal；`number` 出现金额即评审驳回。
3. **事务纪律**：两层规则——service 入口自起事务（`withTx` 是唯一产生 `TrxHandle`
   的地方）；读路径函数接 `DbHandle`；事实引擎的**写方法只收 `TrxHandle`**
   （gl.post/cancel/reverse、inventory.post/cancel），裸 db 传入即编译错误。
   过账必须单事务（引擎 + 投影 + 主表），引擎/深模块内禁止自起事务。
4. **筛选/排序**只走 `filterbuild`（Meta 白名单 + 参数化），禁止拼用户输入进 SQL 标识符。
5. **错误模型**：throw `ApiError`；未知错误由 onError 统一 500，不透出内部细节。
6. **hc 类型链**：新增路由必须 `.route()` 链式挂载 + `zValidator` 输入校验，否则
   `ApiType` 推断断链，web 拿不到类型。
7. **Meta 注册**：业务资源以代码注册进 Registry（启动期 fail-closed 校验），
   权限码/Grid/打印目录随之自动派生。
8. **鉴权（Permit 凭证式 · 平台单点执行）**：见 ADR 2026-08-04（封闭谓词代数 /
   Permit 凭证式鉴权）。上一版「service 方法入口唯一检 + routes 只做
   `requireAuth`」的约定已被取代——该版自留的退路（「反射化后 enforcement 迁入
   框架策略层」）就是现在这套。
   - **判定唯一入口**是 `platform/authz/core` 的 `decide()`：主体（user/system/
     superAdmin）× 码级组合子（one/anyOf/allOf）× 行级范围（all/company/deptTree/
     dept/self/granted）。**词汇表封闭，不得新增谓词。**
   - **路由挂 `deps.authz.guard(资源名, 动作)`**（在 `requireAuth` 之后），
     判定通过则 Permit 入 ctx；service 方法收 `Permit` 而不是 `Actor`——
     绕过鉴权直调 service 在**编译期**不成立。
   - **三个执行点全部平台所有**：列表 `listAuthorized`、单记录 `loadAuthorizedFrom`
     （投影 SOURCE）/ `loadAuthorized`（裸表，统一 `not_found`、折叠 `FOR UPDATE`）、
     写入 `assertCompanyWritable` + `ownershipStamp`。判定归宿一律取
     `registry.authzTarget(资源名)`（唯一解析点，guard 与 service 共用）。
     业务模块**零鉴权代码**，`src/modules/authz-firewall.test.ts` 封路。
     参照实现：`modules/iam/department-service.ts` + `iamDepartmentRoutes`。
   - **动作码唯一事实源是 meta**：guard 从 sealed registry 解析，禁止 routes 散落
     字面量权限码，禁止客户端提供 prefix 直接进码。
   - 跨域 seam / 调度器 / 种子走显式 `systemPermit(资源, 动作)`，不再有匿名
     「调用方已鉴权」约定与 null-actor 分支。
   - **错误语义唯一规则**：动作码不满足 → `forbidden`；行级范围不命中（公司/
     部门/本人）→ `not_found`（不泄露存在性）。
   - 扫荡期过渡层（`platform/authz/actor.ts`、`db/list.ts` 的 companyScopeWhere）已随
     工单 09-12 清零删除；`modules/**` 零旧原语由 `authz-firewall.test.ts` 封路防回退。
9. 用户可见文案一律中文；代码标识符英文。
