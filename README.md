# Synie

Synie 是一个多公司财务 ERP，包含两个并列的独立项目：

- `backend/`：Elixir umbrella，使用 Ash / AshPostgres / AshGraphql / Phoenix / Bandit。
- `web/`：TanStack Start 前端，使用 Bun、React、HeroUI Pro、Tailwind v4、TanStack Query、GraphQL Code Generator。

已交付的核心模块：

- 总账（GL）：会计凭证录入/审核/取消审核、自动过账、分录明细
- 增值税发票：台账、三科目自动过账、作废/红冲、对向发票
- 银行账户与银行流水：导入模板、流水解析入暂存行、确认/批量转正、导入历史
- 客户/供应商（销售/采购往来单位）主数据
- 基础资料：公司、科目、币种、计量单位
- 系统管理：用户/角色/权限矩阵、操作日志、自动编号规则

前端 `http://localhost:3000` 通过 Vite proxy 请求后端 `http://localhost:4000/graphql`；登录后按域（财务/基础资料/供应链/系统）访问各模块页面。

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
│   │   └── routes/
│   │       ├── login.tsx        # 登录页
│   │       └── _app/            # 登录后布局，按域分组：finance/base/scm/system
│   ├── codegen.ts
│   ├── package.json
│   └── vite.config.ts
└── docs/superpowers/           # 设计文档：各模块 spec + 计划/决策记录
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

后端 **dev/test 会自动加载** `backend/.env`，以及可选的 `backend/.env.dev` / `backend/.env.test`（后者覆盖前者同名键）。进程里已有的环境变量优先（shell / CI / IDE 不会被文件覆盖）。`prod` 不读文件。模板见 `backend/.env.example`；test 库名由已提交的 `.env.test` 固定为 `synie_test`。

持久化资源已就位（总账、发票、银行流水、客户/供应商等均落库）。本地开发前需确保上述 Postgres 可用，并执行：

```bash
cd backend
# 首次: cp .env.example .env
mix ecto.create
mix ecto.migrate
# 或一键重置(删库重建并迁移,会断开会话;仅 dev/test):
# mix synie.db.reset
```

空库只需迁移即可启动。迁移顺带种子 CNY、内置 admin 角色与单行配置表；首次打开应用进入初始化向导（建超管 → 建公司 → 选语言），**完成时**幂等种子内置存储接入、编号规则、物料两级分类与机加工常用计量单位，并向导入口永久关闭。无需再跑 `seeds.exs`。

**重置开发库**（清空数据、重跑迁移，再走初始化向导）：

```bash
cd backend
mix synie.db.reset
```

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

## HeroUI Pro

