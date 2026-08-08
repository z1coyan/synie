# jobs/ — 后台作业

行情拉取调度：定时总开关/最新价间隔/结算自动补落 `sys_setting`；
交易时段按间隔拉最新价，工作日日盘收市后补结算价；手动刷新立即拉。

文件存储对账（filesclean）：每日一次（上海时区 `FILE_RECON_RUN_HOUR` 点，默认 3 点）
比对 `sys_file` 行与对象存储清单——孤儿对象（存储有、DB 无，超
`FILE_RECON_ORPHAN_GRACE_HOURS` 宽限，默认 24h）默认只报告（`FILE_RECON_DRY_RUN`
默认 true），缺失对象（DB 有、存储无）只告警；成败摘要落
`sys_setting.file_recon_last_*`。对账领域逻辑住 `platform/files/reconcile.ts`，
本目录只做调度。

- 行为参考：`server-go/internal/jobs/marketsched/`
- 形态：进程内 scheduler（`setInterval`），不引外部队列；`stop()` 优雅停机
- 决策纯函数：`marketsched/decision.ts`、`filesclean/decision.ts`（可注入时钟的 scheduler 见各自 `scheduler.ts`）
