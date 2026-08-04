# 07 — 试点：需求单下发车间（指派部门形态）

**What to build:** dept=assigned 形态的第一消费者，验收 spec §2 冲压车间场景：`mfg_demand` 加 `assigned_dept_id`（可空 FK → sys_department，限本公司部门）；meta 声明 `dept: { column: 'assigned_dept_id', mode: 'assigned' }`；草稿态表单可填可改，已确认后改派走新工作流动作 `dispatch`（下发/改派，权限码 `mfg.demand:dispatch`，仅已确认未关闭可用，写审计）。工单资源（`mfg.work_order`）声明归属部门形态（`owner_dept_id` 盖章列）作对照。E2E：冲压车间生产经理（`mfg.demand:read scope=dept` + 工单全套 scope=dept）只见下发本车间的需求单、可从行安排工单、看不到其他车间/未下发单；计划角色 scope=all 全量可见。

**Blocked by:** 04, 05

**Status:** ready-for-agent

- [ ] 迁移：mfg_demand.assigned_dept_id；mfg_work_order.owner_dept_id（盖章列）
- [ ] meta 声明两形态 + dispatch 动作（目录、路由 guard、服务 Permit 化）
- [ ] 需求单/工单/生产入库服务全量迁 Permit + loadAuthorized + listFromSource v2
- [ ] 表单：下发车间字段（RemoteSelect 限本公司部门）；列表列可筛
- [ ] 场景 E2E（种子建部门与角色授权，矩阵 UI 未到位前走 API 授权）
- [ ] 产品文档：生产管理篇补下发车间；封路豁免移除 manufacturing 需求单/工单项

## Comments
