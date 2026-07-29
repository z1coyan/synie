# 04 — 动作面 mobile 标记逃生口

**What to build:** 在 01 落地的默认策略（toolbar 动作隐藏、批量关闭、行内 ⋯ 全保留）之上加动作级逃生口：BulkAction/RowAction/内建动作支持 `mobile?: boolean` 声明——`mobile: true` 使某 toolbar 或批量动作在卡片模式显示（典型场景：批量审批上手机，此时勾选列与批量条随该动作出现）；`mobile: false` 使某行内动作在卡片模式隐藏（典型场景：行内打印不下手机）；未声明即走默认。行内 ⋯ 菜单在卡片上以触屏友好的形式完整呈现（点卡片右侧 ⋯ 弹出动作菜单）。显隐判定收敛为纯函数（输入动作清单+形态，输出可见动作集）并配自检。

**Blocked by:** 01 — 卡片流最小闭环

**Status:** ready-for-agent

- [x] 卡片上 ⋯ 菜单列出该行的行内动作，点击正常执行（含确认弹窗动线），actionVisible 按行过滤照常生效
- [x] `mobile: true` 的 toolbar/批量动作在卡片模式出现并可执行；批量动作出现时勾选位与批量条随之启用
- [x] `mobile: false` 的行内动作在卡片模式 ⋯ 菜单中不出现，桌面形态不受影响
- [x] 未声明 mobile 的动作严格走默认策略（toolbar 隐、行内留、批量关）
- [x] 权限门控（capabilities）在卡片模式照常生效，mobile 标记不放大权限面
- [x] 动作显隐判定纯函数自检覆盖：默认策略、mobile:true/false 双向翻转、批量动作带出勾选位；`bun run check` 通过

## Comments

- 实现:ActionBase 增 mobile 标记,ResolvedAction 透传;visibleOnCard 纯函数(row 默认保留/toolbar·bulk 默认隐藏)自检;卡片批量勾选位与批量条随 mobile:true 批量动作启用;picked 从累积行解析。
