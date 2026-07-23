# Spec: 打印 XLSX 填充引擎

**Status:** ready-for-agent  
**Feature slug:** `print-xlsx-engine`  
**Depends on:** None — can start immediately  
**Blocks:** `print-template-master`（上传校验用 extract）、`print-document-pipeline`（填充产物）  
**ADR:** [docs/adr/2026-07-23-print-template.md](../../docs/adr/2026-07-23-print-template.md)  
**Domain terms:** 打印模板、模板占位符、明细模板行、模板打印/模板导出（见 `CONTEXT.md`）

---

## Problem Statement

业务需要把销售订单、发货单等单据按固定 Excel 版式输出。填充若依赖 LibreOffice 宏、Python openpyxl 或前端 SheetJS，会引入第二运行时、双版式漂移或丢失打印区域/页眉页脚。团队已有 xlsx 读经验（银行流水导入），需要一份**纯 Elixir、可单测、无 I/O** 的填充引擎，作为整条打印/导出管线的共同核心。

## Solution

实现一个纯函数式 XLSX 模板填充模块：输入模板二进制 + 单据数据文档，输出填充后的 xlsx 二进制。同一引擎服务两条出口——**打印**（多份单据顺序铺块 + 块间分页符，供后续转 PDF）与**导出**（每单据一 sheet）。上传校验只调用占位符提取，不写盘、不调进程。

## User Stories

1. As a 系统实现者, I want 用纯 Elixir 填充 `${字段}` 占位符, so that 不引入 Python/UNO 第二运行时
2. As a 模板制作者, I want 单元格内可混排普通文字与 `${order_no}` 等占位符, so that 能写「订单号：${order_no}」这类版式
3. As a 模板制作者, I want 某一行写 `${items.*}` 成为明细模板行, so that 单据有多少条目就展开多少行
4. As a 模板制作者, I want `${items._seq}` 给出行序号, so that 明细表有序号列
5. As a 业务用户, I want 单据无条目时明细模板行被整行删除, so that 不会留下空白占位行
6. As a 模板制作者, I want 模板可以没有明细行, so that 纯表头/回执类版式合法
7. As a 业务用户, I want 字段空值填空字符串, so that 打印页不出现「null」或占位符原文
8. As a 模板制作者, I want 日期/数字显示格式靠单元格自身 Excel 格式, so that 引擎不发明格式化语法
9. As a 打印调用方, I want 单条打印把一份数据铺进模板第一个 sheet, so that 输出可直接转 PDF
10. As a 批量打印调用方, I want N 份数据顺序铺进同一 sheet 且块间有分页符, so that 一次转 PDF 得到多页单据而不做 PDF 合并
11. As a 导出调用方, I want 每份单据一个 sheet 且 sheet 名可用单号, so that 批量导出打开即是多表
12. As a 导出调用方, I want sheet 名非法字符被替换、超长截断、重名去重, so that 生成的 xlsx 可被 Excel/LibreOffice 打开
13. As a 模板管理员, I want 上传前能提取模板全部占位符（头字段 vs items 字段）, so that 能对照字段清单做校验
14. As a 打印调用方, I want 非 xlsx 或损坏包返回明确错误, so that 上层能报中文错误而不是崩溃
15. As a 模板制作者, I want 占位符藏在 sharedStrings 中也能被识别与替换, so that Excel 保存的常见写法可用
16. As a 打印调用方, I want 填充后仍保留 styles / 其他 sheet / 页面设置等未改 part, so that 版式与字体不丢
17. As a 批量打印调用方, I want 块复制时 mergeCell / 打印区域 / 行高随块偏移, so that 每张单据版式一致
18. As a 实现者, I want 空 docs 列表被拒绝, so that 不会产出空文件误导下游

## Implementation Decisions

### 模块与公共 API（唯一 seam）

- 模块：`SynieCore.Printing.Renderer`（或同级命名，保持 `Printing` 命名空间）。
- **不**依赖 Ash、数据库、文件系统、LibreOffice；只接收/返回 binary 与普通 map。
- 文档形状（实现期固定，便于上下游契约）：

