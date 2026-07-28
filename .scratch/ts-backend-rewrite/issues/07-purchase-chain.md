# 07 采购链：报价 → 订单 → 入库

Status: done
Blocked by: 03

## 范围

1. **采购报价单**（镜像销售报价：固定价/数量梯度；不校验客户物料约束）
2. **采购订单**（常规强制有效报价/零星手填上限；委外标记新建期可勾保存锁死——委外配置在工单 10；一单一币金额链；条目快照；已收数量投影；关闭/作废规则；来源履约需求行挂接与已下单数量累加复核——需求行本体在工单 11，本工单实现挂接面与投影写入口）
3. **采购入库单**（跨单条目池；借贷科目槽；审核单事务：库存分录+已收累加+GL（贷方强制未开票应付）/零金额跳总账；入库超收比例；已对账数量占位）

## 行为参考

`server-go/internal/domain/trading/`、`server-go/internal/domain/fulfillment/`；CONTEXT 采购词条。

## 验收

- `verify-quotation-rest.ts`、`verify-order-rest.ts`、`verify-fulfillment-rest.ts`（标准段）全绿
- 与工单 06 的金额链/快照/容差同一套 golden

## 非目标

委外配置/发料/入库（工单 10）；履约需求单本体（工单 11）。

## Comments
- 2026-07-28 集成：与工单06 并行实现去重——采用 06 side-aware trading（报价/订单/入库）作为采购链实现；跳过 07 并行 tree（`0b2e82e`/`5647a54`）避免双实现冲突；verify-quotation/order/fulfillment 锚点由统一 trading 覆盖。
- 2026-07-28 worktree 复核：采购侧已由 side-aware trading 完整覆盖；`verify-quotation`/`verify-order`/`verify-fulfillment` 全绿（采购镜像段含在内）；无独立缺口需补。
- 2026-07-28 二轮验收：typecheck 绿；order projection 采购入库/需求回写 PG 绿；三 verify 再跑全绿；无 remaining。
- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
