# Synie

Synie 是一个多公司财务 ERP。**后端正处于 Go → Bun/TS 重写过渡期**（规格与工单：`.scratch/ts-backend-rewrite/`）：

- `server/`：**目标后端** —— Bun + Hono + Kysely + PostgreSQL，`hono/client` 全链路类型契约（重建中，当前为平台层骨架 + auth/meta 证明路径）。
- `server-go/`：**现行产品后端** —— Go、chi、pgx/sqlc、goose、OpenAPI、JWT HS256。重写完成切流前，产品流量仍由它承载；只读维护，不再演进新业务。
- `web/`：Bun、React 19、TanStack Start、HeroUI Pro、Tailwind v4、TanStack Query、`openapi-fetch`。
- `packages/shared`：前后端共享 TS 契约（Filter DSL、Meta DTO、错误模型、decimal 纪律）。
- `backend/`：旧 Elixir/Phoenix/Ash 实现，仅保留作业务行为、测试与历史契约参考，不属于产品启动链路。

前端所有产品请求只访问 `/api/v1`。Vite 不代理 GraphQL 或旧 Elixir API，开发和产品运行均不需要启动 `backend/`。

> **切流登录提示：**Go 服务签发的 JWT HS256 不兼容旧 Elixir/Phoenix `Phoenix.Token`。切流后必须重新登录；若旧会话无法正常退出，请清除浏览器 `localStorage` 中的 `synie:token` 后重新登录。系统不会转换或兼容接受旧 token。

已交付的核心模块包括总账、发票、银行与票据、客户和供应商、销售采购库存制造、人力薪酬、基础资料及系统管理。

## 目录结构

```text
.
├── package.json                # Bun workspaces 根（packages/* + server + web）
├── server/                     # 目标后端：Bun + Hono + Kysely（重建中）
│   ├── src/                    # platform 横切层 / engines / modules / db
│   ├── db/migrations/          # SQL 迁移（与 server-go 同源）+ migrate.ts
│   └── test/                   # bun test；PG 集成门控 SYNIE_TEST_DATABASE_URL
├── server-go/                  # 现行产品后端（Go），过渡期只读维护
│   ├── cmd/synie/              # HTTP 服务入口
│   ├── db/migrations/          # goose 数据库迁移
│   └── internal/               # 平台、领域、引擎与 HTTP 实现
├── packages/
│   └── shared/                 # @synie/shared：前后端共享契约（filter/meta/error/decimal）
├── web/                        # TanStack Start 前端
│   ├── app/lib/api/            # OpenAPI client 与生成类型
│   ├── app/lib/resources/      # ResourceClient registry
│   └── app/routes/             # 页面与路由
├── contracts/openapi/          # 现行 HTTP 契约（行为参考；新栈以 ApiType 为类型源）
├── backend/                    # 旧 Elixir 参考实现，不参与产品运行
├── CONTEXT.md                  # 领域术语（ubiquitous language）
├── docs/
│   ├── adr/                    # 架构决策记录
│   ├── migration/              # 迁移设计与状态
│   └── 产品文档/               # 功能说明书
└── .scratch/                   # 活跃规格与本地工单（含 ts-backend-rewrite）
```

> Monorepo：根 `package.json` 统一管理 Bun workspaces（`packages/*` + `server` + `web`），
> 依赖安装一律在**仓库根**执行 `bun install`。Go 命令在 `server-go/` 下执行。

## 环境要求

- Bun `1.3.x`（目标栈唯一运行时）
- Go（版本以 `server-go/go.mod` 为准；仅过渡期维护现行后端需要）
- PostgreSQL 17（推荐使用根目录 Compose）
- Docker / Docker Compose（推荐开发路径）

Compose 默认把 PostgreSQL 暴露在 `localhost:5441`，数据库、用户和密码均为 `synie`。Go server 不自动读取 `.env`；直接运行时须通过进程环境注入配置。主要变量：

