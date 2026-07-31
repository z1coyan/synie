# ResourceBinding 拥有缓存身份

Status: ready-for-agent

## 目标

加深 ResourceBinding module，使 reader、查询键与失效语义通过同一 interface 暴露；调用者不再了解具体 client 身份或自行拼接查询键。

## 验收

- `SynieDataGrid` 与 `SynieRecordDrawer` 从 ResourceBinding 解析 transport。
- query 与 invalidate 使用同一 cache identity implementation。
- production Hono adapter 和测试用 in-memory adapter 穿过同一 seam。
- 行为测试覆盖查询键一致性及失效范围。

## Comments

- 2026-07-31：分派给 subagent `binding_cache`，核心文件范围与业务路由迁移分开，避免并发冲突。
- 2026-07-31：核心 seam 已完成：binding 拥有 gridRows/rowById cache identity、key factory 与精确失效；真实 Hono adapter 和 in-memory adapter 通过同一 interface 测试。第一阶段后仍有 40 个路由文件手拼失效、84 个文件显式传 client，继续分派非冲突调用点迁移。
- 2026-07-31：非冲突页面迁移完成，路由 DataGrid 显式 client 清零；全前端 197 tests、check、typecheck 与 diff check 通过。刻意保留 10 个复杂 SCM Drawer 的 38 处旧 key 和 10 个 RecordDrawer client，等待 Aggregate Draft 改造后收尾。
- 2026-07-31：interface 测试迁移完成后，继续分派非 aggregate 复杂 Drawer 的 cache/client 扫尾；当前正在改造的采购入库、双侧报价和双侧订单留给 Aggregate Draft agent。
- 2026-07-31：销售/采购对账、委外发料/入库、销售发货复杂 Drawer 已迁移；targeted 27/27 与 check 通过。当前只剩 Aggregate Draft agent 占用的 5 个 Drawer，共 16 个手拼标准 key 与 5 个父 Drawer client。
- 2026-07-31 独立审查：发现列表审核仍全局失效 96 个 binding，而保存并审核只失效当前资源，关联投影可能陈旧。决定把 post-command 受影响资源共置到 Command interface，并让两条审核路径复用同一精确失效 implementation。
- 2026-07-31：CommandSpec 已共置 `affectedResources`；统一 helper 在执行命令前完整解析当前资源、审计日志与跨资源 effects，配置错误时不执行 handler，成功后只失效对应 binding。Generic Drawer 与 15 份 AuditDoc 配置已接入，全 registry 失效删除；AuditDoc、Document Preview 与订单履约历史的派生查询键均纳入对应 binding grid scope。
- 2026-07-31：通用 Grid 的 row/bulk/rowOrBulk/collection 与全部生产直接命令调用均接入同一 effects helper；生产 Grid/Drawer/EditableTable/远程选择器显式 client 注入清零，只保留 custom/in-memory Adapter seam。随机顺序回归暴露的全局 registry 污染已通过规范 production binding + 测试局部 resolver 根治。
