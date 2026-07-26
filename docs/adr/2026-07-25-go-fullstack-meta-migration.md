# ADR：Go 全栈元数据框架与模块化迁移

2026-07-25（**R3**：未上线、大刀阔斧）。后端目标语言 **Go**；迁移为**模块化重构**（非 1:1 翻译 Ash Resource）；**全栈元数据框架**覆盖前后端。

完整规划：

**[`docs/migration/2026-07-25-fullstack-meta-and-go-migration.md`](../migration/2026-07-25-fullstack-meta-and-go-migration.md)**

## 背景

现栈 Elixir/Ash + GraphQL。元数据反射已在 BEAM 内跑通，但 Resource 巨石、生态窄。系统**尚未上线**，无生产用户与停机约束，迁移**不必**双活兼容。

## 决策

1. **后端 Go**；目录 `server/`；契约 `contracts/`；最终移除或归档 `backend/`。
2. **主 API：OpenAPI + REST**（文件/打印专用 HTTP 可保留形态）。**废弃** GraphQL 业务主路径（部分 supersede [`2026-07-07-repo-scaffold.md`](2026-07-07-repo-scaffold.md)）。
3. **Meta Registry（Go）** 为权威源；前端 Meta 客户端 + Resource Client 驱动 Grid/Filter/Command。
4. **栈**：chi + pgx/v5 + sqlc + **goose（自阶段 0 唯一 DDL）** + shopspring/decimal + oapi-codegen；前端 React/TanStack/HeroUI + **openapi-fetch**。
5. **Auth（R3）**：**argon2id** + **JWT 或 PASETO**；**不**兼容 Phoenix.Token / Pbkdf2。
6. **单目标栈**：产品只打 Go；Elixir 仅作行为/契约参考；**无**双活 flag、无写禁用 plug、无停机方案。
7. **交付序**：Meta/Authz → 主数据 → GL/Inventory 引擎 → 单据模块 → 清场。过账在同一 Go 事务内经引擎完成。

## 后果

- 开发库可随时 reset + seed；schema 允许破坏性整理。
- 工作量基线约 **14–22 人月**（见规划）。
- 执行入口：规划 PR Plan 第 0–1 批。

## 否决

- 1:1 翻译 Ash / 复刻完整 Ash DSL
- 产品路径长期 GraphQL+REST 双主
- 未上线仍做 Phoenix.Token/Pbkdf2 双栈兼容税
- 后端迁完再推倒前端 Meta
