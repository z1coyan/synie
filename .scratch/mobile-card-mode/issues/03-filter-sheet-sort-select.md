# 03 — 筛选 Sheet + 排序 Select

**What to build:** 卡片模式的筛选与排序入口：工具栏变为「搜索框 + 筛选按钮 + 排序按钮」——筛选按钮带已生效条件数量徽标，点开底部 Sheet 按 filterable 列逐个配置条件，输入控件按列类型分派（枚举下拉/数值区间/日期范围/fk 选择/文本），控件实现从现有 filter-popover 中提取复用（提取即本票包含的 prefactor，桌面列头筛选行为不变）；排序按钮点开列+方向选择，与桌面表头三态排序落同一个 SortState——桌面点表头后手机排序控件显示同样状态，反之亦然；已生效筛选 Chips 行复用现有实现，两形态共用。排序控件与 SortState 的双向换算（含取消排序）收敛为纯函数并配自检。树形页面排序入口隐藏（同表格形态现状）。

**Blocked by:** 01 — 卡片流最小闭环

**Status:** ready-for-agent

- [x] 卡片工具栏为搜索+筛选+排序三件套；hideSearch 时搜索框不渲染，筛选/排序按钮不受影响
- [x] 筛选按钮徽标显示已生效条件数，为 0 不显示
- [x] 筛选 Sheet 内各 filterable 列按类型给出与桌面一致的输入控件，应用后列表按条件刷新、Chips 行同步出现
- [x] Sheet 内可清空全部条件；Chips 行逐个清除与「清除全部」在卡片模式照常可用
- [x] 排序控件选择列+方向后列表刷新；与桌面表头排序共享 SortState，两侧改动互见；可取消排序
- [x] 树形页面卡片模式下排序入口隐藏
- [x] filter-popover 控件提取后桌面列头筛选行为零回归
- [x] 排序双向换算纯函数自检覆盖：列+方向→SortState、SortState→控件值、取消排序；`bun run check` 通过

## Comments

- 实现:FilterControl 从 filter-popover 导出复用;CardFilterSheet/CardSortSheet 底部弹层(isHandleOnly 防手势吞控件);排序列用 ListBox(RAC 选择语义),恒空 selectedKeys + onSelectionChange,toggleSort 纯函数自检;与桌面同 filters/sort 状态。
- 调试记录:冒烟曾误判「点击不触发」,实为页面 defaultSort=订单日期降序,首次点按=取消排序——组件行为本就正确;已修正冒烟期望(初始降序→取消→升序→降序全周期)。
