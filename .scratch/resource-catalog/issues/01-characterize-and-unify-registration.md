# 01 — 锁定现有 Meta 行为并统一资源注册

**What to build:** 在不改变任何页面、权限或 API 行为的前提下，让生产与测试使用同一份资源注册入口，并生成可持续的 Resource Catalog 迁移基线。后续每个切片都能据此判断自己是否引入资源缺失、字段漂移或能力退化。

**Blocked by:** None — can start immediately.

Status: resolved

- [x] 生产启动与测试环境只调用一个资源注册组合入口。
- [x] 基线报告列出服务端资源、字段、动作、Form 声明、前端 binding/client、drawer key 和 remote defaults。
- [x] 报告明确列出服务端、前端数据 Adapter 与 drawer 配置之间的 missing/extra，包括已知的设置资源拼写漂移。
- [x] 特征测试锁定 Actor capability、普通外键、多态外键、无目标读取权降级、Form 透传和自定义 permissionAction。
- [x] 币种当前 Meta 响应被保存为首个等价迁移基线。
- [x] 报告可扩展统计 declared commands、Adapter commands、basic writable fields、legacy usages 和 write stubs。
- [x] 全量类型检查与现有测试保持通过，且没有产品文档变化。

## Answer

- 统一入口：`server/src/platform/meta/register-all.ts` 的 `registerAllResources` / `createSealedResourceRegistry`；`index.ts` 与 `test/helpers.createPlatformRegistry` 共用。
- 特征测试：`server/src/platform/meta/catalog-characterization.test.ts`。
- 基线：`bun server/scripts/resource-catalog-baseline.ts` → `.scratch/resource-catalog/baseline/`（97 资源 / 1383 字段 / 305 动作 / 36 Form；缺 client=`sysRolePermissions`；drawer 漂移=`mfgSetting`）。
- 币种快照：`baseline/currency-meta.superadmin.json`。

## Comments
