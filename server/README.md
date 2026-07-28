# @synie/server — Synie Bun/TS 后端

Synie ERP 的目标后端：**Bun + Hono + Kysely + PostgreSQL**，与 `web/`（TanStack Start）
经 `hono/client` 共享全链路类型（契约即代码，取代 OpenAPI codegen）。

- 行为参考实现：`server-go/`（Go，只读参考，勿再演进）
- 领域语义唯一来源：`CONTEXT.md` + `docs/产品文档/` + `docs/adr/`
- 迁移规格与工单：`.scratch/ts-backend-rewrite/`

## 技术栈定案

| 关注点 | 选型 | 说明 |
|--------|------|------|
| 运行时 | **Bun**（唯一，不引入 Node 专属依赖） | `Bun.serve` / `Bun.password` / `Bun.file` |
| HTTP | **Hono** + `@hono/zod-validator` | 路由链式定义，类型供 `hc<ApiType>` 推断 |
| 客户端契约 | **hono/client（hc）** | `src/app.ts` 的 `ApiType` 是契约事实源；**URL 与 JSON 形状保持与 server-go/原 OpenAPI 一致**（551 个端点行为不变，仅类型来源变化） |
| 数据层 | **Kysely** + postgres.js（官方 PostgresJSDialect） | 纯 JS 驱动，Bun 原生；类型由 kysely-codegen 从迁移后开发库生成（`bun run db:codegen`，生成物提交） |
| 迁移 | `db/migrations/*.sql` + `db/migrate.ts` | SQL 与 server-go 同源；每文件一事务，advisory lock 串行 |
| 认证 | **Bun.password（argon2id）+ hono/jwt（HS256）** | PHC 串与 Go 种子哈希互通；登录限流单进程 10 次/5 分钟 |
| 金额 | `@synie/shared` decimal（decimal.js，half-up） | wire 一律字符串；金额 2 位 / 单价 4 位 / 数量 6 位 |
| 测试 | `bun test`；PG 集成测试门控 `SYNIE_TEST_DATABASE_URL` | 同 server-go 门控惯例 |

## 常用命令

```bash
bun install                 # 仓库根（workspace 安装）
bun run dev                 # 开发（--hot），需先备好 .env 见 .env.example
bun test                    # 单测；设置 SYNIE_TEST_DATABASE_URL 后含 PG 集成
bun run typecheck           # tsc --noEmit
bun run db:migrate          # 执行 SQL 迁移（DATABASE_URL）
bun run db:seed             # 幂等创建管理员（admin/admin123）
bun run db:codegen          # 从开发库重新生成 src/db/types.d.ts
```

## 目录

```
src/
├── index.ts            # 入口：env → db → 依赖装配 → Bun.serve
├── app.ts              # Hono 装配 + ApiType（hc 类型源）
├── client.ts           # hono/client 工厂（web/e2e/测试共用）
├── env.ts              # zod 解析的环境配置
├── platform/           # 横切平台层（不含业务）
│   ├── http/           # 统一错误模型、zod 校验钩子、上下文类型
│   ├── auth/           # 登录/JWT/限流/Actor 装配
│   ├── authz/          # 权限码通配匹配、公司数据范围
│   ├── meta/           # ResourceMeta 权威模型 + Registry + meta 端点
│   ├── audit|numbering|settings|files|printing|todo/   # 骨架，见各 README 与工单
├── engines/            # gl / inventory 深模块（骨架，工单 03）
├── modules/            # 业务域（workflow 填充，骨架为空）
├── db/                 # Kysely 连接、事务约定、filterbuild、生成类型
└── jobs/               # 后台作业（骨架，工单 14）
db/
├── migrations/         # SQL（与 server-go 同源）
├── migrate.ts          # 迁移执行器
├── seed.ts / seed-admin.ts
```

## 编码约定（重要，违反视为返工）

1. **惯用 TS，拒绝 1:1 翻译**：server-go 是行为参考不是形态模板。模块用
   **工厂闭包**（`createXxx(deps) => ({...})`），不用 class（异常：`ApiError extends Error`）；
   数据形状用 interface/type；依赖显式注入，禁止全局单例（registry/db 由 index.ts 装配）。
2. **金额纪律**：计算只走 `@synie/shared` 的 decimal；`number` 出现金额即评审驳回。
3. **事务纪律**：函数接 `DbHandle`（`src/db/tx.ts`），事务边界归调用方 `withTx`；
   过账必须单事务（引擎 + 投影 + 主表），引擎/深模块内禁止自起事务。
4. **筛选/排序**只走 `filterbuild`（Meta 白名单 + 参数化），禁止拼用户输入进 SQL 标识符。
5. **错误模型**：throw `ApiError`；未知错误由 onError 统一 500，不透出内部细节。
6. **hc 类型链**：新增路由必须 `.route()` 链式挂载 + `zValidator` 输入校验，否则
   `ApiType` 推断断链，web 拿不到类型。
7. **Meta 注册**：业务资源以代码注册进 Registry（启动期 fail-closed 校验），
   权限码/Grid/打印目录随之自动派生。
8. 用户可见文案一律中文；代码标识符英文。
