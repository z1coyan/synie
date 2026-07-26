# Batch 1 验收记录

验收日期：2026-07-25。

## 已完成表面

- Auth：argon2id 密码、JWT HS256、登录限流、`/auth/login`、`/auth/me`。
- Authz：Actor 每请求从库构建；权限码与公司范围按请求生效。
- Meta：Go Registry 是 `basCurrencies` 的唯一运行时权威源；Meta 与迁移前真实
  GraphQL 快照做语义对比。
- Filter：列白名单、参数化 predicate、稳定排序和分页。
- 币种：Meta、查询、读取、创建、更新、删除、审计、唯一冲突、公司本币保护。
- 全局门控：`setup/status` 与 `todos/unread-count` 已切到 Go，避免币种竖切被
  全局组件偷偷带回 GraphQL。
- 前端：登录、会话、币种 Grid/Drawer/状态动作使用显式 `ResourceClient` 和
  `openapi-fetch`；没有运行时双栈开关。

## 可复核证据

- `go test ./...`：通过。
- `bunx tsc --noEmit`：通过。
- `bun test`：30 项通过。
- `bun run build`：通过。
- goose 基线在专用空库执行 `up -> down -> up`：通过。
- 真实 PostgreSQL API 冒烟：登录、Meta、币种 CRUD/筛选/冲突/引用保护/审计通过。
- Chromium：`bun run e2e:go` 通过；从币种页就绪开始监控到清理结束，
  GraphQL 请求为 0。
