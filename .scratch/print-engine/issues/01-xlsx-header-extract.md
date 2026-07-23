# 01 — XLSX 填充：头字段 + 占位符提取

**What to build:** 纯 Elixir 引擎可对 xlsx 模板做头字段 `${...}` 替换，并提取模板中全部占位符（头 vs 明细）。非法包返回明确错误。无 DB/UI。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] `extract_placeholders/1` 返回 fields/items（去重排序，items 去前缀）
- [x] `render_pages/2` 单 doc：混排、空值、sharedStrings 中占位符可替换
- [x] 非 xlsx / 空 docs 返回稳定 error
- [x] 未改动的 styles 等 part 原样保留

## Answer

已实现 `SynieCore.Printing.Renderer` + `PrintingFixture` 单测；见 `backend/apps/synie_core/lib/synie_core/printing/renderer.ex`。
