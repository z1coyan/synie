# Synie

Synie 是一个多公司财务 ERP，**纯 TypeScript monorepo**（Bun workspaces）：

- `server/`：产品后端 —— Bun + Hono + Kysely + PostgreSQL；`hono/client` 全链路类型契约（`ApiType` 为事实源）。
- `web/`：TanStack Start 前端 —— React 19、HeroUI Pro、Tailwind v4、TanStack Query、`@synie/server` hono/client。
- `packages/shared`：前后端共享 TS 契约（Filter DSL、Meta DTO、错误模型、decimal 纪律）。

前端所有产品请求只访问 `/api/v1`（Vite 代理至 `server`）。

> **登录提示：**JWT HS256 与历史 Phoenix.Token 不兼容。若旧会话无法正常退出，请清除浏览器 `localStorage` 中的 `synie:token` 后重新登录。

已交付的核心模块包括总账、发票、银行与票据、客户和供应商、销售采购库存制造、人力薪酬、基础资料及系统管理。

历史栈清场记录见 [`docs/migration/2026-07-28-go-to-bun-ts-cutover.md`](docs/migration/2026-07-28-go-to-bun-ts-cutover.md)（Go tag `server-go-final`、Elixir tag `backend-elixir-final`；OpenAPI 归档 `docs/migration/openapi-server-go-final.yaml`）。

## 目录结构

```text
.
├── package.json                # Bun workspaces 根（packages/* + server + web）
├── server/                     # 产品后端：Bun + Hono + Kysely
│   ├── src/                    # platform 横切层 / engines / modules / db
│   ├── db/migrations/          # SQL 迁移 + migrate.ts
│   └── test/                   # bun test；PG 集成门控 SYNIE_TEST_DATABASE_URL
├── packages/
│   └── shared/                 # @synie/shared：前后端共享契约（filter/meta/error/decimal）
├── web/                        # TanStack Start 前端
│   ├── app/lib/api/            # hono/client 与 Resource Client
│   ├── app/lib/resources/      # ResourceClient registry
│   └── app/routes/             # 页面与路由
├── contracts/                  # 历史 fixtures（authz 等）；HTTP 类型源为 ApiType
├── CONTEXT.md                  # 领域术语（ubiquitous language）
├── docs/
│   ├── adr/                    # 架构决策记录
│   ├── migration/              # 迁移设计与归档（含历史 OpenAPI）
│   └── 产品文档/               # 功能说明书
└── .scratch/                   # 活跃规格与本地工单
```

> Monorepo：根 `package.json` 统一管理 Bun workspaces（`packages/*` + `server` + `web`），
> 依赖安装一律在**仓库根**执行 `bun install`。

## 环境要求

- Bun `1.3.x`（唯一运行时）
- PostgreSQL 17（推荐使用根目录 Compose）
- Docker / Docker Compose（推荐开发路径）

Compose 默认把 PostgreSQL 暴露在 `localhost:5441`，数据库、用户和密码均为 `synie`。主要环境变量：

```text
PORT=8080
HOST=0.0.0.0
DATABASE_URL=postgres://synie:synie@localhost:5441/synie?sslmode=disable
AUTH_SECRET=<至少 32 字节的随机值>
AUTH_TOKEN_TTL=168h
```

DDL 由 SQL 迁移唯一管理（`server/db/migrations/` + `server/db/migrate.ts`），不再用 Ecto/Ash 迁移产品数据库。

## 安装依赖

```bash
# 仓库根：一次安装全部 workspace（packages/shared + server + web）
bun install
```

## 本地启动（一键）

根目录用 **Turborepo** 编排。默认一条命令：起 Postgres → 迁移 → 并行跑 API + 前端。

```bash
bun install
bun run dev                 # 一键：docker postgres + migrate + server + web（不 seed）
bun run dev -- --no-docker  # 跳过 compose，使用已有 DATABASE_URL
bun run db:reset            # 开发库复位到未 setup（仅 localhost 等 dev DSN）
```

