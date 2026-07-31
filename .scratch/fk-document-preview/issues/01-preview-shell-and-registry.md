# 01 — 单据只读速览壳 + 注册表 + FkPreview 接入

**What to build:** 落地全局「单据只读速览」基础设施，让 Fk 外链在**已登记资源**上能展示「标题（单号+状态）+ 只读头 + 子表区」，未登记资源**行为与今日一致**（仅基础资源表单头字段）。本票**不**登记任何业务来源的具体子表配置（02–04 负责），但须提供可注册的配置类型、统一壳组件、以及 `FkPreviewProvider` 分支。演示：任意已有 basic 资源（如物料）速览仍仅头字段；可在开发期用临时 mock 登记验壳，合并前 mock 不得残留。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

**Parent:** [.scratch/fk-document-preview/spec.md](../spec.md)

## Context（事实）

- 今日实现：`web/app/components/synie-record-drawer/fk-preview-provider.tsx` 仅用 `basicFormDrawerProps` + `SynieRecordDrawer mode="view"`。
- 业务子表在各页呈现扩展 / 条目 client（如 `stockDocItemClient`），**不**在 ResourceDocument basic form 里。
- 规格决策：注册表方案 B；纯只读；status/单号进标题；无登记则退化。

## Acceptance

- [ ] 定义 `DocumentPreviewConfig`（或等价）：至少含 `label`、单号字段、状态字段、头字段 props（exclude/fields/contentClassName）、子表数组（title、query 所需 resource/client、parent 过滤字段、列/overrides）
- [ ] 注册表 API：`register` / `getDocumentPreview(resource)`；未知资源返回 `null`
- [ ] 统一只读壳：打开时 `get(id)` 头；按配置 query 子表（parent id 过滤，合理 limit 如 200，与业务抽屉 load 对齐）；标题展示单号+状态（枚举中文标签若全站有惯例则跟随）；表单区只读；子表只读不可编辑；无编辑/审核/作废 footer
- [ ] 有物料列时复用全站物料富单元格（`materialCellRender` 或等价）
- [ ] `FkPreviewProvider`：有 preview 配置走壳；否则走现有 basic form 路径
- [ ] 加载中/404/403 有明确反馈（沿用全站 toast 或抽屉内错误态，不静默空壳）
- [ ] 权限：继续走各资源既有 reader/client（无新「穿透」API）
- [ ] 无后端 schema 变更；无新权限码
- [ ] 若加单测/契约测：注册表命中/未命中分支至少覆盖一处（与仓库现有 web 检查风格一致即可）

## Non-goals

- 不实现 8 类来源的正式登记（见 02–04）
- 不改库存分录表格列（见 05）
- 不改产品文档（见 06）
- 不复用完整业务抽屉工作流