```elixir
# 来自早期原型的决策片段——非完整实现
@type doc :: %{fields: %{String.t() => String.t()}, items: [%{String.t() => String.t()}]}

render_pages(template_binary, [doc]) :: {:ok, binary} | {:error, term}
# 打印用：单 sheet 顺序铺 N 块；docs 长度 1 = 单条打印；块间 row break 分页

render_sheets(template_binary, [{sheet_name, doc}]) :: {:ok, binary} | {:error, term}
# 导出用：每 doc 一个 sheet

extract_placeholders(template_binary) ::
  {:ok, %{fields: [String.t()], items: [String.t()]}} | {:error, term}
# 上传校验用；items 去掉 "items." 前缀；均去重排序
```

- 占位符语法：`${name}`，正则级匹配，不支持嵌套花括号；`items.` 前缀识别明细字段；`_seq` 为引擎注入的序号字段（从 1 起）。
- 值一律按**文本**写入单元格（inline string），显示格式由单元格原有 numFmt/style 承担；引擎不解析日期/数字类型写入。
- 含占位符的单元格统一改写为 inline string 落值，避免维护 sharedStrings 索引一致性。
- 只处理工作簿**第一个 sheet** 作为模板体；其余 sheet 原样保留（`render_pages`）；`render_sheets` 以第一个 sheet 为母版复制出 N 个 sheet。
- 明细行：扫描含 `${items.*}` 的行作为模板行；按 `length(items)` 复制；0 条则删除该行并上移下方内容；下方行、mergeCells、dimension、打印区域等引用行号需顺移。
- 批量 `render_pages`：按块累计行偏移；块间插入 rowBreak；mergeCells / 打印区域按块复制并偏移；**不**做 PDF 合并。
- 错误：结构不符（非 zip、缺 part、行缺必要属性）→ `{:error, {:invalid_template, message}}`；空 docs → `{:error, :empty_docs}`。
- 模板制作约定（写入模块文档，v1 不硬校验）：明细模板行不参与跨行合并；公式单元格内的引用不随行复制自动调整；conditionalFormatting / autoFilter / dataValidation 批量时仅对首块有完整保证。

### 与既有代码关系

- 银行流水导入的 `xlsx_reader` 是**读**路径；本引擎是**写/改包**路径，可复用 `:zip` 与测试夹具思路，不必复用 parser。
- 已有 `SynieCore.XlsxFixture` 可生成最小 xlsx 供读路径测试；本功能需更丰富的夹具（sharedStrings、mergeCells、page setup、多 sheet），可新建 `PrintingFixture` 或扩展夹具，**仅测试支持代码**，不进入业务路径。

### 明确不做（本 spec）

- 不实现 `sys_print_template` 资源、字段清单、PDF 转换、GraphQL、前端。
- 不支持模板内图片、`.xls` 写出、引擎侧格式化语法。

## Testing Decisions

- **好测试**：只断言对外行为——给定模板 binary + doc，解包或用解析手段读回单元格文本/sheet 名/分页相关结构；不测内部正则或中间 XML 字符串细节（除非错误消息是契约的一部分）。
- **覆盖面**：
  - 头字段：混排、空值、未知占位符（运行时从宽：未知可替换为空或保留策略在实现时选一种并测稳；上传侧拒未知在 master spec）
  - sharedStrings 中的占位符可替换
  - 明细：多行复制、`_seq`、0 条删除、无明细行模板
  - 批量：两块/三块偏移、rowBreak、merge/打印区域偏移
  - `render_sheets`：多 sheet、sheet 名清洗
  - `extract_placeholders`：fields/items 分离与排序
  - 错误：非 xlsx、空列表
  - 非模板 sheet / styles 原样保留
- **Prior art**：`backend` 下 bank_import parser 测试与 `XlsxFixture`；本模块测试应 `async: true`、无 Repo。
- 不依赖本机 LibreOffice。

## Out of Scope

- PDF 转换与 Docker
- 模板主数据 CRUD 与字段清单校验
- 销售订单/发货业务装配与权限
- 前端任何页面
- 图片占位、公式行引用自动重写、跨明细行合并的完整语义

## Further Notes

- 实现顺序建议本 spec 最先开工，可完全 TDD、不阻塞部署与主数据设计并行讨论。
- 早期失败原型（已回退）曾验证 zip+XML 路径可行；本 spec 不假设仓库内仍有该代码，从零按本 API 重做。
- 关联：`print-template-master`、`print-document-pipeline`；总览见 `.scratch/print-engine/map.md`。
