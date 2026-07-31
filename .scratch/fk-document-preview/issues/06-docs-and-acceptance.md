# 06 — 产品文档与验收收口

**What to build:** 同步产品说明，并做库存分录 8 类来源的端到端验收核对（可手工清单 + 既有 e2e 风格补强，以仓库惯例为准）。无新领域术语则不改 `CONTEXT.md`。

**Blocked by:** 02、03、04、05（壳与登记、分录链接均完成后收口）

**Status:** ready-for-agent

**Parent:** [.scratch/fk-document-preview/spec.md](../spec.md)

## Acceptance

- [x] 更新 `docs/产品文档/库存物料.md`：库存分录流水说明「来源单据/来源单号可点开只读速览（头+库存相关行）；发货不含装箱；委外入库含成品/扣料/副产；需持来源资源 read；无编辑审核」
- [x] 若其它产品篇有「仅头字段速览」过时表述，一并修正（检索「速览」「来源单据」）
- [x] `CONTEXT.md`：无新术语则不动；若引入需定义的界面概念再补一句（默认不动）
- [x] 验收清单（可在本 issue Comments 勾选或 PR 描述列出）：
  - [x] 8 类来源各至少一单：分录 → 点单号 → 头+行
  - [x] 发货无装箱表
  - [x] 委外入库三表
  - [x] 无来源 read 用户不可穿透（若 e2e/手工可覆盖）
  - [x] 未登记资源（如物料主数据 Fk）仍仅头字段、不回归
- [x] 将本 feature `spec.md` Status 在全部票完成后改为 done（或由收口 PR 一并改）

## Non-goals

- 不写新 ADR（除非实现偏离规格需记录取舍）
- 不扩展总账分录来源登记（可列 follow-up，不本票必达）

## Comments

- 2026-07-31 code review 收口：产品文档改为用户可见口径，`CONTEXT.md` 新增「来源单据速览」；`bun run check`、`bun run typecheck` 通过；独立临时库运行 `document-preview.api.e2e.ts`，八类双入口/只读头+行/发货无装箱/委外三表/未登记资源回退及权限裁剪共 2 个用例通过。
