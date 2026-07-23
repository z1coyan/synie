# 打印引擎 — 总览 Map

**Status:** ready-for-agent（规格已拆分，可按依赖开工）  
**定案文档：** [docs/adr/2026-07-23-print-template.md](../../docs/adr/2026-07-23-print-template.md) · [CONTEXT.md](../../CONTEXT.md) 打印相关术语 · [产品文档/系统管理.md](../../docs/产品文档/系统管理.md)

本目录是导航用 map，**可执行 spec 在四个子 feature**（本地 tracker：每 feature 一份 `spec.md`）。

## 切片与依赖

```text
print-xlsx-engine          print-pdf-deploy
        \                     /
         \                   /
          v                 v
        print-template-master
                  |
                  v
        print-document-pipeline
```

| # | Feature | Spec | 依赖 | 交付物（可验证） |
|---|---------|------|------|------------------|
| 1 | [print-xlsx-engine](../print-xlsx-engine/spec.md) | 填充引擎 | 无 | `render_pages` / `render_sheets` / `extract_placeholders` + 单测 |
| 2 | [print-pdf-deploy](../print-pdf-deploy/spec.md) | PDF 转换 + Docker | 无（可与 1 并行） | Converter API + 镜像内 LO/CJK |
| 3 | [print-template-master](../print-template-master/spec.md) | 模板主数据 + 管理页 | 建议 1 | `sys_print_template` CRUD、上传校验、字段清单、系统管理页 |
| 4 | [print-document-pipeline](../print-document-pipeline/spec.md) | 销单/发货接入 | 1+3；打印路径要 2 | 行内/批量 打印 PDF 与导出 xlsx |

## Seams（全功能仅此四处）

1. **Renderer** — 纯 binary 填充  
2. **PrintTemplate + FieldCatalog** — 主数据与校验真相源  
3. **PdfConverter** — soffice 哑转换  
4. **Printing 门面 + 前端入口** — 鉴权、装配、下载  

## Notes

- 实现前代码已回退：仓库内无 `Printing` 实现与 Dockerfile；从零按 spec 做。
- 导出不依赖 LibreOffice；本地可先交付 export 再补 print。
- 下一步可选：`/to-tickets` 把某一 spec 拆成 `.scratch/<feature>/issues/01-*.md` 工单。

## Decisions-so-far

- 一条引擎两个产物（PDF / xlsx），拒绝双版式。
- Elixir zip+XML 填充，LO 只转 PDF。
- 批量打印 = 单 xlsx 多块 + 分页符，不合并 PDF。
- 版式主权在 Excel 页面设置；系统不建纸张字段。
- 模板全局、打印不留痕；上传即校验未知占位符。
- 首期 `sales.order` + `sales.delivery`；权限 `print` / `export` / `batch_print`。
- v1 不做：图片模板、.xls 写、异步大批量、下载 PDF 按钮。
- **2026-07-23 实现进展**：issues 01–03 已 resolved（Renderer + PdfConverter 单测绿）。Frontier 现为 **04**（Docker）与 **05**（模板主数据，依赖 01）。

## Fog

- Excel 公式在 LO 转换时的重算行为 → 实现期验证。  
- 行复制后公式引用是否调整 → 引擎约定不自动改，模板侧规避。  
- 下载 API 用 Plug 直出还是 GraphQL+短链 → pipeline 实现期与 FileController 风格对齐。  
- 模板文件与 `sys_attachment` 挂接形态细节 → master 实现期与文件管理规则对齐。
