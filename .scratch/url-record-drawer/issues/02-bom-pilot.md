# 02 — BOM 列表试点迁移

**What to build:** 将 `web/app/routes/_app/mfg/boms.tsx` + `boms/-bom-drawer.tsx` 从本地 `useState` 抽屉态改为 `useRecordDrawerUrl`。`BomDrawerProvider` 增加 `urlSync` 开关：列表页 `urlSync` 启用；工单页内嵌默认关闭（不改 work-orders 文件，默认值即兼容）。深链打开时补拉配料/路线/副产品明细；关闭清 URL；与 Grid 未知 search 共存。

**Blocked by:** 01

**Status:** resolved

**Parent:** [.scratch/url-record-drawer/spec.md](../spec.md)

- [x] `BomDrawerProvider` 接 `urlSync` + `useRecordDrawerUrl('mfgBoms')`
- [x] 列表页 `<BomDrawerProvider urlSync>`
- [x] 深链/前进后退补拉明细（与 openDrawer 去重）
- [x] onEdit / 关闭 / 保存后关抽屉写回 URL
- [x] 工单内嵌路径保持本地态（`urlSync` 默认 false）

## Answer

改动面：

- `web/app/routes/_app/mfg/boms.tsx` — 启用 `urlSync`
- `web/app/routes/_app/mfg/boms/-bom-drawer.tsx` — URL 与本地态双源；`rowId` 交给 `SynieRecordDrawer` 自查（三态 UI 复用组件内建 QueryState）

未改 `synie-record-drawer` 组件本体：加载中/不存在/403 已由抽屉 rowId 路径呈现。

验证：`cd web && bunx tsc --noEmit`；`bun test app/lib/use-record-drawer-url.test.ts`。
