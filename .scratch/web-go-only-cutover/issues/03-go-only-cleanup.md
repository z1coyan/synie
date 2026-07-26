# Go-only 代理与 GraphQL 工具链清理

Status: ready-for-agent

Blocked by: 02

## 范围

- Vite 删除 `/graphql`、Elixir `/api` 与 `BACKEND_PORT`。
- 文件端点只走 Go `/api/v1/files*`。
- 删除 `web/app/graphql/`、`web/app/lib/graphql.ts`、`web/codegen.ts`、GraphQL codegen scripts/dependencies。
- 更新 README、迁移设计现状及 JWT 重登说明。

## 完成定义

Elixir 不启动时开发站点可用；静态搜索无产品 GraphQL 路径；前后端验收通过。

## Comments