前端使用 [HeroUI Pro](https://heroui.pro)：`@heroui/react` v3（基础组件）+ `@heroui-pro/react`（Pro 组件：图表、DataGrid、AppLayout、AI 界面等），要求 React 19 + Tailwind v4。规范见 `web/AGENTS.md`。

### Token

从 [Pro dashboard](https://heroui.pro/dashboard) 获取，放在仓库根目录 `.env`（已 gitignore，模板见 `.env.example`）：

- `HEROUI_PERSONAL_TOKEN`：个人 token，本地 MCP / skills 安装用。
- `HEROUI_AUTH_TOKEN`：CI/CD token，流水线与非交互安装用（如 GitHub Actions `env: HEROUI_AUTH_TOKEN: ${{ secrets.HEROUI_AUTH_TOKEN }}`）。

两个 token 均不得提交或写入代码。

### Pro 包安装机制

`@heroui-pro/react` 在公共 npm 上只是一个壳，真正的组件代码由 postinstall 按 license 从 CDN 下载。`web/package.json` 的 `trustedDependencies` 已允许 bun 执行该 postinstall。新环境 `bun install` 后如果 Pro 组件缺失（`node_modules/@heroui-pro/react` 只有几十 KB），带 token 重跑一次：

```bash
cd web
HEROUI_AUTH_TOKEN=xxx node node_modules/@heroui-pro/react/dist/postinstall/index.js
```

或本地一次性 GitHub 授权（180 天有效）：`bunx heroui-pro@latest login`。

### 安装 Agent Skills（本地一次性）

```bash
set -a; source .env; set +a
curl -fsSL https://heroui.pro/docs/install -o /tmp/heroui-install.sh
bash /tmp/heroui-install.sh heroui-react-pro
bash /tmp/heroui-install.sh heroui-pro-design-taste
```

安装脚本会自动检测本机的 Claude Code / Cursor 等工具并把 skill 解压到对应目录（如 `~/.claude/skills/`）。

### MCP server

在项目根目录创建 `.mcp.json`（Claude Code 会从环境变量展开 token，需先在 shell 中导出 `HEROUI_PERSONAL_TOKEN`）：

```json
{
  "mcpServers": {
    "heroui-pro": {
      "type": "http",
      "url": "https://mcp.heroui.pro/mcp",
      "headers": {
        "x-heroui-personal-token": "${HEROUI_PERSONAL_TOKEN}"
      }
    }
  }
}
```

## 本地启动

需要两个终端。

### 终端 A：启动后端

```bash
cd backend
# 自动读 backend/.env,无需 source
mix phx.server
```

后端监听：

- GraphQL endpoint: `http://localhost:4000/graphql`
- GraphiQL playground: `http://localhost:4000/graphql/playground`

验证 GraphQL：

```bash
curl -s -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ me { id username } }"}'
```

期望返回（未带 token 时 `me` 为 null）：

```json
{"data":{"me":null}}
```

未带 token 时 `me` 返回 null 而非报错，正好证明 GraphQL 端点存活且工作正常；带 token 后 `me` 返回当前登录用户。

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

测试覆盖 GL 过账/凭证审核取消、发票作废/红冲、银行流水导入、权限（策略/矩阵）、gridMeta、文件上传下载等核心域逻辑；运行前需确保本地 Postgres 可用（见上文「环境要求」）。

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

后端通过 AshGraphql 从各 Ash 资源自动派生 CRUD + list 查询，并在 `backend/apps/synie_web/lib/synie_web/schema.ex` 里补充少量自定义 query/mutation：

- 资源 list 查询统一走 offset 分页，返回 `{ count, results }` 结构（不留扁平列表）。
- 各资源自带增删改 mutation（create/update/destroy）。
- 自定义 query：`me`（当前登录用户）、`myPermissions`、`permissionCatalog`、`gridMeta(resource: String!)`（DataGrid 列/权限/多态外键元数据）、`numberableResources`（自动编号规则页的资源下拉）、`setupStatus`（初始化向导状态，未认证可读）。
- 自定义 mutation：`login(username, password)`、`createSysUser`、`resetSysUserPassword`、`setupCreateFirstUser`（向导建首个超管并返回登录态）、`setupSeedCommonCurrencies`（预置常用货币）、`setupComplete`（写首选语言并落完成旗标）。

前端不手写类型，而是通过 `web/codegen.ts` 从运行中的后端拉取 live schema 生成 GraphQL 类型（见下文「重新生成 GraphQL 类型」）。

最小示例——登录换取 token：

```graphql
mutation Login($username: String!, $password: String!) {
  login(username: $username, password: $password) {
    token
    user {
      id
      username
    }
  }
}
```

登录后前端把 token 存入 `web/app/lib/auth.ts`，后续请求带 `Authorization: Bearer <token>` header；未带 token 的请求 `actor` 为 nil，具体资源能否访问由各资源的策略决定。

## 生产环境提示

当前仓库是骨架，不是生产配置。进入生产部署前至少需要：

- 配置真实 `DATABASE_URL`。
- 配置 `SECRET_KEY_BASE`。
- 按部署域名设置 `PHX_HOST`。
- 为 AshPostgres 资源补齐迁移和数据库生命周期。
- 根据需要增加认证资源和策略；当前只安装了 Ash Authentication 相关依赖，没有 User resource 或登录流程。
- 初始化流程：`mix ecto.migrate`（顺带种子 CNY 与内置 admin 角色）→ 浏览器打开应用进入初始化向导（建超管、公司、语言；完成时种子存储接入/编号规则/物料分类）。口令由操作者当场自设，不落日志。凡用旧版 seeds（硬编码/环境变量口令）初始化过的环境，其 admin 口令应视为已泄露并重置。

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
- 如果本机 Postgres 凭据不匹配，会看到 `FATAL 28P01 (invalid_password)` 日志；由于业务资源均已落库，这会阻塞几乎所有查询/mutation，需先修正连接配置再继续。
- 未登录访问 `web/app/routes/_app/` 下的任意页面会被重定向到 `/login`；登录后浏览器或 Vite proxy 日志能验证前后端完整链路（前端页面数据经 TanStack Query 请求 GraphQL 得到，直接 `curl http://localhost:3000/` 主要看到 SSR shell）。
