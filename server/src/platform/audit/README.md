# audit

字段级数据写操作留痕（旧值→新值），只增不改不删；敏感字段不落值。
- 行为参考：`server-go/internal/platform/audit/`
- 表：`sys_audit_log`；Meta 的 `audit.sensitiveFields` 驱动脱敏

## 已交付

- `write.ts`：`writeAudit` / Diff / Created / Destroyed / FilterSensitive
- `service.ts` + `routes.ts`：`GET/POST /system/audit-logs` 查询面（公司范围）
- Meta：`sysAuditLogs`
