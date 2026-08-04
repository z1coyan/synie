# 10 — 扫荡：trading（销/采全链）/ scm

**What to build:** 按 08 手册迁移 trading（订单/报价/发货/入库/对账/委外，双边 spec 驱动）与 scm（orderflow 投影）。要点：`requirePerm` 包装与 `orderSpec(side).prefix` 动态拼码改为 meta 动作 + guard；`lockOrder`/`lockDraft` 折叠进 `loadAuthorized(forUpdate)`；orderflow 的 via.anyOf（03 已声明）在此接执行点，删路由与服务的两份手写析取；对账 confirm/unconfirm 等工作流动作逐动作 guard。

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] trading 全部子域迁移，`trading/common.ts:requirePerm` 删除
- [ ] scm orderflow 走 via 执行点，手写析取删除
- [ ] 子行 items 资源 via(parent) 声明生效（前端覆盖删除在 14）
- [ ] 相关集成/E2E 测试全绿；封路豁免移除对应项

## Comments
