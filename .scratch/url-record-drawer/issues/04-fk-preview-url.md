# 04 — FkPreview 速览接 URL

**What to build:** 全局 `FkPreviewProvider`（`web/app/components/synie-record-drawer/fk-preview-provider.tsx`）从纯状态驱动改为可 URL 寻址，使用与页面抽屉正交的 search 键（建议 `preview=<resource>:<id>` 或独立 `fk`/`fkId` 对，**不得**与页面 `record`/`mode` 冲突）。本分支明确不动 provider；本票实现并验证与页面抽屉同开/叠开语义。

**Blocked by:** 01

**Status:** ready-for-agent

**Parent:** [.scratch/url-record-drawer/spec.md](../spec.md)

## 背景

外键单元格点击开全局速览抽屉，当前 context state 驱动：刷新丢失、无法分享「我正在看的那条外键」。页面主抽屉 URL 化后，用户会自然期望速览也能链达。

## 改动面

- `web/app/components/synie-record-drawer/fk-preview-provider.tsx`（及必要时 `fk-preview.tsx`）
- 可能微调 hook 或新增 `useFkPreviewUrl`（`web/app/lib/`）
- 不得破坏 `_app` 已挂 Provider、页面零接线约定

## 验收标准

1. 打开速览写入独立 search 键；关闭清该键；保留 `record`/`mode` 与 Grid 参数
2. 深链仅带速览参数时可打开速览；与主抽屉参数并存时可定义明确叠层（建议主抽屉在下、速览在上，或互斥——ADR 定案）
3. 资源解析仍走 `resourceBindingFor`；缓存键不手写
4. 加载中/不存在/403 与现有 QueryState 一致
5. 全站页面无需改接线；`tsc` 与相关测试通过