```text
HTTP_ADDR=:8080
DATABASE_URL=postgres://synie:synie@localhost:5441/synie?sslmode=disable
AUTH_SECRET=<至少 32 字节的随机值>
AUTH_TOKEN_TTL=168h
```

DDL 由 SQL 迁移唯一管理（`server/db/migrations/` 与 `server-go/db/migrations/` 同源），不再用 Ecto/Ash 迁移产品数据库。

## 安装依赖

```bash
# 仓库根：一次安装全部 workspace（packages/shared + server + web）
bun install

# Go 现行后端（过渡期）
cd server-go && go mod download
```

## 本地启动

推荐使用两个终端。

### 终端 A：数据库、迁移与后端

```bash
# 现行 Go 后端（产品路径）
docker compose up --build server-go

# 或目标 Bun 后端（重写中，先迁移再启动）
cd server
export DATABASE_URL='postgres://synie:synie@localhost:5441/synie?sslmode=disable'
export AUTH_SECRET='local-development-secret-change-me-32-bytes'
bun run db:migrate
bun run db:seed   # 首次：admin/admin123
bun run dev
```

首次启动 Go 栈需要补种子时，在另一个终端执行：

```bash
docker compose --profile tools run --rm seed
```

服务地址：

- API：`http://localhost:8080`
- 健康检查：`http://localhost:8080/api/v1/healthz`

也可直接运行 Go 服务：

```bash
cd server-go
export DATABASE_URL='postgres://synie:synie@localhost:5441/synie?sslmode=disable'
export AUTH_SECRET='local-development-secret-change-me-32-bytes'
make migration-up
go run ./cmd/synie
```

### 终端 B：前端

```bash
cd web
bun dev
```

前端监听 `http://localhost:3000`。`web/vite.config.ts` 只把 `/api/v1` 代理到 `GO_API_PORT` 指定的 Go 服务端口（默认 `8080`）。

## 常用命令

### Bun 后端（server/）

```bash
cd server
bun test                 # 单测；SYNIE_TEST_DATABASE_URL 设置后含 PG 集成
bun run typecheck
bun run db:migrate
bun run db:codegen       # 重新生成 src/db/types.d.ts（须已迁移开发库）
```

### Go 生成与测试（server-go/）

```bash
cd server-go
make generate
make test
```

### 前端契约、检查与构建

```bash
cd web
bun run openapi
bun run check
bun run typecheck
bun test
bun run build
```

Go Playwright 验收：

```bash
cd web
bun run e2e:go
```

`bun run openapi` 从 `contracts/openapi/openapi.yaml` 生成 `web/app/lib/api/schema.d.ts`。前端不再包含 GraphQL client、operations、codegen 或生成物。

## 当前 Go API 合约

OpenAPI 唯一契约位于 `contracts/openapi/openapi.yaml`。主要入口包括：

- 登录：`POST /api/v1/auth/login`
- 当前用户：`GET /api/v1/auth/me`
- 初始化向导：`/api/v1/setup/*`
- 资源元数据：`GET /api/v1/meta/resources/{name}`
- 资源查询：各资源的 `/api/v1/.../query`
- 文件：`/api/v1/files*`
- 打印及业务命令：对应的 `/api/v1/...` REST endpoint

登录后前端把 JWT 存入 `web/app/lib/auth.ts`，后续请求带 `Authorization: Bearer <token>`。资源权限、角色与公司范围由 Go 服务在每次请求时从 PostgreSQL 构建，不固化在 JWT 中。

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
- 使用 goose 执行并审查数据库迁移。
- 通过 Go seed 或初始化向导创建首个管理员，不在日志或代码中保存口令。
- 验证 `/api/v1/healthz`、Go 测试、前端检查/构建与 Go Playwright 测试。
- 切流时通知用户重新登录；旧 Phoenix token 不得继续使用。

`backend/` 可以用于比对旧业务行为，但不得接收产品流量、被 Vite 代理或成为部署依赖。是否归档参考实现须另立议题，本次 Go-only 切流不删除它。
