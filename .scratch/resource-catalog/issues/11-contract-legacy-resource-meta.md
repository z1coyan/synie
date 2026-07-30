# 11 — 收缩并删除旧 Meta 与前端 registries

**What to build:** 在所有消费者迁移并由持续报告证明零缺口后，删除 v1 Grid/Form sibling、legacy normalizer、宽 ResourceClient、全局 drawer registry 和 remote defaults，使 ResourceDocument v2 与 ResourceBinding 成为唯一活动架构。

**Blocked by:** 04 — 以最小 ResourceReadSpec 收口动态查询; 07 — 迁移单位、供应商与公司基础表单; 08 — 以语义化 CommandAdapter 收口资源命令; 10 — 按领域迁移剩余资源与呈现配置.

Status: resolved

- [x] 收缩前报告中的 unbound interactive resources、uncovered commands、basic/writable mismatch、legacy usages 和 write stubs 全部为零。
- [x] 稳定 Meta 响应只保留 v2 ResourceDocument envelope。
- [x] ResourceClient 不再拥有 Meta，也不再作为宽七件套接口存在。
- [x] 独立 ResourceClient registry、全局 drawer registry 和 resource-key remote defaults 被删除。
- [x] server legacy normalizer 和 v1 action transport 被删除。
- [x] 未知 resource/binding 没有 fallback。
- [x] 静态检查阻止重新引入页面级 basic 字段事实、只读写入 stub 或 Meta executable code。
- [x] Resource Catalog 中不存在通用 SQL query/save、领域事务、库存、总账或外部调用。
- [x] 基线审计重新运行并解释所有资源新增或删除。
- [x] shared、server、web 的类型检查、测试、数据库集成测试和生产构建全部通过。
- [x] 最终架构文档更新为已实施状态；无业务规则变化时不修改产品说明。

## Answer

- Meta wire：`registry.buildDocument` 仅返回 `ResourceDocument`；`legacy-normalize.ts` 删除，规范化迁入 `catalog-normalize.ts`。
- v1 action transport：`ActionMeta.mutation/http` 与 `destroyMutation` 从类型与定义剥离；Grid 删除经 `capabilities` + binding.writer，命令经 CommandAdapter。
- 前端：`useGridMeta` 只读 Catalog；`resourceBindingFor` 为唯一资源解析；transport 无 `meta()`；`registry.tsx` 删除，PE 静态 props 在 `extension-drawer-props.tsx` 且未知资源 fail-closed；remote defaults 归零。
- 契约测试：`web/app/lib/resources/catalog/contract-invariants.test.ts`；基线报告缺口仍为 0。
- ADR `docs/adr/2026-07-30-resource-catalog.md` 状态改为已实施。
- 产品规则无变更，未改 `docs/产品文档/`。

## Comments
