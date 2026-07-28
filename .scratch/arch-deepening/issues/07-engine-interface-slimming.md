# 07 G · 引擎 interface 瘦身与对称

Status: done

## 问题（小项集合，适合穿插在其他工单间隙做）

- `gl.validateEntries` 零生产调用（仅测试用）——占着 interface 但 leverage 为零；
- `GlEntry.debit/credit` 入参留 `| number`（types.ts:26-27）——金额纪律在
  interface 层面给浮点留了门；
- `StockLine.quantity` 符号约定靠注释（types.ts:22-24），调用方手写负号
  （如 `stock-doc-service.ts:353` 的 `quantity.neg()`）——方向语义泄漏；
- `toDateOnly` 在 gl/engine.ts:397 与 inventory/engine.ts:458 逐字重复；
- 引擎注入三种模式并存：module index 工厂 / 文件级单例（fulfillment、
  outsourced、reconciliation）/ 默认参数 DI（finance 各 service）。

## 方向

- validateEntries：补草稿预检调用方（如 journal 保存时预检），或从
  interface 撤下仅留测试出口；
- 金额入参收窄 `Decimal | string`；
- 符号约定进引擎显式 `direction` 参数（调用方传语义，引擎算负号）；
- toDateOnly 收敛 `~/db` 单点；
- 注入统一为 module index 工厂一种模式。

## 验收

- 引擎 interface 收窄，调用方须知减少；符号/日期口径各一事实源；
- typecheck + 全套测试绿。
