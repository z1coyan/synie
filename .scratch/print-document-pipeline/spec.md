# Spec: 单据模板打印/导出管线（销售订单 · 销售发货）

**Status:** ready-for-agent  
**Feature slug:** `print-document-pipeline`  
**Depends on:**  
- `print-xlsx-engine`（填充）  
- `print-template-master`（模板与字段清单）  
- `print-pdf-deploy`（仅打印/批量打印路径；导出可先交付）  
**ADR:** [docs/adr/2026-07-23-print-template.md](../../docs/adr/2026-07-23-print-template.md)  
**Domain terms:** 模板打印/模板导出、打印模板、销售订单、销售发货单、标准动作  
**产品说明:** [docs/产品文档/系统管理.md](../../docs/产品文档/系统管理.md) 打印模板节；销售相关产品篇

---

## Problem Statement

业务人员需要在销售订单、销售发货单上按公司版式**打印**或**导出 Excel**，且批量勾选后一次产出。当前 DataGrid 的 print/export 是列表行 HTML/CSV，不是单据版式。需要在标准动作 `print` / `export` / `batch_print` 上接入模板管线：选模板 → 装载数据 → 填充 → PDF 或 xlsx，并与 CSV 列表导出语义切割。

## Solution

增加打印编排层：按资源加载模板与单据 → 装配为引擎 `doc` → `render_pages`（打印）或 `render_sheets`（导出）→ 打印再转 PDF。前端在销售订单/发货列表与行内覆盖默认列表打印：先弹模板选择（预选默认），无模板时引导去系统管理上传。批量上限 100；批量导出不新增 `batch_export` 权限码，由 `export` 门控。

## User Stories

1. As a 销售员, I want 在销售订单行内点「打印」得到版式 PDF, so that 可直接送审/给客户
2. As a 销售员, I want 行内「导出 Excel」下载填充后的 xlsx, so that 可再微调或外发
3. As a 销售员, I want 打印与导出版式一致, so that 不用维护两套模板
4. As a 销售员, I want 操作前选择模板且默认已预选, so that 常用版式一键完成
5. As a 销售员, I want 临时换用非默认模板, so that 特殊客户用专用版式
6. As a 销售员, I want 无可用模板时得到明确提示去上传, so that 不静默落到列表 HTML 打印
7. As a 销售员, I want 勾选多条订单批量打印成一个 PDF, so that 连续打印多张
8. As a 销售员, I want 批量导出为一个 xlsx 多 sheet（sheet 名单号）, so that 一次带走多张单
9. As a 销售员, I want 批量超过 100 条被拒绝并提示, so that 同步请求不拖垮服务
10. As a 销售员, I want PDF 在浏览器打开, so that 预览/打印/另存都用浏览器能力
11. As a 销售员, I want PDF 服务故障时仍能导出 Excel, so that 出单不中断
12. As a 销售员, I want 列表工具栏 CSV 导出仍可用, so that 分析列表数据不受影响
13. As a 销售员, I want 对销售发货单有与订单相同的打印/导出体验, so that 发货单据同样出单
14. As a 权限管理员, I want 用标准动作 print/export/batch_print 控制入口, so that 矩阵里原有列即可授权
15. As a 权限管理员, I want 批量导出受 export 控制且不新增 batch_export, so that 权限模型保持简单
16. As a 无打印权限的用户, I want 看不到打印按钮, so that 不会误操作
17. As a 仅有 export 无 print 的用户, I want 能导出不能打印, so that 权限可细拆
18. As a 业务用户, I want 只能打印/导出自己有权 read 的单据, so that 数据权限不绕过
19. As a 业务用户, I want 公司抬头来自单据公司字段占位符, so that 全局模板仍显示正确抬头
20. As a 业务用户, I want 明细行按条目展开且有序号, so that 打印件与系统单据一致
21. As a 业务用户, I want 打印/导出不落库不留痕, so that 不产生「打印记录」包袱
22. As a 业务用户, I want 失败时看到中文错误（无模板/无权限/转换失败/超限）, so that 可自助处理
23. As a 销售员, I want 批量打印多张单之间自动分页, so that 不会一张纸粘两单
24. As a 实现者, I want 新增资源接入时主要加字段装配与 permission_actions, so that 管线可扩展

## Implementation Decisions

### 编排 seam：`SynieCore.Printing`（门面）

建议对外能力（名称可调，保持单一门面）：

- 列出某资源可用模板（含默认标记）——供前端弹窗
- `print(resource, record_ids, template_id, actor)` → PDF binary + filename 提示
- `export(resource, record_ids, template_id, actor)` → xlsx binary + filename
- 内部步骤：鉴权 → 载模板文件 bytes → 载单据（遵守公司数据权限）→ 装配 `doc` 列表 → Renderer →（print 时）PdfConverter
- 批量：`length(ids) in 1..100`；0 或 >100 明确错误
- 打印：`render_pages(template, docs)` → convert → PDF  
- 导出：`render_sheets(template, Enum.map(docs, &{sheet_name(&1), &1}))`；sheet 名优先单号
- 不写业务表、不写审计「打印事件」（除非未来产品要求；v1 ADR：不留痕）

