# Synie

Synie 是一个多公司财务 ERP。当前产品运行栈由 Go API 与 TanStack Start 前端组成：

- `server/`：Go、chi、pgx/sqlc、goose、OpenAPI、JWT HS256。
- `web/`：Bun、React 19、TanStack Start、HeroUI Pro、Tailwind v4、TanStack Query、`openapi-fetch`。
- `backend/`：旧 Elixir/Phoenix/Ash 实现，仅保留作业务行为、测试与历史契约参考，不属于产品启动链路。

前端所有产品请求只访问 Go `/api/v1`。Vite 不代理 GraphQL 或旧 Elixir API，开发和产品运行均不需要启动 `backend/`。

> **切流登录提示：**Go 服务签发的 JWT HS256 不兼容旧 Elixir/Phoenix `Phoenix.Token`。切流后必须重新登录；若旧会话无法正常退出，请清除浏览器 `localStorage` 中的 `synie:token` 后重新登录。系统不会转换或兼容接受旧 token。

已交付的核心模块包括总账、发票、银行与票据、客户和供应商、销售采购库存制造、人力薪酬、基础资料及系统管理。

## 目录结构

```text
.
├── server/                     # Go API，唯一产品后端
│   ├── cmd/synie/              # HTTP 服务入口
│   ├── db/migrations/          # goose 数据库迁移
│   └── internal/               # 平台、领域、引擎与 HTTP 实现
├── web/                        # TanStack Start 前端
│   ├── app/lib/api/            # OpenAPI client 与生成类型
│   ├── app/lib/resources/      # ResourceClient registry
│   └── app/routes/             # 页面与路由
├── contracts/openapi/          # Go HTTP 契约
├── backend/                    # 旧 Elixir 参考实现，不参与产品运行
├── CONTEXT.md                  # 领域术语（ubiquitous language）
├── docs/
│   ├── adr/                    # 架构决策记录
│   ├── migration/              # 迁移设计与状态
│   └── 产品文档/               # 功能说明书
└── .scratch/                   # 活跃规格与本地工单
```

> 根目录没有 `package.json` 或 `go.mod`。Go 命令在 `server/` 下执行，前端命令在 `web/` 下执行。

## 环境要求

- Go（版本以 `server/go.mod` 为准）
- Bun `1.3.x`
- PostgreSQL 17（推荐使用根目录 Compose）
- Docker / Docker Compose（推荐开发路径）

Compose 默认把 PostgreSQL 暴露在 `localhost:5441`，数据库、用户和密码均为 `synie`。Go server 不自动读取 `.env`；直接运行时须通过进程环境注入配置。主要变量：

```text
HTTP_ADDR=:8080
DATABASE_URL=postgres://synie:synie@localhost:5441/synie?sslmode=disable
AUTH_SECRET=<至少 32 字节的随机值>
AUTH_TOKEN_TTL=168h
```

DDL 由 `server/db/migrations/` 中的 goose 迁移唯一管理，不再用 Ecto/Ash 迁移产品数据库。

## 安装依赖

### Go API

```bash
cd server
go mod download
```

### 前端

```bash
cd web
bun install
```

## 本地启动

推荐使用两个终端。

### 终端 A：数据库、迁移与 Go API

```bash
docker compose up --build server
```

首次启动或需要补种子时，在另一个终端执行：

```bash
docker compose --profile tools run --rm seed
```

服务地址：

- Go API：`http://localhost:8080`
- 健康检查：`http://localhost:8080/api/v1/healthz`

也可直接运行 Go 服务；server 不自动加载 `.env`：

```bash
cd server
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

### Go 生成与测试

```bash
cd server
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
