# 02 — XLSX 填充：明细行 + 批量块 + 多 sheet 导出

**What to build:** 引擎支持明细模板行展开、批量打印块（分页符）、`render_sheets` 导出多 sheet（含 sheet 名清洗）。

**Blocked by:** 01 — XLSX 填充：头字段 + 占位符提取

**Status:** resolved

- [x] 多条目复制明细行、`${items._seq}`、下方行/merge 顺移
- [x] 0 条目删除明细模板行
- [x] 无明细行的模板合法
- [x] 多 doc 块间 rowBreak；merge/打印区域按块偏移
- [x] `render_sheets` 每 doc 一 sheet，sheet 名非法字符/截断/去重

## Answer

与 01 同模块交付；`render_pages` 批量与 `render_sheets` 导出均有单测覆盖。
