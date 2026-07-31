# 05 — 库存分录：来源单号与来源单据均可点开速览

**What to build:** 库存分录流水表格中，`voucherNo`（来源单号）与既有 `voucherId` 多态链接进入**同一**只读速览（`openPreview(resource, id)`，由 `voucherType` 解析目标资源）。用户主路径点单号即可溯源。

**Blocked by:** 01 — 单据只读速览壳 + 注册表 + FkPreview 接入  
（02–04 登记齐后 8 类才有完整行表；本票可与 02–04 并行，但验收「有行」依赖对应登记完成。）

**Status:** ready-for-agent

**Parent:** [.scratch/fk-document-preview/spec.md](../spec.md)

## Context

- 页面：`web/app/routes/_app/scm/stock-entries.tsx`
- 列：`voucherId`（poly fk → `FkLink`）、`voucherNo`（字符串，现仅文本）
- meta 变体见 `server/src/modules/inventory/meta.ts` 库存分录 `voucherId` variants
- 规格决策：**B** — 两列都可点，不隐藏 `voucherId`

## Acceptance

- [x] `voucherNo` 在有有效 `voucherType`+`voucherId` 且目标资源可解析时渲染为可点链接
- [x] 点击与点 `voucherId` 打开同一 preview（同 resource + id）
- [x] 类型未知 / 变体被权限裁剪 / id 空：单号退纯文本，不出现点不开的假链接（对齐 `FkLink` 无 target 行为）
- [x] 仍 exclude 原始 `voucherType` 展示列（保持现状）
- [x] 不新增后端字段

## Non-goals

- 不改为仅保留单号列（方案 C）
- 不在分录行高亮来源行

## Comments

- 2026-07-31 code review 修复：`voucherNo` 改为复用权限裁剪后的 `voucherId` GridMeta variant；`document-preview-checks` 覆盖可见/被裁剪变体，`document-preview.api.e2e.ts` 验证双入口与无权限退纯文本。
