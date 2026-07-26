# Go-only 代理与 GraphQL 工具链清理

Status: resolved

Blocked by: 02

## 范围

- Vite 删除 `/graphql`、Elixir `/api` 与 `BACKEND_PORT`。
- 文件端点只走 Go `/api/v1/files*`。
- 删除 `web/app/graphql/`、`web/app/lib/graphql.ts`、`web/codegen.ts`、GraphQL codegen scripts/dependencies。
- 更新 README、迁移设计现状及 JWT 重登说明。

## 完成定义

Elixir 不启动时开发站点可用；静态搜索无产品 GraphQL 路径；前后端验收通过。

## Comments

### 2026-07-26

- 删除 `web/app/graphql/`、`web/app/lib/graphql.ts`、`web/codegen.ts`。
- `package.json` / `bun.lock` 移除 `graphql`、`@graphql-codegen/*` 与 `codegen` script。
- `vite.config.ts` 仅保留 `/api/v1` → Go。
- README、迁移规划、本 issue 记录 JWT 不兼容旧 token、切流须重新登录。
- 不删除 `backend/`。
