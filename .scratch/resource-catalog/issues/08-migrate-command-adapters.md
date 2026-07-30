# 08 — 以语义化 CommandAdapter 收口资源命令

**What to build:** 让领域命令从 ResourceDocument 的语义声明，经 ResourceBinding 的 typed CommandAdapter，到现有服务端命令 API 形成闭环。按钮权限不再按旧 action key 猜测，服务端鉴权仍独立生效。

**Blocked by:** 05 — 扩展前端 Catalog client 与 ResourceBinding.

Status: ready-for-agent

- [ ] setDefault 作为 row command，语义 key 与 requiredCapability 分离且正确执行。
- [ ] attendance recalc 作为 collection command，不需要伪造记录 ID。
- [ ] banking reconcile 使用 reconcile 语义 key，不再在 v2 中伪装为 export。
- [ ] row target 恰好一个 ID，bulk target 要求非空 IDs，非法 target 在类型或 decoder 边界失败。
- [ ] command 文档不包含 HTTP path、method、mutation 或空字符串占位。
- [ ] transport path、payload normalization 和 response mapping 只存在于对应 Adapter。
- [ ] 标准 CRUD 只贡献 capabilities 和 Reader/Writer 方法，不重复进入 commands。
- [ ] 业务模块的类型化 permission 常量同时供 ResourceDefinition 和服务端鉴权使用。
- [ ] migrated command 集合的文档、requiredCapability、Adapter 和 server authorization 覆盖率为 100%。
- [ ] 未授权直接 API 调用仍返回 forbidden。
- [ ] 旧 import/export 别名只保留在 v1 兼容投影，并标记由收缩工单删除。

## Comments
