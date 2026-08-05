# 14 — 前端收口：ResourceDocument v3 与行级本地判定

**What to build:** wire 与前端消费换代：(1) ResourceDocument v3——`capabilities` 变 `{ action, scope }[]`，文档携带 authz 维度与绑定列 apiName；decoder/GridMeta 派生随之升级。(2) 行级本地判定——DataGrid 行动作用 decide fixtures 同源的客户端求值（me 的 userId/deptId/deptSubtreeIds × 行盖章列），scope 非 all 时按行禁用/隐藏；服务端仍是权威。(3) me 通道合一——`lib/permissions.ts` 与 `use-my-perms.ts` 合并为单 hook（精确码 + grantsAll，无 candidates），未解析期 fail-closed（修 other-stock.tsx fail-open）。(4) 删 13 处 `capabilities={[...]}` 硬覆盖（items 资源经 via 投影取真值）与 8 个文件的硬编码权限码。(5) forbidden/not_found 语义变化在 QueryState/RecordDrawer 提示文案上核对。

**Blocked by:** 03, 04, 05

**Status:** done

- [x] packages/shared ResourceDocument v3 + decoder + 特征化测试
- [x] grid-from-document / use-grid-actions 消费 {action, scope}；行级求值与 fixtures 对拍
- [x] me hook 合一、全站 fail-closed、web 两份 candidates 删除
- [x] capabilities 覆盖与硬编码码清零（grep 断言进测试）
- [x] 权限相关前端自检/E2E 全绿

## Comments
