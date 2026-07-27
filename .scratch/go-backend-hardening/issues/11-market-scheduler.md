# 11 — 行情定时调度器迁移

**What to build:** 系统设置中的行情拉取定时开关、最新价间隔、结算自动补在 Go-only 部署下真实生效：Go 进程内建定时调度，按设置周期自动拉取行情并在结算后补拉，运行摘要写回设置单行表（与 Elixir 时代的 `sys_setting` 摘要字段语义一致）。手动刷新端点行为不变，调度与手动共用同一拉取实现。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] Go 服务进程内含行情调度器，开关/间隔读取现有系统设置，改设置后按约定时机生效
- [x] 运行摘要（上次运行时间/结果）写回设置表，字段语义与 Elixir 版一致
- [x] 结算自动补逻辑等价迁移
- [x] 调度器并发安全（服务单实例假设成立，或有多实例防护说明）
- [x] 手动 refresh 端点与调度路径共用实现，相关测试全绿

## Comments

语义判定记录（对照 Elixir `MarketFetch.Scheduler` / `Sessions` / `Setting`）：

1. **摘要标签**：Elixir 分手动/定时两类标签——`refresh` 写「手动刷新」、`refresh_lasts` 写「定时最新价」、`refresh_settlements` 写「定时结算价」，格式均为 `标签: 成功X 跳过Y 失败Z[ 失败例 code:msg]`。Go 侧 `recordRefreshSummary` 参数化标签，三种标签逐一对应；定时路径与 Elixir 一致，仅在确有品种参与（items 非空）时写摘要，手动路径保持每次必写。
2. **槽位容差**：Elixir 最新价要求「槽内第 0–1 分钟」（容忍 60s tick 漂移），结算要求 `{hour, minute}` 精确落在 15:30/16:00/16:30/17:00——精确匹配在 tick 漂移时可能错过整槽。Go 判定为：结算槽同样给 0–1 分钟容差（`slot <= mins <= slot+1`），配合 (上海日历日, 槽位) 去重，语义等价（每槽至多触发一次、失败等下一尝试槽重试），且对漂移更稳健。
3. **生效时机**：每节拍（60s，首拍延迟 5s 对齐 Elixir）重读 `sys_setting`，开关/间隔变更在下一节拍内生效，不做热更新。
4. **非法间隔**：`normalize_interval` 非 30/60/120 按 60 计，与 Elixir 一致（设置服务层本已校验，调度侧仍兜底）。
5. **actor**：调度路径以 nil actor 拉取与写摘要（审计行 actor 字段落 NULL，等价 Elixir 的 `authorize?: false` 受信路径）。
6. **panic 处理**：Elixir 依赖 GenServer 监督树重启、不写摘要；按本工单要求 Go 侧 recover + 记日志 + 写「标签: 运行异常: …」失败摘要（脱钩父 ctx 限时 10s 尽力写回）。

## Result

- 新包 `server/internal/jobs/marketsched/`（对齐迁移规划的 internal/jobs 设想）：
  - `decision.go`：纯函数 `Decide(cfg, now, prevState) Decision`——总开关、间隔槽对齐（30/60/120，非法按 60）、交易时段（日盘 09:00–15:05 / 夜盘 21:00–02:35 上海）、结算尝试槽（工作日 15:30/16:00/16:30/17:00）、(日期, 槽位) 去重；表驱动单测覆盖开/关、间隔边界、首次运行、周末跳过、同槽去重。
  - `scheduler.go`：单 goroutine 调度循环（首拍 5s、之后 60s 一拍），同步执行拉取天然防重入（另有 atomic 兜底）；每拍重读 `sys_setting`；`runSafely` recover panic + slog 日志 + 失败摘要写回；ctx 取消即退出。
- `internal/domain/base/market/fetch.go`：新增 `RefreshLasts(WithClient)` / `RefreshSettlements(WithClient)` 定时入口，复用与手动 refresh 相同的 `fetchLast`/`fetchSettlement`/`fetchableInstruments` 实现；`recordRefreshSummary` 标签参数化（手动刷新/定时最新价/定时结算价）。
- `cmd/synie/main.go`：装配 `marketsched.New(pool, logger).Run(rootCtx)` 随进程启动、随信号优雅退出。
- 测试：`go test -count=2 -race ./internal/jobs/marketsched ./internal/domain/base/market ./cmd/synie` 全绿（含 PG 测试：调度节拍摘要经 `sys_audit_log` actor NULL 行断言、panic 失败摘要写回；注入 runner 限定品种避免跨包测试竞态）。`internal/platform/settings` 未改动，回归通过。
