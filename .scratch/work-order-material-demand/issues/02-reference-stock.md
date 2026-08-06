# 02 — 参考库存与净需求默认

**What to build:** 「生成物料需求」弹窗每行带出**参考库存**——复用库存引擎按「工单公司 + 配料物料、跨全部仓库合计」取生成瞬间的现货快照（只读、不锁不扣不预留），折算到行单位展示；每行默认数量改为 毛需求 − 参考库存（可手改，允许改大），参考库存足够的行默认去向=「不需要」。打开弹窗时取数，前端不自行聚合库存。

**Blocked by:** 01 — 派生核心链路

**Status:** ready-for-human

- [x] 弹窗取数端点（或动作 dry-run）返回每配料行的毛需求与参考库存（库存引擎按公司全仓聚合，6 位精度，折算行单位）
- [x] 行默认数量 = 毛 − 参考库存（下限 0），人可改、允许大于毛需求
- [x] 参考库存 ≥ 毛需求的行默认去向为「不需要」（仍可改）
- [x] 参考库存只是快照：生成后库存变动不影响已生成草稿，系统不写任何库存分录/预留
- [x] 服务层 PG 测试：有库存/无库存/部分覆盖三种情形的默认数量与默认去向；单位换算正确性

**实施记录：** 取数走独立查询端点 `GET /work-orders/:id/material-demand-preview`（guard 同动作码 `mfg.work_order:generate_material_demand`），服务端 `getMaterialDemandPreview` 返回每行 grossQty/stockQty/defaultQty/covered；`createWorkOrderService` 注入库存引擎（`createManufacturingServices` 装配），balance 按 `{ companyId, materialId }` 聚合后跨仓合计、按行单位（默认/转换单位 factor）折算。弹窗改从预览端点取数，新增「参考库存」列，默认数量=defaultQty。PG 测试见 `work-order-material-demand.integration.test.ts` 票 02 三用例（含快照脱钩与不写分录断言）。
