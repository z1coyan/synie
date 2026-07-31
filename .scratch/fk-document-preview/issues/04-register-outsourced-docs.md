# 04 — 登记委外单据：发料 + 入库（含三表）

**What to build:** 登记委外发料单与委外入库单的只读速览。委外入库必须分 **三个 section**：成品入库行、材料扣减行、副产物行（均为库存相关）；委外发料一张发料条目表。

**Blocked by:** 01 — 单据只读速览壳 + 注册表 + FkPreview 接入

**Status:** ready-for-agent

**Parent:** [.scratch/fk-document-preview/spec.md](../spec.md)

## Resources

| 资源 key | 子表 |
|----------|------|
| `purOutsourcedIssues` | `purchaseOutsourcedIssueItemClient` |
| `purOutsourcedReceipts` | `purchaseOutsourcedReceiptItemClient` + `purchaseOutsourcedReceiptItemMaterialClient` + `purchaseOutsourcedReceiptItemByproductClient` |

参考：`web/app/lib/resources/fulfillment.ts` 客户端导出；委外发料/入库业务抽屉与 `extension-drawer-props`；产品文档 [委外发料](../../docs/产品文档/委外发料.md)、[委外入库](../../docs/产品文档/委外入库.md)。

## Acceptance

- [ ] 委外发料：标题 `issueNo`+状态；头含公司/对手/日期/仓预填/备注；行表材料+数量+调出仓+外协仓等
- [ ] 委外入库：标题 `receiptNo`+状态；头含公司/对手/日期/默认仓/默认外协仓/科目槽/备注等
- [ ] 委外入库三个子表 section 标题清晰可辨；均只读
- [ ] 物料列富单元格
- [ ] 权限 fail-closed（`purchase.outsourced_issue` / `purchase.outsourced_receipt`）
- [ ] 无工作流按钮

## Non-goals

- 不改委外审核写分录逻辑
- 不在速览中编辑扣料数量
