# 04 库存单据与余额

Status: done
Blocked by: 03

## 范围

1. **手工出入库单**（direction 创建锁死；折算默认单位 6 位；审核派生分录/作废过负库存校验）
2. **手工调拨单**（调出/调入/在途三仓；发货→收货两段分录；实收≤已发；已发货不可作废）
3. **库存盘点单**（账面快照/实盘折算/差异分录/审核兜底校验快照后无变动）
4. **库存余额表 + 库存分录流水**（只读聚合，截至日回溯；隐藏零行）
5. 仓库启停/负库存标记在单据保存与审核路径的执行（拦新不拦旧）

## 行为参考

`server-go/internal/domain/inventory/`（单据服务）；CONTEXT「手工出入库单」「手工调拨单」「库存盘点单」「库存余额」词条。

## 验收

- `verify-inventory-rest.ts` 全绿
- 状态机/容差/快照行为测试；审核过账走 withTx + engines（单事务）

## 非目标

不做批次/序列号/库位（v1 不做）。

## Comments
- 2026-07-28 集成：主仓 cherry-pick 工单04（含 9d03807 边界 PG）；Meta/路由并入统一 app 装配；`bun test` 全绿（含 inventory 5）；typecheck 通过。
- 2026-07-28 独立验收：补齐 OpenAPI `POST /inventory/warehouses/outsourced/query` 与 `seed-defaults`（对齐 Go ListOutsourced/SeedDefaults）；PG 测 + verify-inventory 全绿。
- 2026-07-28 worktree 复核：实现完整（engines/inventory 复用）；`verify-inventory-rest` 全绿；PG 测试自愈基线（启用币种/单位/admin）；verify 临时停用既有物料编号规则再自建前缀规则。
- 2026-07-28 二轮验收：typecheck 绿；inventory/engines PG+unit 全绿；`verify-inventory-rest` 再跑全绿；无 remaining。
- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
