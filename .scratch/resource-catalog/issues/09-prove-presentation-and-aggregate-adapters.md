# 09 — 证明 Presentation Extension 与 AggregateDraftAdapter

**What to build:** 用客户附件、发票 OCR 和销售发货三个真实场景证明复杂呈现与聚合保存不需要扩张 FormMeta。动态 React 行为与业务页面共置，销售发货通过领域专用完整草稿读取和原子写 API 形成 AggregateDraftAdapter。

**Blocked by:** 05 — 扩展前端 Catalog client 与 ResourceBinding.

Status: ready-for-agent

- [ ] Presentation Extension 拥有完整资源专用 form controller，而不是新的全局字段插槽 DSL。
- [ ] 客户附件面板迁入客户 Presentation Extension，create/edit/view 能力保持不变。
- [ ] 发票 OCR、动态控件和联动迁入发票 Presentation Extension，ResourceDocument 不含可执行代码。
- [ ] Extension 由对应 binding 的 typed adapters 构造，不再次按 resource key 查询全局 client。
- [ ] 销售发货新增领域专用完整草稿读取，一次返回表头和全部子记录。
- [ ] 完整草稿读取覆盖超过默认分页数量的子记录，不会静默截断。
- [ ] 销售发货 binding 拥有 AggregateDraftAdapter，不为表单暴露 RecordWriter。
- [ ] createDraft 与 replaceDraft 继续使用既有领域事务并返回权威 SavedDraft。
- [ ] 聚合保存失败不会留下部分子表。
- [ ] Catalog、Presentation、transport Adapter 和领域服务的所有权由契约测试分别证明。
- [ ] 没有引入 Meta 驱动聚合保存、动态组件路径或任意脚本。

## Comments
