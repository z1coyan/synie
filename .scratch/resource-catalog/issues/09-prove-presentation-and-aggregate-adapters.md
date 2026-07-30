# 09 — 证明 Presentation Extension 与 AggregateDraftAdapter

**What to build:** 用客户附件、发票 OCR 和销售发货三个真实场景证明复杂呈现与聚合保存不需要扩张 FormMeta。动态 React 行为与业务页面共置，销售发货通过领域专用完整草稿读取和原子写 API 形成 AggregateDraftAdapter。

**Blocked by:** 05 — 扩展前端 Catalog client 与 ResourceBinding.

Status: resolved

- [x] Presentation Extension 拥有完整资源专用 form controller，而不是新的全局字段插槽 DSL。
- [x] 客户附件面板迁入客户 Presentation Extension，create/edit/view 能力保持不变。
- [x] 发票 OCR、动态控件和联动迁入发票 Presentation Extension，ResourceDocument 不含可执行代码。
- [x] Extension 由对应 binding 的 typed adapters 构造，不再次按 resource key 查询全局 client。
- [x] 销售发货新增领域专用完整草稿读取，一次返回表头和全部子记录。
- [x] 完整草稿读取覆盖超过默认分页数量的子记录，不会静默截断。
- [x] 销售发货 binding 拥有 AggregateDraftAdapter，不为表单暴露 RecordWriter。
- [x] createDraft 与 replaceDraft 继续使用既有领域事务并返回权威 SavedDraft。
- [x] 聚合保存失败不会留下部分子表。
- [x] Catalog、Presentation、transport Adapter 和领域服务的所有权由契约测试分别证明。
- [x] 没有引入 Meta 驱动聚合保存、动态组件路径或任意脚本。

## Answer

- 服务端：`getSalesDraft` + `GET /sales/deliveries/:id/draft`（无分页截断）；`accVatInvoices` / `salDeliveries` form.kind=extension
- 前端：`presentation/{customer,invoice}` PE 由 binding 构造；`salesDeliveryDraftAdapter`；salDeliveries binding 无 create/update writer
- 页面：customers / invoices / sales-deliveries drawer 经 PE 或 AggregateDraftAdapter
- 测试：`presentation.test.ts`、catalog binding draft、catalog-seal extension 投影

## Comments
