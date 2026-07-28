# 08 销售/采购对账

Status: ready-for-human
Blocked by: 06, 07

## 范围

1. **销售对账单**（常规：草稿→客户已确认→已结单，确认占量可撤回；赠送/样品：草稿→已结单可作废；条目池同公司同对手已审核未作废发货且剩余可对账>0；行金额链×源订单汇率；已对账数量投影回写；有已对账数量的发货不可作废）
2. **采购对账单**（镜像；条目双来源恰一：采购入库/委外入库——委外来源在工单 10 后启用，接口预留）
3. 确认/撤回/结单的数量消耗时点与回滚；分次对账 2 位尾差不强行配平

## 行为参考

`server-go/internal/domain/fulfillment/`（对账服务）；CONTEXT「销售对账单」「采购对账单」「对账类型」「已对账数量」词条。

## 验收

- `verify-supply-reconciliation-rest.ts` 全绿
- 消耗时点/回滚/尾差/作废联动测试

## 非目标

发票关联结单（工单 09 实现触发面，本工单预留关联字段与状态口径）。

## Comments

- 2026-07-28 主工作区集成：cherry-pick 三连 `297003d`（对账+订单流投影）/ `91ad100`（orderflow permission-first）/ `c402724`（发货作废联动+发票 close/reopen 接缝测试）；app/index/Meta/helpers 装配已在候选提交内完整挂载。验证：`bun run typecheck` 绿；`SYNIE_TEST_DATABASE_URL=… bun test` 197 pass；`verify-supply-reconciliation-rest.ts` against :18081 → `ok: meta=12 permissionFirst=41 sides=2 actions=8 orderFlowOR=4`。遗留：发票审核/作废触发 closeFromInvoice/reopenFromInvoice（工单 09）；委外入库完整生命周期（工单 10，对账侧来源与投影已预留）。
