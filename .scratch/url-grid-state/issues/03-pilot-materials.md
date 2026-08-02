# 03 — 试点：物料列表页

Status: resolved

## 目标

在真实业务页 `scm/materials` 验证 URL 网格状态：零 `validateSearch`、默认开启、可分享/刷新/后退。

## 验收

- 物料页无 `validateSearch` 仍能读写 `q/page/ps/sort/f`
- 无参进入与改前一致（全量第 1 页）
- 搜索 + 列筛选 + 翻页后刷新，状态保持；Chips 可改可清
- 与本页 `SynieRecordDrawer` 本地抽屉状态无冲突（本轮抽屉未 URL 化）

## Answer

- 试点文件：`web/app/routes/_app/scm/materials.tsx`（仅注释标明试点，机制默认开启无需 prop）
- 机制在组件内，路由零契约变更即可生效
- 类型检查与相关单测通过（见提交前验证）
