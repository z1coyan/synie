# 14 行情 + 后台作业

Status: ready-for-human
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
