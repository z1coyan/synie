# 08 — 审计脱敏自动化

**What to build:** 资源 meta 中声明的敏感字段（`AuditMeta.SensitiveFields`）从「声明了但没人消费」变为审计写入时自动生效：任何走 audit.Write 的变更，其敏感字段值在审计日志中自动落为脱敏占位符，不再需要各业务代码手写 `[FILTERED]` 替换。新增敏感字段只需在 meta 中声明即获得脱敏保护，不存在漏网路径。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] audit 写入路径自动消费 SensitiveFields 做脱敏，覆盖 create/update/destroy 三种变更形态
- [ ] 现有手写脱敏点（如设置的 OCR 密钥）删除，行为不变：审计日志中 secret 值仍不可读
- [ ] 脱敏有单元测试与至少一个 PG 集成测试锁定
- [ ] 历史已脱敏数据不受影响（不回溯改写）
