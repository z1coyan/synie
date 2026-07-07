# Synie

Synie 是一个全栈脚手架仓库，包含两个并列的独立项目：

- `backend/`：Elixir umbrella，使用 Ash / AshPostgres / AshGraphql / Phoenix / Bandit。
- `web/`：TanStack Start 前端，使用 Bun、React、HeroUI、Tailwind v4、TanStack Query、GraphQL Code Generator。

当前骨架已打通最小端到端链路：前端 `http://localhost:3000` 通过 Vite proxy 请求后端 `http://localhost:4000/graphql`，并显示后端返回的 `Hello, world`。

> 注意：根目录没有 `package.json` 或 `mix.exs`。命令分别在 `backend/` 和 `web/` 下执行。

## 目录结构

```text
.
├── backend/                    # Elixir umbrella
│   ├── apps/
│   │   ├── synie_core/          # Ash domain/resource/repo
│   │   └── synie_web/           # Phoenix endpoint/router/GraphQL schema
│   └── config/
├── web/                        # TanStack Start frontend
│   ├── app/
│   │   ├── graphql/             # GraphQL operations + generated gql/ output
│   │   ├── lib/graphql.ts       # fetch('/graphql') client
│   │   └── routes/index.tsx     # Synie hello page
│   ├── codegen.ts
│   ├── package.json
│   └── vite.config.ts
└── docs/superpowers/           # scaffold spec/plan artifacts
```

## 环境要求

已验证的本地版本：

- Bun `1.3.x`
- Elixir `1.20.x`
- Erlang/OTP `28.x`

后端 `SynieCore.Repo` 的数据库连接由运行时 env 统一管理。开发环境默认连接 Docker 暴露的本机 Postgres：

- username: `postgres`
- password: `postgres`
- database: `synie_dev`
- host: `localhost`
- port: `5440`

可用两种方式覆盖：

1. 设置 `DATABASE_URL`，优先级最高，例如 `postgres://postgres:postgres@localhost:5440/synie_dev`。
2. 设置拆分变量：`PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`、`POOL_SIZE`。

`backend/.env.example` 记录了本地默认值，但应用不会自动加载 `.env` 文件；请用 shell、direnv、Docker Compose `env_file` 或 IDE run configuration 注入变量。

当前 `sayHello` 是纯 Ash generic action，不访问数据库。因此即使本地 Postgres 不可用或 env 未正确配置，启动/测试时可能看到 Postgrex auth 日志，但 hello GraphQL 链路仍可工作。后续加入持久化资源时，再正式准备数据库和迁移。

## 安装依赖

### 后端

```bash
cd backend
mix deps.get
```

### 前端

```bash
cd web
bun install
```

## 本地启动

需要两个终端。

### 终端 A：启动后端

```bash
cd backend
mix phx.server
```

后端监听：

- GraphQL endpoint: `http://localhost:4000/graphql`
- GraphiQL playground: `http://localhost:4000/graphql/playground`

验证 GraphQL：

```bash
curl -s -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ sayHello(name: \"world\") }"}'
```

期望返回：

```json
{"data":{"sayHello":"Hello, world"}}
```

如果用 `curl` 打开 playground，需要带 HTML Accept header：

```bash
curl -i http://localhost:4000/graphql/playground -H 'Accept: text/html'
```

浏览器直接访问不需要额外 header。

### 终端 B：启动前端

```bash
cd web
bun dev
```

前端监听：

- `http://localhost:3000`

`web/vite.config.ts` 会把前端请求的 `/graphql` 代理到 `http://localhost:4000/graphql`。因此正常查看页面前，先启动后端。

## 常用命令

### 后端测试

```bash
cd backend
mix test
```

当前测试覆盖 hello generic action。看到 Postgrex 连接错误日志通常是本地 DB 未准备好的非阻塞噪声；以 ExUnit 最终结果为准。

### 前端类型检查

```bash
cd web
bunx tsc --noEmit
```

### 前端构建

```bash
cd web
bun run build
```

### 重新生成 GraphQL 类型

后端必须先运行在 `:4000`，因为 codegen 从 live schema 拉取 GraphQL schema。

```bash
cd web
bun run codegen
bunx tsc --noEmit
```

生成文件位于：

```text
web/app/graphql/gql/
```

## 当前 GraphQL 合约

后端暴露的示例 query：

```graphql
query SayHello($name: String!) {
  sayHello(name: $name)
}
```

变量示例：

```json
{"name":"world"}
```

返回示例：

```json
{"data":{"sayHello":"Hello, world"}}
```

## 生产环境提示

当前仓库是骨架，不是生产配置。进入生产部署前至少需要：

- 配置真实 `DATABASE_URL`。
- 配置 `SECRET_KEY_BASE`。
- 按部署域名设置 `PHX_HOST`。
- 为 AshPostgres 资源补齐迁移和数据库生命周期。
- 根据需要增加认证资源和策略；当前只安装了 Ash Authentication 相关依赖，没有 User resource 或登录流程。

`backend/config/runtime.exs` 已在 `prod` 环境读取：

- `DATABASE_URL`
- `SECRET_KEY_BASE`
- `PHX_HOST`
- `POOL_SIZE`（可选，默认 `10`）

本地开发和测试也会读取：

- `DATABASE_URL`（可选，优先级最高）
- `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`
- `POOL_SIZE`（可选，默认 `10`）

## 已知开发期注意事项

- `mix compile` / `mix test` 可能提示 `SynieCore.Repo.min_pg_version/0` 未定义；当前按 AshPostgres 默认兼容版本运行。
- 如果本机 Postgres 凭据不匹配，会看到 `FATAL 28P01 (invalid_password)` 日志；当前 hello 示例不依赖数据库，所以不是阻塞项。
- 前端页面的 `Hello, world` 是客户端 hydration 后通过 TanStack Query 请求得到；直接 `curl http://localhost:3000/` 主要看到 SSR shell。浏览器或 Vite proxy 日志能验证完整链路。
