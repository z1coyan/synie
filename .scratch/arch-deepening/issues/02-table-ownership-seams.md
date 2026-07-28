# 02 I · 跨模块表所有权收口

Status: resolved

## 问题

1. **hr_employees 双写**：`party/party-service.ts:305`（员工 CRUD）×
   `hr/service.ts:467`（考勤导入自动建档）——同一张表两个写入 module，
   编号/唯一约束/审计各写一遍；**审计已漂移**：party 侧声明
   `sensitiveFields:['id_number']`，hr 侧自动建档没有。
2. **读穿透**：`finance/invoice-service.ts:915-1122` 直查
   `sal_reconciliation`/`pur_reconciliation` 及其行表（还用 `sql.raw` 拼表名）——
   写路径走了正确 seam（`closeFromInvoice` Pick 注入），读路径绕过；
   `accounting/journal-service.ts:466-471` 直查 `acc_bank_reconciliation`。
3. **静态环用运行时 import 糊住**：`finance/banking-import.ts:694`
   `await import('./banking-accounts.ts')`；banking-accounts 把
   `validateTxnShape`/`loadTransaction`/`mapTransaction` 当共享出口被互啃成环。

## 方向

- employee 写路径收拢单点（party 或独立 employee module）；hr 经
  `Pick<EmployeeService,'autoCreateForAttendance'>` 窄 seam 调用，
  比照 invoice→reconciliation / banking-recon→journals 先例；
- reconciliation 暴露只读查询方法，读穿透回到 interface（读写同 seam）；
- banking 共享函数下沉 `banking-shared.ts`（或 common.ts），
  依赖方向变单向（ops→shared），删除动态 import。

## 验收

- hr_employees 只剩一个写入 module，审计敏感字段声明单点化；
- `grep -rn 'sal_reconciliation\|pur_reconciliation\|acc_bank_reconciliation' src/modules --include='*.ts'`
  只剩所有权模块自身；
- banking 内无 `await import(`；
- typecheck + 全套测试 226/226 绿。

## Comments

### 2026-07-28 落地

- `EmployeeService.autoCreateForAttendance(trx,actor,no)`：hr 经 `Pick` 注入，写路径只剩 party；`EMP_SENSITIVE_FIELDS` 单点。
- reconciliation：`existsForInvoice` / `loadForInvoiceAudit`；invoice 读写均走 seam。
- accounting cancel：注入 `isJournalLinkedToBankRecon`（banking-recon 游离函数，组合根接线）。
- `banking-shared.ts` 下沉 map/load/validateTxnShape/txnAmount/reconcileStatus；删 `await import(`。
- 验收：typecheck 绿；`bun test` 226/226。

### 2026-07-28 主仓集成

- commit：`1a385b1` refactor(server): 跨模块表所有权收口——employee/recon/banking seams
- 与过账骨架（invoice auditGlDocInTx）合并时保留 skeleton + recon Pick 扩 `existsForInvoice`/`loadForInvoiceAudit`；journal 必注 `GlEngine` + `JournalServiceDeps`
- 验证：typecheck + 246 测全绿
