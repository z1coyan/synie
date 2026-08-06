# 03 — 车间权限收口（需求单限定入口授权）

**What to build:** 车间角色获得履约需求单的 `read/update/confirm/delete`（数据范围限「本部门=下发到本车间」的 assigned 既有形态），**不授 `create`**——效果：车间能查看、修改、审核、删除下发到本车间的需求单草稿（含自己派生的），派生链路完全自助；但手工建单按钮因无 create capability 自动隐藏、直接调建单端点 403、销售勾选纳入口径对其关闭。计划角色既有行为不回归。

**Blocked by:** 01 — 派生核心链路

**Status:** ready-for-human

- [x] 车间角色授权组合（read/update/confirm/delete、本部门数据范围）下：派生草稿可改可审可删，审核后进入下游车间/采购勾选池可见
- [x] 车间角色手工建单端点 403；销售勾选相关端点 403；前端建单入口自动隐藏
- [x] 车间看不到未下发到本车间的需求单（含他人派生给其他车间的单）
- [x] 计划角色建单/勾选/审核/下发行为全部不回归
- [x] 全栈 HTTP 双角色集成测试（buildTestApp 模式）覆盖以上正反面

**实施说明：** 零生产代码改动——assigned 部门数据范围（meta 已声明）与前端 capability 门控（`can('create')` 驱动建单按钮显隐）均为既有机制，角色授权为运行时授予（本票测试内按车间角色授权组合 `read/update/confirm/delete` + 工单全套 + `generate_material_demand`、scope=dept 直接写授权表验证）。交付物为 `server/test/workshop-demand-permissions.integration.test.ts`（双角色三用户：计划员 × 车间A × 车间B，6 例全绿）。
