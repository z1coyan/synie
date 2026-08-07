# numbering

编号规则 CRUD + 取号服务 + 计数器校正（必留审计）；删规则级联删计数器。
- 字段目录：自 meta.Registry 派生（`catalog.ts`，资源声明 `numbering: true`，prefix 即 permissionPrefix），composition.ts 装配；DB 规则按 (prefix, path) 引用目录字段
- 端点：`/api/v1/system/numbering/{resources,rules,counters}`
- **create 链路取号唯一入口是 `assigned/assignedInTx`**：编号一律系统生成，传值（手填）一律 422，不做静默覆盖；`next/nextInTx` 仅留内部派生链路（如考勤建档、工单派生需求单）与规则自检
- 无启用规则即 conflict 硬阻断（文案指向 系统管理 → 编号规则）；停用/删除规则不拦（换规则=停旧启新）
- 行为参考：`server-go/internal/platform/numbering/`
