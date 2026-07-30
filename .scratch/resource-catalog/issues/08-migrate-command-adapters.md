# 08 — 以语义化 CommandAdapter 收口资源命令

**What to build:** 让领域命令从 ResourceDocument 的语义声明，经 ResourceBinding 的 typed CommandAdapter，到现有服务端命令 API 形成闭环。按钮权限不再按旧 action key 猜测，服务端鉴权仍独立生效。

**Blocked by:** 05 — 扩展前端 Catalog client 与 ResourceBinding.

Status: resolved

- [x] setDefault 作为 row command，语义 key 与 requiredCapability 分离且正确执行。
- [x] attendance recalc 作为 collection command，不需要伪造记录 ID。
- [x] banking reconcile 使用 reconcile 语义 key，不再在 v2 中伪装为 export。
- [x] row target 恰好一个 ID，bulk target 要求非空 IDs，非法 target 在类型或 decoder 边界失败。
- [x] command 文档不包含 HTTP path、method、mutation 或空字符串占位。
- [x] transport path、payload normalization 和 response mapping 只存在于对应 Adapter。
- [x] 标准 CRUD 只贡献 capabilities 和 Reader/Writer 方法，不重复进入 commands。
- [x] 业务模块的类型化 permission 常量同时供 ResourceDefinition 和服务端鉴权使用。
- [x] migrated command 集合的文档、requiredCapability、Adapter 和 server authorization 覆盖率为 100%。
- [x] 未授权直接 API 调用仍返回 forbidden。
- [x] 旧 import/export 别名只保留在 v1 兼容投影，并标记由收缩工单删除。

## Answer

- 服务端：`commandTarget` 覆盖 + `SYS_STORAGE` / `HR_ATTENDANCE_DAY` / `ACC_BANK_TRANSACTION` 权限常量；v2 setDefault=row、recalc=collection、reconcile=row；v1 import/export 伪装保留至工单 11
- 前端：`catalog/commands.ts` target 解码 fail-closed；`storageCommandAdapter` / `attendanceDayCommandAdapter` / `bankTransactionCommandAdapter` 挂入 ResourceBinding
- 页面：storages / attendance days / bank-transactions+reconcile drawer 经 binding.commands 执行语义命令
- 测试：`command-auth.test.ts`、`commands.test.ts`、catalog-seal 语义 target 断言

## Comments
