# 01 — 卡片流最小闭环

**What to build:** 视口 <768px 时 SynieDataGrid 从表格切换为卡片列表：每条记录一张卡片，标题/副标题/摘要由列位置约定推导（第 1 列标题、第 2 列副标题、第 3–5 列摘要），`ColumnOverride.mobileRole`（title/subtitle/summary/hide）可逐列精调；卡片单元格复用现有 defaultCell 渲染口径（enum 胶囊、boolean 是/否、datetime 本地化、fk 标签）；点卡片触发页面 onView 动线打开详情抽屉（小屏已天然全屏，不改抽屉）；卡片模式下默认隐藏全部 toolbar 动作（新增/导入/导出/打印）、不渲染勾选列与批量条；≥768px 桌面形态零变化。字段映射收敛为纯函数并配自检，注册进 run-checks 汇总。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 视口 <1024px（统一移动断点 lg，实现期由 768px 修正）时任意资源列表渲染为卡片流，≥1024px 仍为 DataGrid，窗口拖宽拖窄形态即时切换且搜索/筛选/排序状态不丢（390×844 与 1440×900 双向冒烟验证）
- [x] 卡片默认呈现：第 1 列标题、第 2 列副标题、第 3–5 列摘要（列数不足则少），enum/布尔/日期/fk 与表格口径一致（复用 defaultCell）
- [x] `mobileRole` override 生效：显式 title/subtitle 优先于位置约定、hide 列不上卡片、显式指定角色不影响其余列的默认推导（card-mode-checks 覆盖）
- [x] 点卡片打开详情抽屉（页面配了 onView 时）；未配 onView 时卡片不响应点击
- [x] 卡片模式下 toolbar 动作、勾选列、批量条均不出现；桌面形态全部保持现状（冒烟断言 createBtn/exportBtn=0、桌面 grid 恢复）
- [x] 卡片字段映射纯函数自检覆盖：位置约定、mobileRole 优先级、hide、列数不足、显式 title 挤占摘要位；自检注册进 run-checks 且 `bun run check` 通过
- [x] 加载中/加载失败/无权限/空结果四态在卡片模式下有对应呈现（前三态在分支前复用现有渲染，空结果卡片模式自带 EmptyState）

## Comments

- 断点由规格的 768px 修正为 lg(1024px)：实现时发现 `web/AGENTS.md` 约定「桌面/移动断点统一为 lg」，用户裁决跟仓库约定；ADR/规格/CONTEXT.md 已同步回改。
- pick（选择器）与 tree（树形）资源本期暂退回桌面表格（`cardMode = isMobile && !pickMode && !tree`），避免中间态功能残缺；分别由 ticket 06/05 带入。
- 行内 ⋯ 菜单在卡片上随本票落地（默认策略=全保留）；`mobile: true/false` 逃生口属 ticket 04。
- 验证：typecheck / `bun run check` / `bun test` 107 全绿；vite build 通过；Playwright 移动视口冒烟（登录→销售订单列表，卡片 7 张、无 DataGrid、toolbar 动作隐藏、点卡片开抽屉、桌面视口表格回归）。
