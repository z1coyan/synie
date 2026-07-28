# 03 事实引擎：GL + 库存

Status: ready-for-human
Blocked by: 02

## 范围

`server/src/engines/` 落地两个深模块（唯一写分录入口；禁止单据直写分录表）：

1. **gl**：`post/cancel/reverse/validateEntries`——借贷配平（容差 0）、科目存在且本公司启用非汇总、往来角色科目必须带对手（红字行豁免）、币种一致性；作废=标记不删行；红冲=原组取负对冲+标记已被红冲。
2. **inventory**：`post/cancel`——（仓×物料）advisory lock 串行化、数量带符号恒默认单位（6 位）、叶子仓校验、负库存校验（仓级 `allow_negative` 豁免；作废同样过校验）。

两引擎接口接 `DbHandle`（trx 由调用方传入），禁止自起事务、禁止 import modules/*。

## 行为参考

`server-go/internal/engines/gl/`；库存引擎在 `server-go/internal/domain/inventory/` 内（Stock 服务）。不变量语义见 CONTEXT「总账分录」「库存分录」「红冲」「允许负数库存」词条。

## 验收

- PG 集成不变量测试：配平拒绝/科目约束/对手缺失拒绝/作废幂等/红冲归零/负库存拒绝（含作废致负）/锁并发
- 引擎 API 被 04/05 工单直接消费，不再变更签名

## 非目标

不过金额到库存分录（估值未定案，维持只记数量）。

## Comments

- 2026-07-28 集成代理：cherry-pick 分片 2f9bb3b（GL）+ fd1f13a（inventory）→ 0a1f16f/4371591，去重并行分片（7683cec/f0fb06b/fc10ffd 等同实现未再合入）。`createGlEngine`：post/cancel/reverse/validateEntries（配平容差 0、科目本公司启用非汇总、往来对手红字豁免、作废幂等、红冲取负对冲）；`createInventoryEngine`：post/cancel/balance（仓×物料 advisory xact lock、叶子仓、6 位数量、负库存含作废致负、allow_negative 豁免）。均接 DbHandle、不自起事务、禁 import modules/*、金额走 @synie/shared decimal。无 HTTP/Meta（深模块，供 04/05 消费）。`bun run typecheck` 绿；`SYNIE_TEST_DATABASE_URL=… bun test src/engines` 28 pass；全量 `bun test` 99 pass。未改 server-go。
- 2026-07-28 独立验收（阶段 A）：对照 server-go `engines/gl` 与 `domain/inventory/stock`（形状/科目/往来/红冲/幂等/锁 key `inv_stock:仓:料`/负库存文案）；签名稳定 `gl={post,cancel,reverse,validateEntries}` `inv={post,cancel,balance}`；禁 modules import、仅 ApiError 用 class、金额/数量 decimal。`bun run typecheck` 绿；engines 28 + 全量 99 pass。无缺陷需修。
- 2026-07-28 隔离 worktree 复验（grok-4.5）：签名与约束复核通过——`createGlEngine`/`createInventoryEngine` 接 `DbHandle`、不自起事务、无 `modules/*` import、金额/数量走 `@synie/shared` decimal、错误 `ApiError`。`SYNIE_TEST_DATABASE_URL=…5441/synie_test bun test src/engines` 28 pass（配平/科目/往来对手/红冲归零/作废幂等/负库存含作废致负/allow_negative/仓×物料锁并发/6 位数量）。无代码变更；未改 server-go；未 push。
- 2026-07-28 补 remaining 复验：`bun test src/engines` 28 pass 仍绿；签名稳定无变更。验收闭环。
- 2026-07-28 主工作区集成（grok-4.5 缺口）：cherry-pick 去重 `cf7b2d2`（公司默认过账科目 PG 集成）/`b0ba293`（04–07 编号 23505→conflict + inventory 自愈 + verify-inventory 停车编号）/`3f84ab7`（09–14 编号 conflict 测 + OCR 默认存储 + HR 编号腾空 + market fixture）/`bc43cef`（todo 忽略复位）/`4358af8`（printing render 冒烟）/`b8538aa`（setup 空库 e2e afterAll 超时）；合并重复 numberingWriteError；app/index/Meta/helpers 已完整装配，未改 server-go。
