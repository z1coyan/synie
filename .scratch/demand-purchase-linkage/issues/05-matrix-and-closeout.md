# 05 — 收口：authz 夹具 + 演示链 + 文档走查

**What to build:** authz 矩阵世界补齐本特性新字段的夹具（采购条目来源需求行/需求日的写输入，需求行已下单/已收/派生徽标的只读可见性），CI 权限覆盖不红；可选为示例数据补一条「外购需求行→勾选带入→入库完成」与一条委外演示链（不阻塞主交付）；走查已落盘文档（CONTEXT.md、履约需求/采购订单/采购入库/委外入库四篇、ADR 2026-07-25）与实现无偏差，只修偏差不重写。

**Blocked by:** 04 — 入库回写完成闭环

**Status:** resolved

**Parent:** [.scratch/demand-purchase-linkage/spec.md](../spec.md)

- [x] authz_matrix world：新字段写/读两侧登记，CI 不红
- [x] 可选：演示数据补外购链 + 委外链各一条
- [x] 文档偏差走查（术语表、四篇产品文档、ADR）
