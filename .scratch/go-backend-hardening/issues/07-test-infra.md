# 07 — 测试基础设施沉淀（testutil + CI 跑 PG 集成测试）

**What to build:** 写测试的人不再需要复制粘贴基础设施：`internal/testutil` 提供统一的真实数据库门控与建库助手（消灭现有 12+ 处逐文件复制的环境变量检查样板），测试数据库的准备、迁移、清理一个函数搞定。更重要的是，PG 集成测试从「只在开发者本地跑、CI 永远 Skip」变为在 CI 真实运行——用 CI 的 PostgreSQL service 或 testcontainers 二选一落地，迁移类 bug 在合并前被拦住。

**Blocked by:** 01 — CI 增加 Go server 门禁（CI job 存在后才有挂载 PG 测试的位置）

**Status:** ready-for-agent

- [x] `internal/testutil` 落地，各域 postgres_test 的门控/建库样板全部替换为公共助手
- [x] CI 中 Go 测试在真实 PostgreSQL 上运行，PG 集成测试不再 Skip
- [x] 测试数据库隔离策略明确（每包独立 schema/库或等价机制），并发跑测试不互相干扰
- [x] 本地 `make test` 体验不变或更好

## Result

**testutil API**（`server/internal/testutil/testutil.go`）：
- `testutil.DatabaseURLEnv`：门控变量名常量（`SYNIE_TEST_DATABASE_URL`）。
- `testutil.DatabaseURL(t)`：读门控变量，未设置时统一 `t.Skipf`（文案全仓库一致）。
- `testutil.NewPool(t, ctx)`：门控 + `pgxpool.New` + `t.Cleanup(pool.Close)`，建池失败 `t.Fatalf`；超时由调用方 ctx 决定。
- 包注释写明了测试数据库隔离约定（见下）。

**样板迁移**：45 个 `*_test.go`、49 处 `os.Getenv("SYNIE_TEST_DATABASE_URL")` 门控 + 50 处建池段全部替换（含 fixture 助手、`numberingTestPool`、market/marketsched 的 `testDatabaseURL` 本地 helper 两个删除；`defer pool.Close()` 变体统一为 Cleanup；此前未关闭 pool 的 fixture 现在由 `NewPool` 注册 Cleanup 兜底，`pgxpool.Close` 幂等，错误路径上的显式 `pool.Close()` 不受影响）。迁移后全仓库测试文件已无 `SYNIE_TEST_DATABASE_URL`/`os.Getenv` 残留。特殊语义保留：marketsched 的唯一标记重置、numbering 的 `t.Cleanup(cancel)` 变体、reconciliation 的 `context.Background()` 等均未动测试逻辑。

**CI**（`.github/workflows/ci.yml` server job）：新增 `postgres:17-alpine` service（与 `compose.yaml` 对齐，healthcheck `pg_isready`），job 级 `SYNIE_TEST_DATABASE_URL` 指向 service；Lint 后先 `make migration-up`（`DATABASE_URL` 复用同一 DSN）再 `make test`——PG 集成测试在 CI 真实运行。无该变量的本地 `make test` 体验不变（门控 Skip）。

**Makefile**：新增 `test-integration`（带 `SYNIE_TEST_DATABASE_URL` 跑全套，默认指向 compose 本地测试库，可被环境变量覆盖）。`server/README.md` 补了对应说明。

**隔离调查与轻量修复**（约定已写入 testutil 包注释）：
- 现状：全部 PG 测试共享一个库、按包并行；隔离靠 uuid 后缀唯一键 + `t.Cleanup` 清自建数据；`sys_setting` 共享单行由 settings/market（保存-还原）与 marketsched（唯一标记重置，本工单未重复修）各自缓解。
- 修复 1（外键竞争）：numbering `service_postgres_test.go` 与 files `strict_postgres_test.go` 用 `SELECT ... ORDER BY iso_code LIMIT 1` 借用共享币种行，并行包清理临时币种后引用即 FK 失败（全套跑时实际复现）；改为各自插入唯一 iso_code 的币种并登记清理。
- 修复 2（唯一索引竞争）：`bas_unit` 对 `is_base=true` 有全库唯一的每类型一行约束；quotation fixture 用字面量 `'quantity'` 插基准单位，与并行包同类插入撞唯一索引（全套跑时实际复现）；改为 `"quotation-"+suffix` 唯一类型，与 order/standard/outsourced 既有约定一致。

**验证**（Go 1.26，本地测试库已迁移至 version 3）：
- 无 DB：`go test ./...` exit 0，49 包 ok（PG 测试全 Skip）。
- 带 DB：`SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable go test -count=1 ./...` exit 0，49 包 ok（PG 集成测试真实执行）。
- `DATABASE_URL=... make migration-up` 验证通过（goose 幂等）；改动文件 gofmt 干净（仓库内仍有少数未格式化文件属于并行工单的非测试实现代码，不在本工单范围）。

**注意**：并行工单新增的 `internal/platform/printing/render_postgres_test.go`（未跟踪文件）仍自带一份门控样板且用字面量 `'quantity'` 插基准单位——当前因 quotation 已改唯一类型而不冲突，建议该工单后续改用 `testutil` 助手并遵循唯一 unit_type 约定。
