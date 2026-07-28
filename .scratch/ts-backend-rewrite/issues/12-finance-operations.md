# 12 财务运营：银行 / 票据 / 报销单

Status: done
Blocked by: 05, 09

## Comments

- 2026-07-28 子代理：实现银行账户/流水/导入模板批次/对账、承兑票据五类交易+持有段重放、报销挂票/无票审核作废；REST+Meta+app/index/helpers 装配完成。补全 BIFF8 `.xls` 导入、票据 OCR、billAttrs snake_case 兼容；刷新 pr-2.20 Meta 快照。`bun run typecheck` 绿；finance PG 9 pass；`verify-finance-operations-rest` 全绿。
- 2026-07-28 主工作区集成：cherry-pick 去重三连 `a8ed2d9`（银行/票据/报销实现+装配）/ `9eedc22`（BIFF8+OCR+pr-2.20 快照）/ `52fa0d8`（billAttrs 类型收窄）；app/index/Meta/helpers 已在候选提交内完整挂载（`/finance/bank-*`、`/finance/expense-*`、`/finance/bills*`、registerFinanceResources/FileOwners）。验证：`bun run typecheck` 绿；`SYNIE_TEST_DATABASE_URL=… bun test` 213 pass；`verify-finance-operations-rest` against :18084 → `ok meta=24 permissionFirst=40 internal=6 wire=46 scope=40 states=84 audits=9 concurrency=2`。未改 server-go。无剩余。
- 2026-07-28 独立全量验收：`:18090` `verify-finance-operations-rest` → `ok meta=24 permissionFirst=40 internal=6 wire=46 scope=40 states=84 audits=9 concurrency=2`；finance PG 3 项绿。无修复。
- 2026-07-28 复验：`:18091` `verify-finance-operations-rest` → `ok meta=24 permissionFirst=40 internal=6 wire=46 scope=40 states=84 audits=9 concurrency=2`；finance PG + bank-parser 绿。无代码变更。
- 2026-07-28 收口复验：`:18091` finance-operations 全绿；PG（对账派生/报销核销作废/票据持有重放）+ BIFF8 绿；status→done。

- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
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

- 2026-07-28 独立全量验收（主工作区 grok-4.5）：`server typecheck` 绿；`SYNIE_TEST_DATABASE_URL=…synie_test bun test` 223 pass；`web typecheck` + `bun test` 92 pass；shared decimal 5 pass。活 API :18095 对独立库：17 个 `verify-*.ts` 全绿 + setup 空库 e2e（synie_setup_e2e）+ `verify-web-hc-api` 关键路径绿。修 verify 空库/setup 自愈（inventory 公司单位、printing 默认存储、accounting/quotation 编号规则临时停用）。未执行工单 18；未 push/reset；未改 server-go。
