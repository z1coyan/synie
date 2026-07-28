# 18 清场切流

Status: ready-for-human
Blocked by: 16, 17

## 独立复核（2026-07-28）

- 主体已交付（`7a90f70`）：`server-go/` 删除、`server-go-final` tag、OpenAPI 归档、CI/compose/README 收敛。
- 复核补丁：修正 `web/e2e` 文档与 playwright 配置仍写 Go 栈 / `*.go.e2e.ts` 的残留叙述（与 `run-smoke.sh` + `*.api.e2e.ts` 对齐）。
- 测试：shared 5、server 223（含 PG）、web 92 + check + shared/server typecheck 全绿。
- 未在本复核重跑全量 Playwright 一键（会 drop 主库）；以既有 cutover 声明 e2e 21/21 + 本次单元/集成为准。

## 范围

1. **删除/归档 server-go**（git tag `server-go-final` 后删除目录；contracts/openapi/openapi.yaml 移入 `docs/migration/` 作历史契约归档）
2. **CI 收敛**：删除 backend（Elixir）与 server（Go）两个 job；server-ts 改名主 server job；frontend job 保持
3. **compose 收敛**：删 server-go 服务；Bun server 端口回 8080（vite 代理默认目标）；migrate/seed 保持
4. **文档定稿**：根 README（单一后端叙述）、AGENTS.md、`docs/migration/` 增「Go→Bun/TS 重写完成」记录；CONTEXT.md 术语若有过渡期表述一并收敛
5. **全量验收**：CI 全绿 + Playwright e2e 全绿 + `.scratch/migration/verify-*.ts` 全套对 Bun server 全绿

## 验收

- 新克隆环境：bun install → compose up（postgres+migrate+server）→ seed → 前端全链路可用
- 仓库内无 server-go / Go 工具链引用残留（除 docs/migration 归档）
- 仓库内无 backend/ Elixir 树（tag `backend-elixir-final` 可恢复）

## 非目标（已修订）

原约定「不删除 backend/」已于 2026-07-28 撤销：用户决议纯 TS monorepo，打 tag `backend-elixir-final` 后删除 `backend/`。

## Comments

- 2026-07-28：用户确认删除 Elixir `backend/`；tag `backend-elixir-final` → `git rm -rf backend`；README 与 cutover 文档收敛为纯 TS monorepo。
