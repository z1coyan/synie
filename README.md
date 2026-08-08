# Synie

Synie 是一个多公司财务 ERP，**纯 TypeScript monorepo**（Bun workspaces）：

- `server/`：产品后端 —— Bun + Hono + Kysely + PostgreSQL；`hono/client` 全链路类型契约（`ApiType` 为事实源）。
- `web/`：TanStack Start 前端 —— React 19、HeroUI Pro、Tailwind v4、TanStack Query、`@synie/server` hono/client。
- `packages/shared`：前后端共享 TS 契约（Filter DSL、Meta DTO、错误模型、decimal 纪律）。

前端所有产品请求只访问 `/api/v1`（Vite 代理至 `server`）。

> **登录提示：**JWT HS256 与历史 Phoenix.Token 不兼容。若旧会话无法正常退出，请清除浏览器 `localStorage` 中的 `synie:token` 后重新登录。

已交付的核心模块包括总账、发票、银行与票据、客户和供应商、销售采购库存制造、人力薪酬、基础资料及系统管理。

历史栈（Go / Elixir）已移出工作树，考古见 git tag `server-go-final` / `backend-elixir-final`。

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
├── contracts/                  # authz 等共享测试 fixtures；HTTP 类型源为 ApiType
└── docs/
    ├── 术语表.md               # 领域术语（ubiquitous language）唯一定义
    ├── 系统架构/               # 模块结构、资源接入清单与 adr/ 决策记录
    └── 业务模块/               # 功能说明书（按业务模块分篇）
```

> Monorepo：根 `package.json` 统一管理 Bun workspaces（`packages/*` + `server` + `web`），
> 依赖安装一律在**仓库根**执行 `bun install`。

## 环境要求

- Bun `1.3.14`（唯一运行时与包管理器）
- TypeScript `7.0.2`（固定版本的原生编译器）
- PostgreSQL 17（推荐使用根目录 Compose）
- Docker / Docker Compose（推荐开发路径）

VS Code 请安装仓库推荐的 “TypeScript 7” extension（extension id
`TypeScriptTeam.native-preview`）；工作区配置会启用原生语言服务并使用根目录安装的
TypeScript。依赖仍一律只在仓库根执行 `bun install`。

TypeScript 7.0 尚无稳定 Compiler API。未来引入 lint、codegen 或 editor plugin 时，
若工具会直接导入 `typescript`，必须先评估 TS 7 兼容性，不应默认增加 TypeScript 6
alias。

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

生产部署目标是 **Dokploy（Docker）**；数据库（PostgreSQL）与对象存储为独立阿里云服务，不在容器编排内。部署工件：

- `server/Dockerfile`：API 镜像（非 root 运行，HEALTHCHECK 打 `/api/v1/healthz`）。
- `web/Dockerfile`：前端镜像（多阶段构建；`HEROUI_AUTH_TOKEN` 经 BuildKit secret 注入，仅构建期用于下载 HeroUI Pro 组件码，不进镜像层与构建日志）。前端生产运行形态：`vite build` 产出 `web/dist/client` + `web/dist/server/server.js`，由 `web/serve.ts`（`bun serve.ts`）提供静态资源 + SSR，监听 `PORT`（默认 3000）。
- `compose.deploy.yaml`：生产编排（server + web + 一次性 migrate，无 postgres）；开发用的 `compose.yaml` 不动。
- 根 `.dockerignore`：保证构建上下文不含 `node_modules`、`server/uploads`（真实业务上传文件）、`.env*` 等。

Dokploy 部署要点：

1. **同源反代（必需）**：server 无 CORS 配置，浏览器侧 API 恒走同源相对路径 `/api/v1`（httpOnly cookie 会话依赖同源）。把两个服务挂在同一域名下：`/api/v1` 前缀反代到 `server:8080`，其余流量到 `web:3000`（Dokploy/Traefik 路径规则）。web 的 SSR 在集群内经 `SYNIE_API_ORIGIN=http://server:8080` 直连 server。
2. **必配环境变量**（Dokploy Environment）：`DATABASE_URL`（阿里云 PG 完整 DSN）、`AUTH_SECRET`（至少 32 字节随机值）、`BETTER_AUTH_URL`（站点 origin，如 `https://erp.example.com`）、`HEROUI_AUTH_TOKEN`（构建 secret，heroui.pro 仪表盘获取）。可选项见 `compose.deploy.yaml` 头部注释与 `server/.env.example`。
3. **迁移**：`compose.deploy.yaml` 的 `migrate` 服务随栈自动执行 `bun db/migrate.ts`（与开发 compose 同一思路），跑完退出后 server/web 才启动。
4. **首个管理员**：浏览器打开站点走初始化向导；或 `docker compose -f compose.deploy.yaml run --rm server bun db/seed.ts`（注入 `SEED_ADMIN_*`）。不在日志或代码中保存口令。
5. **上传文件**：默认落 `server` 容器 `/app/server/uploads`，已挂命名卷 `synie-uploads` 持久化；对象存储在系统设置中配置。
6. 上线前验证 `/api/v1/healthz`、后端测试、前端检查/构建与 Playwright e2e。

历史 Elixir（`backend/`）与 Go（`server-go/`）实现已移出工作树；考古见 git tag `backend-elixir-final` / `server-go-final`。
