# 06 J · 最重不变量提纯出 PG

Status: ready-for-agent

## 问题

全仓最危险的两坨逻辑是纯变换却困在 IO 里，只能靠 PG 集成测试覆盖：

- `finance/bill-service.ts:279-365` `replayBill`——持有段投影重放
  （五类交易的不重叠/金额守恒/调拨换户不变量），调用点仅 :993/:1018；
- `hr/service.ts:1268-1356` 工资-借款联动（发放自动写归还、删除回滚）。

仓内已有「核心提纯」惯例：hr/rules.ts、finance/bank-parser、
market 的 resolveQuote、gl 的 validateShapeForTest——这两处是落后分子。

## 方向

- 提纯 `replaySegments(txs): Segment[]` 纯函数 + 薄 IO adapter
  （读交易/整删整建），段重叠/拆分/换户进免 PG 单测；
- 工资-借款联动提纯为 `applyPayment(payroll, loans) → effects` 纯核，
  落库归 adapter。

## 验收

- 两个纯核各有免 PG 单测（golden 用例覆盖重叠拒绝、金额守恒、
  调拨换户、联动回滚）；
- 行为零变化，现有 PG 集成测试保持绿；
- module interface 不变，implementation 更深。
