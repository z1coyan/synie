# 12 财务运营：银行 / 票据 / 报销单

Status: ready-for-human
Blocked by: 05, 09

## Comments

- 2026-07-28 子代理：实现银行账户/流水/导入模板批次/对账、承兑票据五类交易+持有段重放、报销挂票/无票审核作废；REST+Meta+app/index/helpers 装配完成。补全 BIFF8 `.xls` 导入、票据 OCR、billAttrs snake_case 兼容；刷新 pr-2.20 Meta 快照。`bun run typecheck` 绿；finance PG 9 pass；`verify-finance-operations-rest` 全绿。
- 2026-07-28 主工作区集成：cherry-pick 去重三连 `a8ed2d9`（银行/票据/报销实现+装配）/ `9eedc22`（BIFF8+OCR+pr-2.20 快照）/ `52fa0d8`（billAttrs 类型收窄）；app/index/Meta/helpers 已在候选提交内完整挂载（`/finance/bank-*`、`/finance/expense-*`、`/finance/bills*`、registerFinanceResources/FileOwners）。验证：`bun run typecheck` 绿；`SYNIE_TEST_DATABASE_URL=… bun test` 213 pass；`verify-finance-operations-rest` against :18084 → `ok meta=24 permissionFirst=40 internal=6 wire=46 scope=40 states=84 audits=9 concurrency=2`。未改 server-go。无剩余。

## 范围

1. **银行账户/流水导入模板/流水导入批次**（列布局解析配置；解析→暂存→导入；已导入只读；流水收/支恰一项>0）
2. **银行对账记录**（流水↔凭证 m-n 金额勾稽；对账状态派生；调整=解除重建）
3. **承兑票据**（票号全局唯一跨公司；接收/转让/兑付/贴现/调拨五类交易；子票段[起,止]精确持有；持有承兑段级投影全链重放；后续动过不可作废）
4. **报销单**（挂票行一票一单全额核销/无票行税额恒 0；审核=借发票往来(带员工对手)/借费用、贷付款科目；作废解除发票引用）

## 行为参考

`server-go/internal/domain/finance/banking/`、`server-go/internal/domain/finance/documents/`（bill/expense）；CONTEXT 银行/票据/报销词条。

## 验收

- `verify-finance-operations-rest.ts` 全绿
- 票据重放不变量；对账状态派生；报销核销/作废联动测试

## 非目标

不做银行直连（维持文件导入）。
