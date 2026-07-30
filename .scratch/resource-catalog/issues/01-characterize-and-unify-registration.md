# 01 — 锁定现有 Meta 行为并统一资源注册

**What to build:** 在不改变任何页面、权限或 API 行为的前提下，让生产与测试使用同一份资源注册入口，并生成可持续的 Resource Catalog 迁移基线。后续每个切片都能据此判断自己是否引入资源缺失、字段漂移或能力退化。

**Blocked by:** None — can start immediately.

Status: ready-for-agent

- [ ] 生产启动与测试环境只调用一个资源注册组合入口。
- [ ] 基线报告列出服务端资源、字段、动作、Form 声明、前端 binding/client、drawer key 和 remote defaults。
- [ ] 报告明确列出服务端、前端数据 Adapter 与 drawer 配置之间的 missing/extra，包括已知的设置资源拼写漂移。
- [ ] 特征测试锁定 Actor capability、普通外键、多态外键、无目标读取权降级、Form 透传和自定义 permissionAction。
- [ ] 币种当前 Meta 响应被保存为首个等价迁移基线。
- [ ] 报告可扩展统计 declared commands、Adapter commands、basic writable fields、legacy usages 和 write stubs。
- [ ] 全量类型检查与现有测试保持通过，且没有产品文档变化。

## Comments
