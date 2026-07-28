# jobs/ — 后台作业（骨架）

行情拉取调度：定时总开关/最新价间隔/结算自动补落 sys_setting；
交易时段按间隔拉最新价，工作日日盘收市后补结算价；手动刷新立即拉。
- 行为参考：`server-go/internal/jobs/marketsched/`
- 形态：进程内 scheduler（setInterval/定时器），不引外部队列
- 实现工单：`.scratch/ts-backend-rewrite/issues/14-market-jobs.md`
