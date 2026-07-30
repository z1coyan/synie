# 05 — 扩展前端 Catalog client 与 ResourceBinding

**What to build:** 让前端能够完整读取 v2 ResourceDocument，并通过一个类型安全 ResourceBinding 取得资源实际拥有的数据能力。现有页面先经兼容外观继续工作，为后续逐资源迁移建立可落地的扩展面。

**Blocked by:** 03 — 以 sealed Catalog 并行投影 v1 与 v2.

Status: resolved

- [x] Catalog client 解码并缓存完整 ResourceDocument，不再只保留 Grid。
- [x] Catalog cache 与 actor/session 隔离；切换账号后不会复用旧 capabilities 或 reference visibility。
- [x] ResourceReader 只拥有 query/get，不再拥有 Meta 生命周期。
- [x] RecordWriter 只暴露资源实际支持的 create、update、delete 子集。
- [x] AggregateDraftAdapter 保留 Draft 与 SavedDraft 的不同类型。
- [x] CommandAdapter 保留每个 command 的 target、input 和 output 类型。
- [x] known resource key 能从 keyed binding map 恢复自己的 Row、Query、Create、Update、Draft 和 Command 类型。
- [x] unknown resource binding 显式失败，不返回空 drawer 或 label fallback。
- [x] 现有 ResourceClient 映射由 binding 兼容生成，不再是第二份可编辑 registry。
- [x] 同一标签页先后登录两个 Actor 的测试证明缓存不会跨用户泄漏。
- [x] 新能力接口没有新增宽泛 cast 或只读资源写入 stub。
- [x] 现有 Grid、Drawer 和外键预览在 expand 阶段行为不变。

## Answer

- `web/app/lib/resources/catalog/`：types、cache、client、binding-registry、grid-from-document
- `resourceBindingFor` / `resourceClientFor`：`registry.ts` 从 clients 生成 bindings；只读资源省略写方法
- 会话：`login.tsx` / `_app.tsx` 调用 `setCatalogActor` / `clearCatalogCache`
- 测试：`catalog/catalog.test.ts`

## Comments
