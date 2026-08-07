# 放弃 Convex 迁移，产品后端保持 Bun/Hono

日期：2026-08-01（事实发生）/ 2026-08-07（本 ADR 补记，防重议）  
状态：已实施  
相关提交：`01dd2960`（`revert: 放弃 Convex 迁移，恢复 Bun/Hono 技术栈（PR #45、#46）`）  
考古标签：`convex-migration-final`（Convex 最终树快照，只读查阅）

## 背景

2026-07 末至 08 初曾评估并部分落地「自托管 Convex 后端」迁移（PR **#45** 迁移评估与切换、PR **#46** 本地空库 Setup 复位等）。线上/闭环验证后决定**整体放弃**，以 revert 将工作树恢复为迁移前 Bun + Hono + Kysely + PostgreSQL 栈，并继续在该栈上演进（含后续标准动作内核、聚合单据内核等）。

若无书面 ADR，后续会话易把 Convex 相关目录、advisor-plans 或标签误读为「进行中主线」。

## 决定

1. **产品后端唯一主线**仍是 `server/`：**Bun + Hono + Kysely + PostgreSQL**（见 `server/README.md` 技术栈定案）。契约即代码：`ApiType` + `hono/client`。
2. **Convex 不作为**产品路径、双活后端或渐进切换目标；不维护 Convex schema/生成物/自托管编排为发布物。
3. 放弃动作以 git **整树 revert** 落定（`01dd2960`）；工作树与迁移前基线一致。Convex 终态仅存标签 **`convex-migration-final`**，供考古，**不**作为合入或部署源。
4. 前端 Resource Catalog / 聚合草稿 Adapter / 标准动作与聚合内核等能力均在 **Hono 服务端模块** 上实现，不依赖 Convex mutation/query 模型。

## 后果

- 文档、CI、compose、依赖以 Bun/Hono 为准；出现 `convex/` 应用代码或「迁 Convex」工单应视为与本 ADR 冲突，需先废止本决定再开新评估。
- 历史 PR #45/#46 与标签保留可追溯；新功能不得以「接上 Convex 迁移」为默认假设。
- 架构评审候选若再提 BaaS/实时同步后端，须**新开 ADR** 并显式 supersede 本文，不得静默复活旧分支。

## 否决

- 在产品主线上并行维护 Convex 与 Hono 双后端。
- 以「只迁只读查询」等方式部分复活 Convex 而不经新 ADR。
- 删除 `convex-migration-final` 标签（失去考古坐标）；亦不得把该标签内容重新合入 `main` 当主线。
