# Synie — 后端 Elixir+Ash / 前端 TanStack Start 骨架设计

**日期**:2026-07-07
**状态**:已批准(待实现)
**深度**:仅骨架走通——hello world GraphQL 端点 + 前端页面联通

## 1. 目标

在 `~/code/synie` 下建立一套前后端分离的 Web 项目骨架:

- **后端**:Elixir + Ash 框架,umbrella project,Phoenix 提供 HTTP endpoint,Ash GraphQL 暴露 API。
- **前端**:TanStack Start(React + TanStack Router/Query),HeroUI 组件库,Tailwind CSS v4,GraphQL codegen 生成 TS 类型。

骨架阶段不涉及 monorepo 编排——两个独立项目并排,各管各的包管理器。

## 2. 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 仓库结构 | 非 monorepo;`backend/` + `web/` 并排 | 用户明确放弃 bun workspaces;简单,无顶层编排 |
| 后端结构 | Elixir umbrella,`synie_web` + `synie_core` 分离 | umbrella 价值在 web/领域分离;Ash resources 独立可测 |
| API 对接 | GraphQL(`ash_graphql`)+ codegen | 强类型,TanStack Query 配合 codegen 类型安全最好 |
| 认证 | Ash Authentication(装依赖与基础配置,不接 User resource) | 骨架阶段仅走通链路,认证留接口 |
| 数据库 | Ash Postgres(配置好 Repo,migration 链路保留可用) | 同上,hello query 纯计算不落库 |
| 前端 UI | HeroUI(原 NextUI,基于 Tailwind + React Aria Components) | 用户指定 |
| 前端包 | 单包 `web/` | YAGNI,后续按需拆 |
| 实现深度 | 仅骨架走通 | 先验证整条链路 |

## 3. 仓库顶层布局

```
synie/
├── backend/                # Elixir umbrella project (独立 mix)
│   ├── apps/
│   │   ├── synie_web/      # Phoenix endpoint + Ash GraphQL 挂载
│   │   └── synie_core/     # Ash resources + domain + postgres repo
│   ├── config/             # config.exs / dev.exs / runtime.exs
│   └── mix.exs             # umbrella mix.exs
├── web/                    # TanStack Start 前端 (独立 package.json)
│   ├── package.json
│   ├── app/
│   ├── codegen.ts
│   ├── app.css
│   └── vite.config.ts
└── docs/superpowers/specs/ # 本 spec 所在
```

- 仓库根**不放** `package.json`、**不放** `mix.exs`。两个项目各自独立。
- 无顶层 dev 编排脚本(各开各终端,或用户后续自行加)。

## 4. 后端内部结构

### 4.1 `backend/apps/synie_core` — Ash 领域层

**依赖**(`mix.exs`):
- `ash`
- `ash_postgres`
- `ash_graphql`
- `ash_authentication`
- `ash_authentication_phoenix`

**模块**:
- `SynieCore.Repo` — `AshPostgres.Repo`,数据访问入口
- `SynieCore.Domain` — Ash Domain,聚合 resources,声明 GraphQL 接口
- `SynieCore.Resources.Hello` — 示例 resource,暴露 GraphQL query `hello(name: String!): String!`(纯计算,不落表)
- `SynieCore.Application` — 启动 Repo 与 Domain 的 OTP application

**配置**:数据库连接由 umbrella `config/runtime.exs` 从环境变量读取,骨架阶段可指向本地 Postgres 或留默认。

### 4.2 `backend/apps/synie_web` — Phoenix Web 层

**依赖**:
- `synie_core`(umbrella 内依赖)
- `phoenix`
- `ash_graphql`
- `ash_authentication_phoenix`

**模块**:
- `SynieWeb.Endpoint` — Phoenix Endpoint,挂载 Ash GraphQL schema 于 `POST /graphql`,同时提供 GraphiQL/playground(`/graphql` GET)
- `SynieWeb.Schema` — Ash GraphQL Schema,引用 `SynieCore.Domain`
- `SynieWeb.Router` — Phoenix Router,转发 `/graphql` 到 GraphQL controller/plug

