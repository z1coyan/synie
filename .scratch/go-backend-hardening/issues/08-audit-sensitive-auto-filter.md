# 08 — 审计脱敏自动化

**What to build:** 资源 meta 中声明的敏感字段（`AuditMeta.SensitiveFields`）从「声明了但没人消费」变为审计写入时自动生效：任何走 audit.Write 的变更，其敏感字段值在审计日志中自动落为脱敏占位符，不再需要各业务代码手写 `[FILTERED]` 替换。新增敏感字段只需在 meta 中声明即获得脱敏保护，不存在漏网路径。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] audit 写入路径自动消费 SensitiveFields 做脱敏，覆盖 create/update/destroy 三种变更形态
- [x] 现有手写脱敏点（如设置的 OCR 密钥）删除，行为不变：审计日志中 secret 值仍不可读
- [x] 脱敏有单元测试与至少一个 PG 集成测试锁定
- [x] 历史已脱敏数据不受影响（不回溯改写）

## Result

**脱敏机制设计**：采用「调用方声明」方案而非 Registry 反查。`audit.Entry` 新增可选字段 `SensitiveFields []string`，`audit.Write` 在 JSON 编码前调用新的导出函数 `audit.FilterSensitive(changes, sensitiveFields)`：凡命中声明的字段，其 Change 内所有值键（from/to）替换为占位符常量 `audit.FilteredPlaceholder`（即 `[FILTERED]`，与历史数据一致），键结构不变；未声明或为空时原样返回、零拷贝，且过滤产生副本不修改调用方 map。`Write` 签名不变，向后兼容。选该方案的理由：audit 是底层 platform 包，若反向依赖 meta.Registry 需解决 `Entry.Resource` 为表名（bas_company）而 Registry 以资源名（basCompanies）键控的映射问题，会引入表名→资源名的脆弱反查与包耦合；调用方本就持有自己的 meta，声明式透传更直接。未改动 platform/meta。

**改动文件**：
- `server/internal/platform/audit/audit.go`：`FilteredPlaceholder` 常量、`Entry.SensitiveFields` 字段、`FilterSensitive` 函数、`Write` 写入前脱敏。
- `server/internal/platform/audit/audit_test.go`：新增 3 个单测（create/update/destroy 三种 changes 形态均脱敏、非敏感字段不受影响、未声明时行为不变、不修改输入）。
- `server/internal/platform/settings/service.go`：删除 OCR secret 手写 `[FILTERED]` 替换；`writeSettingAudit` 通过新 helper `sensitiveAuditFields` 按表名从本包 `ResourceMetas()` 取 `Audit.SensitiveFields` 填入 Entry——新增敏感字段只需在 settings meta 声明即生效。
- `server/internal/platform/settings/service_postgres_test.go`：在既有 PG 测试追加「审计日志全文不含 secret 明文」断言（环境门控部分未动）。
- `server/internal/domain/hr/employee/service.go`（调用点适配）：删除 update/create/destroy 三处 id_number 手写 `[FILTERED]`，三处 `audit.Entry` 改填 `ResourceMeta().Audit.SensitiveFields`；未改该包 meta.go。

**全库复查**：iam（hashed_password）与 files（secret_access_key）的 meta 虽声明敏感，但对应审计 snapshot 本就不含这些字段，无泄漏也无需改动；Go 侧已无其他手写 FILTERED。backend/（Elixir）为旧实现，不在本次范围。

**验证**：`gofmt` 干净；`go build`/`go vet` 通过；`go test` 三个包全绿，其中两个 PG 集成测试（设置 OCR secret 脱敏+无明文泄漏、员工身份证 create/update/destroy 三行审计全脱敏）确认真实执行（非 skip）并通过。历史数据未触碰。
