# 10 — 按领域迁移剩余资源与呈现配置

**What to build:** 基于已经证明的 Basic Form、CommandAdapter、Presentation Extension 和 AggregateDraftAdapter，将剩余资源按领域批次迁出 legacy ResourceMeta、ResourceClient registry、drawer registry 和 remote defaults。每个资源都得到明确分类和可验证归宿。

**Blocked by:** 07 — 迁移单位、供应商与公司基础表单; 08 — 以语义化 CommandAdapter 收口资源命令; 09 — 证明 Presentation Extension 与 AggregateDraftAdapter.

Status: ready-for-agent

- [ ] 基线中的每个服务端资源都分类为 basic、extension、none、reference-only 或 dead/typo。
- [ ] 每个领域批次独立合入并保持旧兼容投影可用，避免大爆炸切换。
- [ ] Basic 资源的静态字段事实只存在于 typed ResourceDefinition。
- [ ] 动态表单行为只存在于业务共置 Presentation Extension。
- [ ] lookup 的 label、search、subtitle 和 default sort 归目标资源；React item rendering 归本地 ReferencePresentation。
- [ ] 员工、物料、分类和单位选择器的搜索、摘要与显示行为没有退化。
- [ ] 只读、create-only、update-only 和不可删除资源不再实现不支持的写方法。
- [ ] 所有 actor-visible commands 都有对应 typed CommandAdapter。
- [ ] 所有交互资源都有唯一 ResourceBinding；catalog-only/none 资源有显式分类。
- [ ] stale settings 拼写和其他无调用配置经证明后删除，不保留 silent fallback。
- [ ] legacy resource normalizer 调用数归零，但兼容代码本身留给最终收缩工单删除。
- [ ] 全量迁移报告中没有未解释的 resource、drawer、command、reference 或 write-stub gap。
- [ ] 等价迁移不改变产品规则；任何可见变化拆成独立业务工单并同步产品文档。

## Comments
