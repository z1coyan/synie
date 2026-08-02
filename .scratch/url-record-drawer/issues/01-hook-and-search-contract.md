# 01 — useRecordDrawerUrl 与 search 契约

**What to build:** 在 `web/app/lib/use-record-drawer-url.ts` 落地可复用 hook 与纯函数契约：`parseRecordDrawerSearch` / `recordDrawerOpenPatch` / `RECORD_DRAWER_CLOSE_PATCH`；约定 `record=<id|new>` + `mode=view|edit`；读写 search 一律函数式并保留未知参数；初始行经 `resourceBindingFor(resource).cache.rowKey` + `reader.get`；可选 `enabled=false` 关闭 URL 同步。配套纯函数单测。

**Blocked by:** None — can start immediately

**Status:** resolved

**Parent:** [.scratch/url-record-drawer/spec.md](../spec.md)

- [x] 纯函数：parse / openPatch / closePatch 与往返
- [x] hook：useSearch(strict:false) + 函数式 navigate + row 自查
- [x] `enabled` 开关（共享 Provider 非列表宿主）
- [x] 单测 `use-record-drawer-url.test.ts`

## Answer

实现文件：

- `web/app/lib/use-record-drawer-url.ts` — hook + 纯函数 + 常量
- `web/app/lib/use-record-drawer-url.test.ts` — parse/patch/往返/保留未知参数

要点：

- `record=new` → create；`record=<id>` 默认 view，仅 `mode=edit` 进编辑；非法 mode 回落 view
- 关闭与 create 打开时把 `mode` 置 `undefined`，依赖 router-core encode 跳过 void 0 清参
- open 压栈；setMode/close `replace: true`
- 查询键 `binding.cache.rowKey(id)`，与 `SynieRecordDrawer` rowId 路径同键

验证：`cd web && bun test app/lib/use-record-drawer-url.test.ts` 全绿；`bunx tsc --noEmit` 零错误。
