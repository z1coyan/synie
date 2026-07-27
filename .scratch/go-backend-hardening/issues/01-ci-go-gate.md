# 01 — CI 增加 Go server 门禁

**What to build:** 推送代码后，CI 会对 Go server 做完整门禁：格式与静态检查（gofmt、go vet）、单元测试，以及代码生成物新鲜度校验——若 OpenAPI/查询 SQL 变更后忘记重新生成，CI 直接失败。目标栈（`server/`）从「无门禁」变为与前端同级的受保护状态。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] CI 新增 Go server job：gofmt -l 为空、go vet 通过、go test ./... 通过（无数据库环境下 PG 集成测试允许 Skip）
- [x] CI 执行代码生成（sqlc + oapi-codegen，工具版本沿用 server Makefile 的 pin）后工作区无 diff，否则失败
- [x] 既有 Elixir backend job 与前端 job 不受影响
- [x] server Makefile 补充 lint/vet/verify-codegen 目标供本地使用，CI 与本地命令同源

## Result

已完成，改动两个文件：

- `.github/workflows/ci.yml`：新增 `server` job（`Go server (lint + test + codegen freshness)`），`defaults.run.work-directory` 为 `server`，步骤为 setup-go → `make lint` → `make test` → `make verify-codegen`。既有 Elixir backend 与前端 job 未改动。
- `server/Makefile`：新增 `lint`（gofmt -l 为空检查 + `go vet ./...`，失败时列出未格式化文件）与 `verify-codegen`（`make generate` 后 `git diff --exit-code`）目标，CI 直接调用这些目标，本地与 CI 同源。

关键决策：

- **Go 版本来源**：`actions/setup-go@v5` 的 `go-version-file: server/go.mod`，以 go.mod 的 go 指令为准，升级 Go 只改 go.mod 一处。
- **缓存策略**：复用 setup-go 内置缓存（GOMODCACHE + 构建缓存），`cache-dependency-path` 显式指向 `server/go.sum`（go.sum 不在仓库根，默认值找不到）。
- **gofmt 范围**：Makefile 里 `gofmt -l .` 在 server/ 下执行，天然只覆盖 server/。
- **diff 范围**：`verify-codegen` 的 `git diff --exit-code` 用 pathspec 限定 `internal/http/gen` 与 `internal/db/dbgen` 两个生成物目录，避免仓库中其他未提交改动（如本地开发中的文件）误伤；CI fresh checkout 下等价于全量 diff。
- **路径配对**：oapi-codegen 的 spec 相对路径 `../contracts/openapi/openapi.yaml` 依赖「在 server/ 下执行 + 检出完整仓库」，CI 的 working-directory 与此配对，无需额外配置。
- **PG 测试**：本 job 不配 postgres service，`*_postgres_test.go` 在无 DATABASE_URL 时自行 Skip（本地已验证全部通过）；CI 跑 PG 由后续工单负责。

本地验证（export PATH=$PATH:/usr/local/go/bin，在 server/ 下）：

- `make lint`：通过（gofmt 干净、vet 无告警）。
- `make verify-codegen`：通过。首次执行时发现 `internal/db/dbgen/` 部分生成物为 root 属主（疑为历史上在容器内生成）导致 sqlc 覆写失败；删除该目录下生成物后重新生成，内容级 diff 为空，说明生成物本身是新鲜的。生成物未做任何手工修改。
- `make test`：全部通过，PG 集成测试按预期 Skip。
