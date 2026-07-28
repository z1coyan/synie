# 01 B 收尾：其余过账路径迁入骨架/seam

Status: resolved

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

## Comments

### 2026-07-28 落地

**骨架演化**（`6d01154`）：在履约骨架旁新增

- `auditInventoryDocInTx` / `voidInventoryDocInTx`：仅库存；空行跳过 post；可选投影；
  可配 `voidStatus` / `actionName` / `setPostingDate`
- `auditGlDocInTx` / `voidGlDocInTx`：仅 GL；多行 entries；并发 draft 闸；
  `afterAudit`/`afterVoid`/`flipToEnded`/`resolveGlEnd(cancel|reverse|skip)`

**已迁入**（各单独 commit）：

| 单据 | Commit | 骨架 |
|------|--------|------|
| 手工出入库 stock-doc | `7f29c18` | inventory |
| 盘点 stock-count | `36c016e` | inventory（approve/cancel + cancelled） |
| 生产入库 mfg.output | `88d046e` | inventory + WO 投影钩子 |
| 报销单 expense | `eb764f5` | gl |
| 承兑交易 bill | `2bf095a` | gl + skipGl(REALLOCATE) + replayBill after* |
| 增值税发票 invoice | `24ed98d` | gl + reverse + recon after* |

**不迁入（已记 posting.ts 头注释）**：

- **journal**：已是 `createAndAuditJournal` / `auditJournalInTx` seam
- **stock-transfer**：draft→shipped→received 两段，字段 shipped_at/received_at，非单段 audit/void
- **outsourced issue**（清单外）：形状接近 inventory 骨架，投影键 orderItemMaterialId，可后续再迁

验证：`bun run typecheck` + `SYNIE_TEST_DATABASE_URL=…synie_test bun test` → 226/226。

### 2026-07-28 主仓集成

合入 main（冲突按既定形状解决：骨架 + 引擎 `direction` / 金额 `Decimal|string`）。

- 骨架扩展：`381f3e2`
- stock-doc：`3578c51`（collect 用 direction）
- stock-count：`e042062`
- mfg.output：`84f66fc`
- expense：`02187d8`
- bill：`0ad078e`
- invoice：`f5f8866`
- 收口记录：`e50af03`

验证：typecheck 绿；全量 `bun test` 246/246。
