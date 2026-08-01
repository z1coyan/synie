# Plan 002: 建立 Better Auth、Actor 与 Convex 应用内核

> **执行者说明**：严格逐步执行并运行所有验证。身份方案必须在 Plan 001 的真实 self-hosted
> deployment 上通过，不得只在 Convex Cloud 验证。遇到 STOP 条件立即报告。完成后更新
> `advisor-plans/README.md` 状态。
>
> **漂移检查（首先运行）**：
> `git diff --stat 2da55d9..HEAD -- package.json bun.lock convex web/app/lib/auth.ts web/app/lib/api web/app/routes/login.tsx web/app/routes/setup.tsx web/app/routes/_app.tsx web/vite.config.ts server/src/platform/auth server/src/platform/authz server/src/platform/setup packages/shared docs/adr docs/产品文档/系统管理.md CONTEXT.md`
> 若范围内代码变化，逐项比对下列摘录；不一致属于 STOP 条件。

## 状态

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/001-bootstrap-self-hosted-convex.md`
- **Category**: security
- **Planned at**: commit `2da55d9`, 2026-07-31

## 为什么要做

Convex 的每个 query/mutation/action 都需要一个可信身份边界，但现有 JWT 存在浏览器
`localStorage`，并由 Hono 中间件查询 PostgreSQL 组装 Actor。目标是用开源 Better Auth 的
Convex component 负责 principal/session，用现有 `Actor` 语义继续负责角色、权限和公司范围。
这样认证库不吞并 ERP 授权模型，角色变更仍在下一次函数调用立即生效。

## 当前状态

- `server/src/platform/auth/token.ts:5-34` 使用 HS256 JWT，claim 只承载 `sub=userId`。
- `web/app/lib/auth.ts:1-13` 把 token 放在 `localStorage`：

  ```ts
  const TOKEN_KEY = 'synie:token'
  export function getToken(): string | null {
    return window.localStorage.getItem(TOKEN_KEY)
  }
  ```

- `server/src/platform/auth/store.ts:24-61` 每次认证后从用户、启用角色、角色权限与公司授权重建
  Actor；权限不固化在 JWT。目标必须保留此语义。
- `server/src/platform/authz/actor.ts:5-37` 的领域边界为：

  ```ts
  export interface Actor {
    userId: string
    username: string
    name: string | null
    superAdmin: boolean
    allCompanies: boolean
    permissions: ReadonlySet<string>
    companyIds: readonly string[]
  }
  ```

  `requirePermission` fail-closed；super admin/all companies 才绕过公司过滤。
- `server/db/migrations/00001_baseline.sql:2273-2282,3832-3835` 使用 `citext` username、长度由
  service 限 1..64、全局大小写不敏感唯一；当前没有必填 email。
- `server/src/platform/auth/service.ts:14-45` 要求用户名不存在时仍走 dummy hash，错误统一为
  “用户名或密码错误”，并有登录限流。
- `server/src/platform/setup/service.ts:127-183` 通过锁保证只有一个首位管理员获胜，并在创建后
  签发登录态。并发初始化行为必须保留。
- Better Auth + Convex 官方 TanStack Start 指南要求 Convex ≥1.25、固定兼容的 Better Auth
  版本、`convex.config.ts` 注册 component、`auth.config.ts`、TanStack `/api/auth/$` 同源代理与
  SSR token helper：<https://labs.convex.dev/better-auth/framework-guides/tanstack-start>
- Better Auth username plugin 可以用 `signIn.username`，但 signup 基于 email/password，默认
  username 只允许较窄字符且长度 3..30；本项目必须显式保持 1..64、大小写不敏感 username，
  并生成不可见的内部 email：<https://better-auth.com/docs/plugins/username>
- Better Auth authorization 指南提醒：UI 应以 Convex auth state 为准，而不是 Better Auth
  session 抢跑：<https://labs.convex.dev/better-auth/basic-usage/authorization>
- Self-hosted Convex README 对 Convex Auth 提示“需手工配置，CLI 尚不支持”；因此本计划将
  self-host smoke 作为硬闸门，而不是假设 Cloud 配置等价：
  <https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md>

## 需要使用的命令

| 用途 | 命令 | 成功预期 |
|------|------|----------|
| 启动自托管栈 | `bun run dev:infra` | backend/dashboard/Postgres/MinIO healthy |
| 生成并推送函数 | `bunx convex dev --once` | exit 0，`convex/_generated` 更新 |
| Convex 类型检查 | `bunx convex codegen && bun run typecheck` | exit 0，无类型错误 |
| Convex 单测 | `bun test convex` | 全部通过 |
| Web 单测 | `cd web && bun test` | 全部通过 |
| Web 构建 | `cd web && bun run build && bun run typecheck` | 两者 exit 0 |
| 现有回归 | `bun run test` | legacy tests 全绿 |

添加依赖时只在仓库根运行 Bun；Better Auth 必须按官方兼容矩阵精确固定版本，不能使用无上限
`latest` range。提交 `bun.lock`。

## 范围

**范围内：**

- `package.json`、`bun.lock`、`convex.json`
- `convex/convex.config.ts`、`convex/auth.config.ts`、`convex/auth.ts`、`convex/http.ts`
- `convex/schema.ts`
- `convex/lib/{errors,auth,actor,permissions,companyScope}.ts`（新建）
- `convex/setup/**`、`convex/iam/**` 及其测试（仅身份所需最小用户/角色/公司授权面）
- `web/vite.config.ts`
- `web/app/lib/{auth-client,auth-server,convex}.ts`（新建）
- `web/app/routes/api/auth/$.ts`（新建）
- `web/app/routes/login.tsx`、`web/app/routes/setup.tsx`、`web/app/routes/_app.tsx`
- `web/app/lib/auth.ts`、`web/app/lib/api/session.ts`（迁移后删除或改为无 token compatibility stub）
- 对应 auth/setup web tests 与 E2E
- `docs/adr/2026-07-31-convex-auth-and-actor.md`（新建）
- `docs/产品文档/系统管理.md`（只更新用户可感知的登录/初始化行为）
- `CONTEXT.md`（仅在引入新的领域术语时；不要写 Better Auth 实现细节）
- `advisor-plans/README.md` 状态行

**范围外：**

- 业务资源表、GL、库存、文件、打印。
- 把 ERP permission/company scope 改成 Better Auth organization/admin plugin。
- 邮箱验证、公开注册、OAuth、2FA；首期保持用户名+密码。
- 让 legacy Hono API 接受 Better Auth token。迁移开发使用全局 backend mode，不建 token bridge。
- 删除现有 Hono auth；Plan 008 在整站切流后删除。

## Git 工作流

- 分支：`advisor/002-convex-auth-kernel`
- 先提交 self-host auth spike，再提交 Actor/kernel，再提交 UI/auth 切片与文档。
- 建议提交：`feat(auth): 建立 self-hosted Convex Better Auth 边界`。
- 不 push、不发布 secret、不修改 production environment。

## 步骤

### Step 1: 在真实 self-hosted deployment 完成 Better Auth 兼容性 spike

按官方 TanStack Start 指南安装并固定兼容版本：`convex`、`@convex-dev/better-auth`、
`better-auth`、`@convex-dev/react-query`。注册 component、auth provider 和 `/api/auth/$` proxy；
使用 Plan 001 的 `CONVEX_SELF_HOSTED_URL`、admin key、site URL，不能创建 Cloud deployment。

Spike 必须证明：

1. component schema/code 能推送到 self-hosted backend；
2. TanStack Start 同源 cookie 能完成 signup/signin/signout、刷新后恢复、SSR authenticated query；
3. backend/dashboard 重启后 session 仍有效；
4. secure cookie、trusted origin、proxy headers 在本地反向代理形态正确；
5. package 的 self-hosted URL 与 `.site` HTTP action URL均可配置，不硬编码 `convex.cloud`。

把确切兼容版本与环境变量名称记录进 ADR；secret 只通过 `convex env set`/secret manager 写入。

**Verify**：运行 `bunx convex dev --once`，随后针对本地 self-host URL 的 auth smoke 测试完成
注册→登录→SSR query→重启 backend→query→退出，全部 exit 0；`rg -n "convex\.cloud" convex web`
除文档测试 fixture 外无命中。

### Step 2: 保持用户名登录而不伪造用户可见 email

配置 Better Auth username plugin：

- 登录只展示/接收 `username + password`，关闭公开 email signup UI。
- username 先 trim，再按与 PostgreSQL `citext` 等价的稳定 lowercase key 唯一；保留原始
  display username。
- validator 保持当前 1..64 非空 Unicode 约束，不采用 plugin 默认 3..30/ASCII 限制。
- Better Auth 仍要求 email 时，由受信任的 Convex user-management mutation 生成
  `<random-auth-id>@internal.syn.ie`；永不展示、搜索或允许用户修改，不从 username 拼接。
- 禁用用户名可用性公开枚举端点；错误继续统一为“用户名或密码错误”。
- 登录限流配置为至少与当前 10 次/5 分钟相同，并覆盖 IP+规范化 username；成功清理失败计数。

不要把 Better Auth 的 user row 当业务 `sysUsers`。在 app schema 建立 `appUsers`，保存
`authUserId`、username/display/name、superAdmin、allCompanies 等 ERP 字段，并用唯一 index
连接 principal。

**Verify**：表驱动测试覆盖大小写碰撞、1/64 字符、Unicode、空白、错误用户等时失败耗时不
泄漏明显存在性、11 次失败限流、内部 email 不出现在任何 `me`/Catalog/UI response。

### Step 3: 建立统一 Actor 与函数包装器

在 `convex/lib/auth.ts`/`actor.ts` 实现：

- `requireIdentity(ctx)`：验证 Better Auth session，返回 auth user id。
- `requireActor(ctx)`：按 `authUserId` index 读取 `appUsers`，再读取启用角色权限与公司授权，
  组装与现有接口同语义的 Actor。找不到 app user 时 fail-closed unauthorized。
- `requirePermission(actor, code)`、通配匹配和 `canAccessCompany`；从现有纯函数移植行为，不
  复制 Hono/Kysely 依赖。
- `authedQuery/authedMutation` 与 `permissionedQuery/permissionedMutation` wrapper。公开函数
  必须经 wrapper；internal functions 只能由已鉴权入口调用，并在命名/注释中写清边界。
- action 先以 identity 调 internal query 取得 Actor/授权快照；任何最终写入仍由 internal
  mutation 重新鉴权，不能信任 action 传回的 permission list。

权限和公司范围不要放进长寿命 JWT。角色/公司授权 mutation 完成后，下一次 query 必须立即
反映，不要求重新登录。

**Verify**：单测覆盖 unauthenticated、未知 app user、普通权限、通配权限、super admin、
all companies、空 company list、角色停用、授权在同一 session 下即时变更。所有公开
`convex/**/*.ts` 函数通过架构测试，禁止裸 `query()`/`mutation()` 绕过 wrapper（auth/http
入口列白名单）。

### Step 4: 固化错误 envelope 与安全日志

在 `convex/lib/errors.ts` 定义唯一 `ConvexError` data 形状：

```ts
type SynieErrorData = {
  code: 'validation' | 'unauthorized' | 'forbidden' | 'not_found' |
        'conflict' | 'rate_limited' | 'internal'
  message: string
  fields?: Record<string, string[]>
}
```

提供构造器和 web mapper，保持当前 `AppError/APIError` 的中文 message、field errors 和 toast
行为。未知异常只记录 correlation id，在客户端返回通用中文错误；不得输出 stack、credential、
S3 key capability 或内部 email。

**Verify**：每个错误码至少一个函数→web mapper 测试；未知 Error response 不含原 message/stack；
self-hosted 客户端日志脱敏设置由 Plan 001 smoke 再次确认。

### Step 5: 原子迁移初始化向导与用户管理最小闭包

建立 `setupState` 单例文档和首用户 mutation：

- 同一 mutation/component transaction 内检查未初始化、创建 Better Auth principal、创建
  `appUsers` super admin/all companies，并返回 session 所需结果。
- 两个并发请求只能一个成功；另一个得到现有中文 conflict。
- 如果 component adapter 无法保证跨 component/app table 原子性，实现带唯一 idempotency key
  的显式补偿，并用故障注入证明不会留下“能登录但无 Actor”或“Actor 无凭证”的半状态。
- 用户创建、密码重置、删除/注销通过受权限保护的 Convex mutation 调 Better Auth server API；
  不开放客户端任意 signup。
- role/permission/company schemas 只实现 Actor 所需闭包；完整 Resource Catalog binding 在后续计划。

**Verify**：把现有 `server/src/platform/setup/setup.integration.test.ts` 的并发首用户、重复初始化、
登录续作场景移植到真实 self-hosted 集成测试；故障注入后重试收敛为一个可登录 Actor。

### Step 6: 接入 TanStack Start auth，但以全局 backend mode 隔离迁移

建立 `VITE_SYNIE_BACKEND=legacy|convex`（或等价 server-side env）并满足：

- 默认仍为 `legacy`，当前完整产品和 CI 不被未完成迁移阻断。
- `convex` 模式使用 `ConvexBetterAuthProvider`、SSR `getToken` helper、cookie session 和
  `useConvexAuth()`/AuthBoundary；不读写 `synie:token` localStorage。
- 一个进程只能选一个 mode；代码不得在一次页面/事务中 fallback 到另一个后端。
- convex 模式首期只开放 login/setup/最小 authenticated shell；未迁移业务菜单 fail-closed。
- signout 清理 Catalog/React Query cache 并按官方 TanStack 指南 reload，避免 auth readiness race。

保留 legacy auth 文件供默认模式使用，Plan 008 再删除。通过模块边界隔离，不在页面散落 env
分支。

**Verify**：分别以 legacy/convex mode 构建；legacy E2E 不变，convex E2E 完成未初始化→首管理员
→登录 shell→刷新 SSR→退出→重登。浏览器 storage 中没有 `synie:token`（convex mode），cookie
为 HttpOnly/SameSite/Secure（production config）。

### Step 7: 记录 ADR 与用户可感知行为

ADR 必须记录：Better Auth 只管认证、ERP Actor 继续管授权；内部 email 策略；session cookie；
self-host smoke 结果；全局迁移 mode 是临时设施、Plan 008 删除。`docs/产品文档/系统管理.md`
只更新登录、退出、初始化和密码管理的用户行为，不写 package/表结构。没有新领域术语则不改
`CONTEXT.md`。

**Verify**：所有新增链接存在；`rg -n "localStorage|synie:token" docs/产品文档/系统管理.md`
无实现细节；`git diff --check` 通过。

## 测试计划

- 真实 self-host integration：注册被关闭、管理员创建用户、username 登录、cookie refresh、
  restart persistence、logout/session revoke。
- 安全：用户枚举、限流、CSRF/trusted origin、secure cookie、未知错误脱敏。
- Actor：角色/权限/公司即时变更、disabled role、super admin、无 app user fail-closed。
- Setup：20 个并发首用户请求只有 1 个成功；在 principal/app user 两阶段注入错误后可重试收敛。
- Web：SSR 首屏、auth loading、退出 reload、Catalog cache 按 actor 隔离。
- 回归：legacy mode 的 `bun run test`、web test/build/typecheck 全绿。

## 完成条件

- [ ] Better Auth + Convex component 在 self-hosted deployment 上通过完整 smoke。
- [ ] 用户仍以 1..64 username 登录，无用户可见 email 要求，无公开注册。
- [ ] Convex session 不使用 localStorage；production cookie 安全属性正确。
- [ ] 所有公开业务函数都有统一身份/权限 wrapper，角色变更立即生效。
- [ ] 并发初始化仅一个首管理员，故障注入无半创建身份。
- [ ] 错误 envelope 与现有 web field/toast 语义对齐，内部错误不泄漏。
- [ ] legacy 与 convex 两种进程模式都能构建，且单次运行不混合后端。
- [ ] `bunx convex codegen && bun run typecheck && bun run test` 全绿。
- [ ] 文档/ADR 更新，secret scan 无命中，范围外无修改。
- [ ] `advisor-plans/README.md` 状态为 DONE。

## STOP 条件

- Better Auth component 无法在 self-hosted Convex 推送 schema、注册 HTTP route 或持久化 session。
- TanStack Start helper 需要硬编码 `*.convex.cloud`/`*.convex.site`，无法配置 self-host URL。
- username plugin 无法在不改变 1..64、大小写不敏感语义的前提下登录。
- 首用户无法做到原子或可证明的幂等补偿，出现孤儿 principal/app user。
- 必须把 permission/company scope 固化进 session/JWT 才能继续。
- 必须让一次业务请求同时调用 legacy 和 Convex 后端。
- 需要开放公开 signup、要求业务用户提供 email，或把 Better Auth organization 当 ERP 公司。
- 范围内代码与计划摘录漂移。

## 维护说明

- 升级 `better-auth`、`@convex-dev/better-auth` 或 Convex 时必须按兼容矩阵成组升级，并重跑
  self-host auth smoke；不要只依赖 TypeScript 编译。
- 内部 email 是认证适配细节，不得进入 Resource Catalog、打印、审计 label 或用户 UI。
- Better Auth principal id 与 ERP `appUsers._id` 是两个身份；领域表只引用 ERP user id，外部
  session 只通过 `authUserId` index 映射一次。
- Plan 008 会删除 legacy auth 与 backend mode。若该临时 mode 开始被业务逻辑依赖，应立即停止
  扩散并收口。
