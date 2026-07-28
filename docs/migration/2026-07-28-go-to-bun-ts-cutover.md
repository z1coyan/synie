# Go → Bun/TS 重写完成（清场切流）

| 字段 | 值 |
|------|-----|
| **文档类型** | 迁移完成记录 |
| **日期** | 2026-07-28 |
| **状态** | **完成** |
| **工单** | `.scratch/ts-backend-rewrite/issues/18-cleanup-cutover.md` |
| **相关** | 前期规划 `2026-07-25-fullstack-meta-and-go-migration.md`；规格 `.scratch/ts-backend-rewrite/` |

## 结论

产品栈为 **纯 TypeScript monorepo**：`server/`（Bun + Hono + Kysely）+ `web/`（TanStack Start）+ `packages/shared`。  
工作树内不再包含 Go（`server-go/`）或 Elixir（`backend/`）运行时与源码树。

## 清场动作（工单 18 + Elixir 归档）

1. **Git tag `server-go-final`**：删除前对含 `server-go/` 的提交打注记标签，便于考古。
2. **删除 `server-go/`**：目录与 Go 模块、Makefile、oapi-codegen/sqlc 配置一并移除。
3. **OpenAPI 归档**：原 `contracts/openapi/openapi.yaml` 移至  
   `docs/migration/openapi-server-go-final.yaml`（历史 wire 形状；**类型事实源**为 `server/src/app.ts` 的 `ApiType` + `hono/client`）。
4. **CI 收敛**（`.github/workflows/ci.yml`）：
   - 删除 Elixir `backend` job；
   - 删除 Go `server` job；
   - 原 `server-ts` 改名为主 `server` job（Bun typecheck + test + Kysely codegen freshness）；
   - `frontend` job 保持。
5. **Compose 收敛**（`compose.yaml`）：删除 `server-go` 服务；Bun `server` 映射 `8080:8080`（与 Vite 默认代理一致）；保留 `migrate` / `seed`（tools profile）。
6. **文档**：根 `README.md`、`AGENTS.md`、`CONTEXT.md` 过渡期表述收敛；本文件为完成记录。
7. **Git tag `backend-elixir-final` 后删除 `backend/`**（Elixir/Phoenix/Ash 参考实现；2026-07-28 另决议，纯 TS monorepo）。

不要求改写 `server/` 源码内「对齐历史 Go 行为」类注释（语义考古，非工具链依赖）。

## 新克隆验收路径

```bash
bun install
docker compose up --build server          # postgres + migrate + API :8080
docker compose --profile tools run --rm seed   # 可选
cd web && bun dev                         # :3000 → 代理 /api/v1 → :8080
```

## 恢复历史树

```bash
# Go
git checkout server-go-final -- server-go
# 或：git worktree add ../synie-server-go server-go-final

# Elixir
git checkout backend-elixir-final -- backend
# 或：git worktree add ../synie-backend-elixir backend-elixir-final
```