| 服务 | 地址 |
|------|------|
| API | http://localhost:8080 |
| healthz | http://localhost:8080/api/v1/healthz |
| 前端 | http://localhost:3000（`/api/v1` 代理到 8080） |

分项命令（可选）：

```bash
bun run db:up            # 仅 postgres
bun run db:migrate
bun run db:reset         # 清空业务数据 → 未 setup（dev only）
bun run db:seed          # 可选：仅幂等管理员（一般用初始化向导）
bun run dev:apps         # 仅 turbo 并行 server+web（假设库已就绪）
bun run dev:server
bun run dev:web
```

Docker 全容器后端（不跑本机 hot reload）：

```bash
docker compose up --build server
```

## 常用命令

### 后端（server/）

```bash
cd server
bun test                 # 单测；SYNIE_TEST_DATABASE_URL 设置后含 PG 集成
bun run typecheck
bun run db:migrate
bun run db:codegen       # 重新生成 src/db/types.d.ts（须已迁移开发库）
```

### 前端检查与构建

```bash
cd web
bun run check
bun run typecheck
bun test
bun run build
```

Playwright 验收：

```bash
cd web
bun run e2e          # run-smoke.sh：迁移 + Bun server + 前端 + playwright.api.config.ts
bun run e2e:api      # 仅跑 *.api.e2e.ts（需已起栈）
```

前端契约来自 `@synie/server` 的 `ApiType` + `createApiClient`（hono/client），不再使用 OpenAPI codegen。

## 当前 API 合约

类型事实源：`server/src/app.ts` 的 `ApiType`（经 `hono/client` 传导到 web）。主要入口包括：

- 登录：`POST /api/v1/auth/login`
- 当前用户：`GET /api/v1/auth/me`
- 初始化向导：`/api/v1/setup/*`
- 资源元数据：`GET /api/v1/meta/resources/{name}`
- 资源查询：各资源的 `/api/v1/.../query`
- 文件：`/api/v1/files*`
- 打印及业务命令：对应的 `/api/v1/...` REST endpoint

登录后前端把 JWT 存入 `web/app/lib/auth.ts`，后续请求带 `Authorization: Bearer <token>`。资源权限、角色与公司范围由服务端在每次请求时从 PostgreSQL 构建，不固化在 JWT 中。

## HeroUI Pro

前端使用 [HeroUI Pro](https://heroui.pro)：`@heroui/react` v3 与 `@heroui-pro/react`，要求 React 19 + Tailwind v4。开发规范见 `web/AGENTS.md`。

从 [Pro dashboard](https://heroui.pro/dashboard) 获取 token，存放在仓库根目录 `.env`（已 gitignore，模板见 `.env.example`）：

- `HEROUI_PERSONAL_TOKEN`：个人本地 MCP / skills 使用。
- `HEROUI_AUTH_TOKEN`：CI/CD 与非交互安装使用。

两个 token 均不得提交或写入代码。若 `bun install` 后 Pro 组件缺失，可带 token 重跑安装：

```bash
cd web
HEROUI_AUTH_TOKEN=xxx node node_modules/@heroui-pro/react/dist/postinstall/index.js
```

或执行一次本地授权：`bunx heroui-pro@latest login`。

## 生产环境提示

进入生产部署前至少需要：

- 配置真实 `DATABASE_URL`。
- 配置至少 32 字节、不可预测的 `AUTH_SECRET`，并按需设置 `AUTH_TOKEN_TTL`。
- 使用 `bun run db:migrate` 执行并审查数据库迁移。
- 通过 seed 或初始化向导创建首个管理员，不在日志或代码中保存口令。
- 验证 `/api/v1/healthz`、后端测试、前端检查/构建与 Playwright e2e。

历史 Elixir（`backend/`）与 Go（`server-go/`）实现已移出工作树；考古见 git tag `backend-elixir-final` / `server-go-final`。
