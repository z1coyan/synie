# ADR：仓库骨架（backend/ + web/ 并排）

2026-07-07。仓库不做 monorepo 编排：`backend/`（Elixir umbrella：`synie_core` 领域 + `synie_web` Phoenix）与 `web/`（TanStack Start）并排独立，根目录无顶层 `package.json`/`mix.exs`。

- **API 选 GraphQL**（AshGraphql + 前端 codegen），强类型对接优先于 REST。
- **领域与 HTTP 分离**：Ash resources 在 core 可独立测试；web 只挂 endpoint/schema。
- 认证装 Ash Authentication 基础配置，User 资源与业务模块后补。
