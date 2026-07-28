# 05 手工会计凭证与往来报表

Status: ready-for-human
Blocked by: 03

## 范围

1. **手工会计凭证**（头+行；草稿→已审核→已取消；审核同事务锁头行复检配平后经 GL 追加；取消同事务标记分录作废；已取消终态）
2. **红冲**（原分录组取负对冲+标记）
3. **应收应付报表**（截至日未作废分录按对手×往来角色轧差；净应收/净应付口径；未指定对手兜底行）

## 行为参考

`server-go/internal/domain/accounting/`；CONTEXT「手工会计凭证」「红冲」「应收应付报表」「往来角色」词条。

## 验收

- `verify-accounting-rest.ts` 全绿
- 凭证状态机/红冲/报表轧差测试

## 非目标

不做凭证模板/常用摘要（Go 现状无则不添）。

## Comments

### 2026-07-28 agent

TS 业务域已落地于 `server/src/modules/accounting/`：

- 凭证头/行 CRUD + 审核（`engines/gl.post`）+ 取消（`engines/gl.cancel`）；银行对账引用阻断取消
- 总账分录只读 list/get；应收应付报表对手×往来角色轧差
- 红冲能力复用工单 03 GL 引擎 `reverse`（凭证本身走取消作废，与 Go 一致）
- Meta：`accGlJournals` / `accGlJournalLines` / `accGlEntries`
- 专属 PG 集成：状态机/分录/报表/cascade 审计；`bun run typecheck` 绿

待集成代理：对照 `verify-accounting-rest.ts` 全链路打 API（含 GridMeta 快照与公司范围）。

### 2026-07-28 agent（验收）

- `verify-accounting-rest.ts` 对活 TS API **全绿**（meta×6、权限/公司范围、凭证/行 CRUD、审核分录、AR/AP、取消）
- Meta 多态 FK wire 去掉 null resource/relation/labelField，与 Go Grid 快照一致；补 `.scratch/migration/snapshots/pr-2.12/*.grid.json`
- 集成测补红冲 reverse 取负 + is_reversed + 重复 conflict + 报表归零
- typecheck + accounting/gl PG 集成全绿

