# 01 — BOM 草稿/启用/停用生命周期

**What to build:** BOM 主数据可走 **草稿 → 启用 ⇄ 停用**：新建默认可为草稿；启用与停用可互转；**仅草稿可物理删除**；**仅启用中**出现在新工单/新委外的 BOM 选择器。启用后仍可改配料与路线。演示：停用一张 BOM 后新单选不中；草稿可删、启用中删除被拒。

**Blocked by:** None — can start immediately

**Status:** resolved

**Parent:** [.scratch/demand-arrangement-work-order/spec.md](../spec.md)

- [ ] `mfg_bom` 具备 status（draft|active|inactive）及启用/停用动作
- [ ] 仅草稿可 delete；启用/停用后删除失败
- [ ] 工单与委外 BOM 选择器只返回启用中且母物料匹配的 BOM
- [ ] 前端 BOM 列表/表单展示状态并支持启停
- [ ] 集成/主数据测试覆盖选单过滤与删除闸门
