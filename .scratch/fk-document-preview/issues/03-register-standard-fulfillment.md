# 03 — 登记标准履约单：销售发货 / 采购入库 / 生产入库

**What to build:** 登记三类标准履约库存来源的只读速览。销售发货**只**出货条目，**禁止**装箱箱/装箱行。头字段对齐业务抽屉（含对手、日期、仓预填、借贷科目槽等只读展示）。

**Blocked by:** 01 — 单据只读速览壳 + 注册表 + FkPreview 接入

**Status:** ready-for-agent

**Parent:** [.scratch/fk-document-preview/spec.md](../spec.md)

## Resources

| 资源 key | 子表 | 说明 |
|----------|------|------|
| `salDeliveries` | `salesDeliveryItemClient`（发货条目） | **不含** `pack_boxes` / `pack_lines` |
| `purReceipts` | `purchaseReceiptItemClient` | 入库条目 |
| `mfgOutputs` | `outputItemClient` | 生产入库行 |

参考：`sales-deliveries/-delivery-drawer.tsx`、`purchase-receipts` 抽屉、`mfg/outputs/-output-drawer.tsx`；`extension-drawer-props.tsx` 中 `salDeliveries` / `purReceipts` / `mfgOutputs`；item 过滤字段以各页 `docIdField` 为准。

## Acceptance

- [ ] 三资源：标题单号字段正确（`deliveryNo` / `receiptNo` / `outputNo`）+ 状态
- [ ] 头字段对齐业务抽屉只读子集（公司、对手、日期、过账日、仓、科目槽、备注等按单存在）
- [ ] 行表含物料富单元格 + 数量/单位/行仓等业务关键列
- [ ] **发货速览 DOM/配置中不出现装箱相关子表**
- [ ] 行上价税等若业务抽屉 view 展示则保留；不新增写入口
- [ ] 权限 fail-closed（`sales.delivery` / `purchase.receipt` / `mfg.output` read）

## Non-goals

- 不实现「从装箱生成条目」等发货编辑能力
- 不登记委外单据（见 04）