**配置**:端口 `4000`。

### 4.3 umbrella 根 `backend/`

- `mix.exs` — umbrella project,`apps:` 列出 `synie_web`、`synie_core`
- `config/config.exs` — 通用配置(编译器、Ecto repo 注册等)
- `config/dev.exs` — 开发期配置
- `config/runtime.exs` — 运行期从环境变量读取 DB URL、secret_key_base、端口

## 5. 前端内部结构

**`web/`** — 独立 bun 项目

**依赖**(`package.json`):
- `@tanstack/react-start`、`@tanstack/react-router`、`@tanstack/react-query`
- `heroui`、`tailwindcss`(v4)、`@heroui/theme`、`framer-motion`(HeroUI peer)
- `graphql`
- `@graphql-codegen/cli`、`@graphql-codegen/client-preset`

**结构**:
```
web/
├── package.json
├── vite.config.ts          # dev server 代理 /graphql -> localhost:4000
├── codegen.ts              # GraphQL codegen 配置(schema 指向后端)
├── app.css                  # Tailwind v4 入口 + HeroUI 主题
├── app/
│   ├── router.tsx           # TanStack Router 根
│   ├── client.tsx           # TanStack Start client
│   ├── routes/
│   │   ├── __root.tsx       # 根布局:HeroUI Provider + QueryClientProvider
│   │   └── index.tsx        # 首页:hello 查询 + 展示
│   ├── lib/
│   │   └── graphql.ts       # GraphQL 客户端(fetch 封装,指向 /graphql)
│   └── graphql/            # codegen 生成产物(类型 + hooks)
```

**首页行为**:加载即执行 `hello(name: "world")` GraphQL 查询,展示返回字符串,验证全链路联通。

## 6. 开发流程与联通验证

1. **启动后端**:`cd backend && mix phx.server`(或 `mix run --no-halt`),监听 `:4000`,`/graphql` 可访问 GraphiQL
2. **启动前端**:`cd web && bun dev`,Vite dev server 监听 `:3000`(或 TanStack Start 默认端口),代理 `/graphql` → `http://localhost:4000/graphql`
3. **联通验证**:打开前端首页 → 触发 `hello` 查询 → 经 Vite 代理打到后端 Ash GraphQL → 返回 `"Hello, world"` → 前端渲染显示

**数据库**:Ash Postgres + Ash Authentication 依赖装好、`SynieCore.Repo` 配置好;骨架阶段 hello query 纯计算不落库,但 `ecto.setup` / migration 链路保留可用,用户有 Postgres 即可跑通。

## 7. 不做的事(YAGNI)

- 不做顶层 monorepo 编排(bun workspaces / turborepo / nx / 根 `package.json`)
- 不做多前端包、共享 UI 包
- 不接真实 User resource 与登录流程(仅装 Ash Authentication 依赖与基础配置,留接口)
- 不做 codegen 自动 watch 脚本(手动 `bun run codegen`)
- 不做生产部署配置(Docker、release)——仅本地开发骨架

## 8. 验收标准

- [ ] `backend/` umbrella 可 `mix deps.get` + `mix compile` 通过
- [ ] `mix phx.server` 启动后,`POST /graphql` 可执行 `hello(name: "world")` 返回 `"Hello, world"`,`/graphql` GET 可访问 GraphiQL
- [ ] `web/` 可 `bun install` + `bun dev` 启动
- [ ] 前端首页加载,展示 `hello` 查询返回结果(经 Vite 代理 → 后端)
- [ ] `bun run codegen` 可从后端 schema 生成 TS 类型
- [ ] Ash Authentication + Ash Postgres 依赖装好、Repo 配置就绪(不强制 DB 跑起来,但链路可用)