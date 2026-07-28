# 14 行情 + 后台作业

Status: done
Blocked by: 02

## 范围

1. **行情品种**（来源类型/默认价类/外部代码与品种组映射；停用拦新；无价点可删）
2. **行情价点**（只追加；(品种,观测时刻,价类) 有效唯一；作废/更正；币种单位与品种一致校验）
3. **取价**（≤目标时点最近有效价点；价类回落品种默认）
4. **拉取通道与调度**（外部最新价代码/品种组；定时总开关/最新价间隔 30/60/120/结算自动补落 sys_setting；交易时段间隔拉最新价、工作日日盘后补持仓量最大合约结算价；手动刷新；上次拉取摘要）
5. `src/jobs/` 进程内 scheduler（setInterval 形态，不引外部队列；优雅停机）

## 行为参考

`server-go/internal/domain/base/`（行情主数据）与 `server-go/internal/jobs/marketsched/`；CONTEXT 行情词条。

## 验收

- `verify-market-rest.ts` 全绿
- 取价规则/价点唯一/调度决策纯函数测试；scheduler 可注入时钟

## 非目标

行情挂钩定价结算（预留未实现，维持现状）。

## Comments
- 2026-07-28 集成：主仓 cherry-pick 行情服务 + marketsched；AppDeps.market 统一；进程内调度 start/stop 接入 index。
- 2026-07-28 补齐：market.integration 自愈 inactive CNY / 已有 quantity 基准单位；`:18091` `verify-market-rest` → `ok meta=2 instruments=5 points=4 chart=3 series=2 refresh=3 audits=17`；fetch/quote/unique/sched 单测绿。
- 2026-07-28 收口复验：`:18091` market-rest 全绿；取价/唯一/decision/scheduler 时钟注入/integration 绿；status→done。
- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
