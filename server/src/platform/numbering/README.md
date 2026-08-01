# numbering

编号规则 CRUD + 取号服务 + 计数器校正（必留审计）；删规则级联删计数器。
- 字段目录：`numberables.json`（与 Go 同源）
- 端点：`/api/v1/system/numbering/{resources,rules,counters}`
- 行为参考：`server-go/internal/platform/numbering/`
