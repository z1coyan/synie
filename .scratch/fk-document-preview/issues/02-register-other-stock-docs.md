# 02 — 登记其他库存单：出入库 / 调拨 / 盘点

**What to build:** 在单据只读速览注册表中登记三类其他库存来源，使从任意 Fk（含库存分录）点开时展示头+行。列与头字段对齐各业务抽屉只读子集；有物料的行用物料富单元格。

**Blocked by:** 01 — 单据只读速览壳 + 注册表 + FkPreview 接入

**Status:** ready-for-agent

**Parent:** [.scratch/fk-document-preview/spec.md](../spec.md)

## Resources

| 资源 key | 子表 client（现有） | parent 字段（以代码为准） |
|----------|---------------------|---------------------------|
| `invStockDocs` | `stockDocItemClient` | 单据 id 过滤字段（如 `docId`） |
| `invStockTransfers` | `stockTransferItemClient` | 同上模式 |
| `invStockCounts` | `stockCountItemClient` | 同上模式 |

参考：`web/app/routes/_app/scm/-stock-doc.tsx`、`other-stock/transfers.tsx`、`other-stock/counts.tsx` 的 `openDrawer` 行加载与 `drawerConfig(...)` 头字段；`extension-drawer-props.tsx` 中对应 label/exclude/fields。

## Acceptance

- [ ] `invStockDocs`：标题单号（`docNo`）+ 状态；头含公司/方向/日期/仓/摘要/备注等业务抽屉字段；行表物料+单位+数量+折算/备注等（与业务行表只读列对齐或合理子集）
- [ ] `invStockTransfers`：头含调出/调入/在途仓等；行表可见
- [ ] `invStockCounts`：头含仓/日期等；行表含物料、账面、实盘等盘点关键列
- [ ] 三资源均只读；无工作流按钮
- [ ] 无对应 item `read` / 父单 `read` 时 fail-closed
- [ ] 不登记装箱或无关子资源

## Non-goals

- 不改审核/作废业务逻辑
- 不改其他库存单编辑抽屉（除非为复用列定义做无行为变化的抽取，可选）
