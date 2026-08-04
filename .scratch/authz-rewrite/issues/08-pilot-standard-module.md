# 08 — 试点：标准公司域模块（其他库存单链）

**What to build:** 以 inventory 的手工出入库/调拨/盘点三单据（`inv.stock_doc`/`inv.stock_transfer`/`inv.stock_count` + 分录/余额投影视图）为「平凡多数」模板做整模块迁移：routes 挂 guard、服务签名 Permit 化、list/load 走两个共享执行点、工作流动作（audit/void/approve/cancel/ship/receive）逐动作 guard。产出**扫荡迁移手册**（checklist 化的机械步骤 + 常见坑），供 09-12 按模块复制。此模块现状覆盖 4 写法公司闸中的 3 种，可验证语义统一后行为不回归。

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] 三单据 + 分录/余额资源 authz 声明与全量迁移；`requireAnyPermission` 等 inventory 本地包装删除
- [ ] 工作流动作全部经 guard；状态守卫保持 conflict 不动（划界验证）
- [ ] forbidden→not_found 语义变化点逐一列举进 PR 描述（前端 QueryState 提示随 14 收口）
- [ ] 现有 inventory postgres/integration 测试全绿，补 dept/self 范围用例（该模块暂无 owner/dept 声明即断言矩阵只出 all）
- [ ] 《扫荡迁移手册》落 `.scratch/authz-rewrite/sweep-guide.md`
- [ ] 封路豁免移除 inventory 三单据项

## Comments
