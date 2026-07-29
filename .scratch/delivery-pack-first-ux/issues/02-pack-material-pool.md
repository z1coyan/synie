# 02 — 装箱行物料候选来源反转：可发货订单条目池

**What to build:** 解除「装箱行候选＝本单发货条目去重物料」的耦合，使「先装箱后补条目」路径可走通。装箱行物料下拉候选改为**可发货订单条目池去重物料**——池口径与现有 `orderItemGridFilter`（`-delivery-drawer.tsx`）完全一致：同公司、同对手、订单已审核、`remainingBaseQty > 0`（查询 `salOrderItems`，extraFields 取 `materialId` 等，按 materialId 去重、保留物料快照字段供选中后 patch）。装箱表格 `canCreate` 条件从 `headerReady && materialOptions.length > 0` 放宽为 `headerReady`；候选为空（池空）时下拉禁用并给「无可发货订单条目」空态提示，替换现有「先填写发货条目，再录入装箱行」toolbar 文案。选中物料后的快照 patch 与单位重置（`unitId`/`unitName` 置空由 MaterialUnitSelect 带出默认）行为照旧。`resetItems`（头变清空条目＋装箱行）联动保留。生成按钮不在本票（见票 03）。

**Blocked by:** 01 — 发货抽屉 Tab 拆分（避免在旧布局上改完又搬家）

**Status:** resolved

- [x] 装箱行物料候选＝订单条目池（同 `orderItemGridFilter` 口径）去重物料，不再依赖本单发货条目
- [x] `canCreate` 放宽为 `headerReady`；池空时下拉禁用＋空态文案「无可发货订单条目」
- [x] 旧 toolbar 提示「先填写发货条目,再录入装箱行」移除/替换
- [x] 选中物料后快照五字段 patch、单位重置行为照旧
- [x] resetItems 联动保留；头未选齐时仍不可加行
- [x] 手工验证(Playwright:零条目新建单直接录装箱行,候选=池物料 F(P)-900)：零条目新建发货单可直接录装箱行；换对手后装箱行清空、候选刷新

## Comments

- 2026-07-29 实现时发现并修复一个前置回归 bug（疑随 Go→TS cutover 引入）：`sales/order-items/query` 对 `remainingBaseQty` 过滤/排序 500——计算字段只在 `mapRow` 层求值，SQL 子查询未暴露 `remaining_base_qty` 列。修复：`server/src/modules/trading/order/service.ts` `listItems` 子查询补 `(base_qty - projection) AS remaining_base_qty`；该 bug 同时打挂既有「选择可发货订单条目」弹窗（发货条目录入主路径）。回归用例补在 `web/e2e/order.api.e2e.ts`（池过滤口径 + 排序断言）。另注意池查询 `limit` 服务端上限 200（超出 400）。
