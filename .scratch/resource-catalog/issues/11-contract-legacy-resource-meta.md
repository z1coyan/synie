# 11 — 收缩并删除旧 Meta 与前端 registries

**What to build:** 在所有消费者迁移并由持续报告证明零缺口后，删除 v1 Grid/Form sibling、legacy normalizer、宽 ResourceClient、全局 drawer registry 和 remote defaults，使 ResourceDocument v2 与 ResourceBinding 成为唯一活动架构。

**Blocked by:** 04 — 以最小 ResourceReadSpec 收口动态查询; 07 — 迁移单位、供应商与公司基础表单; 08 — 以语义化 CommandAdapter 收口资源命令; 10 — 按领域迁移剩余资源与呈现配置.

Status: ready-for-agent

- [ ] 收缩前报告中的 unbound interactive resources、uncovered commands、basic/writable mismatch、legacy usages 和 write stubs 全部为零。
- [ ] 稳定 Meta 响应只保留 v2 ResourceDocument envelope。
- [ ] ResourceClient 不再拥有 Meta，也不再作为宽七件套接口存在。
- [ ] 独立 ResourceClient registry、全局 drawer registry 和 resource-key remote defaults 被删除。
- [ ] server legacy normalizer 和 v1 action transport 被删除。
- [ ] 未知 resource/binding 没有 fallback。
- [ ] 静态检查阻止重新引入页面级 basic 字段事实、只读写入 stub 或 Meta executable code。
- [ ] Resource Catalog 中不存在通用 SQL query/save、领域事务、库存、总账或外部调用。
- [ ] 基线审计重新运行并解释所有资源新增或删除。
- [ ] shared、server、web 的类型检查、测试、数据库集成测试和生产构建全部通过。
- [ ] 最终架构文档更新为已实施状态；无业务规则变化时不修改产品说明。

## Comments
