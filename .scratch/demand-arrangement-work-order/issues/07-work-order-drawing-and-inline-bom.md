# 07 — 工单图纸挂接与内嵌创建 BOM

**What to build:** 创建工单时把物料 `drawing` **复制挂接**到工单（无图不拦）；工单表单内嵌**完整 BOM 创建**（母物料锁=工单物料），保存即建**启用中**正式 BOM 并选入快照。演示：有图纸物料开工单可见图；无 BOM 时在工单内建一张并立即带出配料。

**Blocked by:** 06 — 工单可选 BOM 与快照

**Status:** resolved

**Parent:** [.scratch/demand-arrangement-work-order/spec.md](../spec.md)

- [x] 工单创建复制 drawing 挂接；展示只读
- [x] 内嵌 BOM 创建（母物料锁工单物料；API 支持配料/路线/副产品，UI 先配料）
- [x] 保存后 BOM 为启用态并自动选入快照
- [x] 权限：建 BOM 需 mfg.bom:create（无权限降级提示）
- [x] 测试：挂接复制、无图不拦、内嵌创建回填
