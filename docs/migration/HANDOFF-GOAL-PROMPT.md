# 下一轮 Agent 提示词（Goal：执行迁移）

把下面「复制区」整段粘贴给下一轮 AI（可用 `/goal` 或等价「长期目标」指令）。仓库根目录：`/home/zyan/code/synie`。

---

## 复制区开始

```
# Goal：按已批准的 R3 规划，执行 Synie 全栈迁移到 Go + 元数据框架

## 身份与硬约束
你是在 Synie ERP 仓库中工作的实现型工程 agent。项目第一语言是中文文档；代码标识符用英文。

**部署前提（必须遵守）**
- 系统 **尚未上线**：无生产用户、无停机窗口、**不要**实现双活 strangler / 资源 flag 切流 / Elixir 写禁用 plug / Phoenix.Token 或 Pbkdf2 兼容层。
- 产品路径 **只打 Go API**；Elixir `backend/` 仅作读代码、提炼契约、对照行为的参考源。
- **非 1:1 翻译** Ash Resource：按平台 / GL·Inventory 引擎 / 业务域拆深模块。
- 技术栈与边界以规划文档为准，不要另起炉灶。

## 必读（按顺序）
1. `docs/migration/2026-07-25-fullstack-meta-and-go-migration.md`（**R3 全文**，权威）
2. `docs/adr/2026-07-25-go-fullstack-meta-migration.md`
3. `CONTEXT.md`（术语）
4. 实现触及域时再读对应 `docs/adr/*` 与 `docs/产品文档/*`
5. 参考实现与契约来源：`backend/apps/synie_core`、`backend/apps/synie_web`、`web/app`（尤其 `synie-data-grid/types.ts`、`authz`、`printing`、`grid_meta.ex`）

## 目标架构（摘要）
- 新后端：`server/` — Go，chi + pgx/v5 + sqlc + goose + shopspring/decimal + oapi-codegen
- 契约：`contracts/openapi/` + `contracts/fixtures/`
- Auth：argon2id + JWT **或** PASETO（二选一写进 server README）
- 前端：保留 React 19 / TanStack Router·Start·Query / HeroUI / Bun；用 openapi-fetch 替代 GraphQL
- Meta：Go Registry 权威；GridMetaDTO 先对齐现有 TS types；Resource Client + FilterState JSON
- 引擎：`engines/gl`、`engines/inventory` 为唯一写分录入口；单据单事务过账
- Schema：阶段 0 从现库导出 **goose baseline**，此后只改 goose；允许破坏性整理

## 执行策略
1. **按 PR Plan 顺序推进**（规划文 §PR Plan），优先打通 **第 0 批 + 第 1 批**，验收标准是：
   - `server` 可启动，`/healthz` OK，连 PG
   - goose baseline 可用
   - login/me + Meta + basCurrencies CRUD/audit
   - 前端货币页与登录走 Go，不再依赖 GQL 完成该路径
   - 契约测试覆盖权限拒绝与基础 CRUD
2. 再按 2→3→4→5→N 批推进；每模块满足规划中的 **Definition of Done**。
3. 从 ExUnit / 产品文档提炼 **行为契约**（YAML/JSON fixture），在 Go 重跑；不要追求 1:1 复制 Ash DSL。
4. 金额：JSON string + half-up；数量 6 位 / 金额 2 位 / 单价 4 位（见 CONTEXT 与规划）。
5. 前端：演进 `SynieDataGrid` / `SynieRecordDrawer`，不要无故推倒 UI 设计；换 transport + Meta 客户端。
6. 可大幅重构前端与 API；**不要**实现「flag 在 GQL 与 REST 间切换写路径」。
7. 保持 git 纪律：小步可编译可测提交；不要一次 dump 无关大文件。
8. 交付新行为时同步更新产品文档/`CONTEXT.md`（若改变领域语义）；纯实现迁移以现有文档为准。
9. 遇到规划与代码冲突：**领域语义听 CONTEXT/产品文档/ADR**；传输与运行时听 R3 迁移规划。

## 明确不做
- Phoenix.Token / Pbkdf2 双栈兼容、双端口同 Token 测试
- Elixir action denylist / cutover feature flag 产品路径
- 复刻完整 Ash / Reactor / Spark DSL
- 用 float64 做金额
- 未完成引擎就让单据直接 INSERT gl/stock 分录

## 完成定义（Goal Done）
- 规划中业务能力在 Go + 新 API + 前端可运行（可分阶段，但最终应覆盖现有已交付模块）
- 前端无业务 GraphQL 依赖；CI 以 `server/` + `web/` 为主
- goose 为唯一迁移；demo/setup 或最小 seed 可用
- 关键契约与引擎不变量测试绿
- `backend/` 删除或移入 attic，并更新 README/AGENTS

## 第一步（立即执行）
1. 通读 R3 规划 PR Plan 第 0–1 批。
2. 创建 `docs/architecture/modules.md` 与 `.scratch/migration/resource-inventory.md`（若缺失）。
3. 搭建 `server/`：go.mod、chi、config、pgx、goose baseline、healthz。
4. 实现 Auth + Authz + Meta + basCurrencies 全栈证明路径。
5. 前端 Resource Client + 货币页/登录切 Go。
6. 用测试证明后，继续第 2 批，不要在骨架未绿时铺开所有域。

开始工作。遇到需要产品取舍时写进 Open Questions 或 ADR，默认选择规划已定案项。
```

## 复制区结束

---

## 使用建议

| 场景 | 建议 |
|------|------|
| 单次长会话 | 直接贴「复制区」作 goal |
| 多会话 | 每会话开头加：`继续 Goal：… 当前进度：已完成 PR-x.y，下一步 PR-x.z` |
| 只要骨架 | 在 prompt 末尾加：`本会话范围仅限 PR-0.* 与 PR-1.*，完成后停下汇报` |
| 全量 | 不加范围限制；要求阶段性汇报与可合并提交 |

**注意**：一次性「完成全部 ERP 迁移」体量约 14–22 人月量级；单次 agent 会话 realistically 只能完成第 0–1 批或再加部分第 2 批。若工具支持 goal 跨会话，用本 prompt 作持久目标，并强制「小步绿测提交」。