### 权限

- 销售订单：`permission_actions` 在现有工作流动作上**增加** `print export batch_print`（保留 create/read/update/delete/audit/close/void）。
- 销售发货：同样增加 `print export batch_print`。
- 每次操作：
  - print / batch_print → 要求对应 `print` / `batch_print`（批量打印用 batch_print；单条用 print）
  - export / 批量导出 → 均要求 `export`
  - 另须能 read 目标记录（公司授权 fail-closed 与现网一致）
- 模板管理权限与单据打印权限分离：有 print 无 sys.print_template 仍可打印（用已有模板）。

### 数据装配（DocBuilder）

- 按 `resource` 将 Ash 记录转为 `%{fields: %{...}, items: [%{...}]}`，键名与 FieldCatalog 一致，值均为字符串（空 → `""`）。
- 关联字段（公司名、对手名、币种名等）在装配时 resolve，不把关联 id 甩给模板 unless 清单收录。
- 首期资源：`sales.order`、`sales.delivery`。
- 金额/数量：字符串化策略稳定（不强制千分位；显示靠 Excel 格式时，若以文本写入则模板侧用文本样式——与引擎「一律文本」决策一致；实现期若需数字单元格可单列例外，但须写进引擎契约，本 pipeline 默认跟引擎文本契约）。

### API 暴露

- 优先：HTTP 下载端点（如认证后 `POST` 打印/导出，返回 `application/pdf` 或 xlsx 流），避免 GraphQL 传大 binary；或 GraphQL 触发 + 短时 token 下载——实现期选与现有 FileController 风格一致的一种。
- 请求体：`resource` / `ids` / `template_id` / `mode`（print|export）。
- 错误：401/403、404 模板或单据、422 校验（超限、无模板）、503 转换失败等，body 中文。

### 前端

- 销售订单页、销售发货页：
  - 覆盖 DataGrid 默认 `onPrintRows`：改为打开模板选择 → 调打印 API → 新窗口打开 PDF blob（注意弹窗拦截提示）
  - 导出：模板选择 → 下载 xlsx；与工具栏 CSV「导出」并存——**文案区分**：模板导出称「导出 Excel」/「批量导出 Excel」，CSV 保持现有「导出」列表语义（若现「导出」仅 CSV，则模板导出用更明确标签，避免两个都叫导出）
  - 批量打印走 `batch_print` capability；批量导出走 `export` capability + 多选
- 模板选择弹窗：拉该资源模板列表，预选 `is_default`，无默认则选第一项或强制选择；无列表 → 提示前往打印模板管理页。
- **不**回退到 `printRows` HTML 列表打印作为模板缺失时的 fallback（产品已定）。
- 不提供单独「下载 PDF」按钮。

### CSV 切割

- 列表 CSV 继续走现有 export 列数据路径；若与模板导出抢同一按钮，拆成两个入口或二级菜单，产品文案与权限说明保持「并存互不干扰」。

### 扩展点

- 新资源接入清单：FieldCatalog 注册 → DocBuilder 子句 → 资源 `permission_actions` 打开 print/export/batch_print → 前端页接线。不改 Renderer/PdfConverter。

## Testing Decisions

- **好测试**：编排层给定 actor + 种子单据 + 模板文件，assert 返回 MIME/魔数与关键错误码；权限否定用例；批量 101 拒绝。不测 PDF 版式像素。
- **分层**：
  - DocBuilder 纯单元：记录 → doc 键值
  - 门面集成：Repo + 权限（可对标其它 Ash 动作测试）
  - PdfConverter 可 mock，使 CI 无 LO 仍能测 print 路径错误分支与 export 成功
  - 前端：关键逻辑（模板预选、超限提示）可用组件测或 E2E 人工
- **Prior art**：文件下载授权测试、grid 权限 capability、销售订单审核类动作测试。

## Out of Scope

- 其它单据（采购订单、入库、发票等）接入——仅预留扩展点
- 模板 CRUD UI（master spec）与引擎内部（engine spec）
- 异步任务队列、超过 100 的后台批量
- 打印历史/审计事件
- 模板图片、双版式 HTML
- 修改全局 DataGrid 默认 HTML 打印行为（未接模板的资源仍用列表打印）

## Further Notes

- 交付切片建议：先订单 export（无 LO）→ 订单 print → 发货对等 → 批量。
- 实现完成后核对产品文档销售篇是否需补一句「支持模板打印/导出」（系统管理篇已写总述）。
- 关联总览：`.scratch/print-engine/map.md`。
