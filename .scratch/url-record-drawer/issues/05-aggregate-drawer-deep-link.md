# 05 — 聚合草稿抽屉深链（单据类）

**What to build:** 销售订单/发货/采购入库等经 `AggregateDraftAdapter` 的整单抽屉，在接 `useRecordDrawerUrl` 时补齐「深链只给 id、需 loadDraft 整单」路径：不能只靠列表行快照；create 的 `record=new` 与 draft 本地态边界写清。可与 03 分批，但单据页验收单独列。

**Blocked by:** 01, 03

**Status:** ready-for-agent

**Parent:** [.scratch/url-record-drawer/spec.md](../spec.md)

## 背景

简单主数据抽屉用 `reader.get(id)` 即可。聚合单据抽屉还要拉子表/附件/阶梯，页面现有逻辑常依赖 `openDrawer(mode, row)` 时顺带 loadDraft。深链没有 row 对象，必须在 URL 打开时走 draft adapter。

## 改动面

- 各聚合单据路由与共置 drawer 模块
- 确保 `resourceBindingFor(resource).draft?.loadDraft` 与缓存失效约定不被绕过

## 验收标准

1. `?record=<id>&mode=view|edit` 深链打开完整草稿（表头+子表），非空壳
2. 加载中/失败/403 有明确 UI
3. 保存/审核后关抽屉清 URL；列表与相关资源缓存正确失效
4. 与 `url-grid-state` 筛选参数共存
