# 01 B 收尾：其余过账路径迁入骨架/seam

Status: ready-for-agent

## 背景

第一轮已建 `modules/trading/posting.ts` 履约过账骨架（audit/void 两入口），
销售发货/采购入库/委外入库三方迁入。以下过账路径仍是手写六段式
（锁头→校验→引擎→投影→状态翻转→审计），逐个评估迁入：

- `modules/finance/invoice-service.ts:424-548`（审核/作废/红冲）
- `modules/finance/expense-service.ts`（报销单审核/作废）
- `modules/finance/bill-service.ts`（承兑交易审核/作废 + replayBill）
- `modules/inventory/stock-doc-service.ts:329-395`、`stock-count-service.ts`、`stock-transfer-service.ts`（三段状态机）
- `modules/manufacturing/output-service.ts`

## 方向

- 形状吻合的迁入骨架（collect 钩子承载领域差异）；
- 形状不合的（journal 无库存——已是 seam 形态；stock-transfer 发货/收货两段）记录原因，不硬套；
- 骨架如需演化（如可选库存段、无投影段），先改骨架再迁调用方，保持规则单点。

## 验收

- typecheck + 相关 PG 集成测试全绿（226/226 基线）；
- 每个单据迁移单独 commit；
- 不迁入的在 `modules/trading/posting.ts` 头注释或本文件 Comments 记录原因。
