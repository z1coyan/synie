# audit

字段级数据写操作留痕（旧值→新值），只增不改不删；敏感字段不落值。
- 行为参考：`server-go/internal/platform/audit/`
- 表：`sys_audit_log`；Meta 的 `audit.sensitiveFields` 驱动脱敏
- 实现工单：`.scratch/ts-backend-rewrite/issues/01-platform-completion.md`

## 已交付

- `write.ts`：`writeAudit` / `auditDiff` / `auditCreated` / `auditDestroyed` / `filterSensitive`
  （供 files 等域 create/update/delete 调用；列表/查询面待补）
