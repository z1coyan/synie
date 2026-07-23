# Spec: 打印模板主数据与管理页

**Status:** ready-for-agent  
**Feature slug:** `print-template-master`  
**Depends on:** `print-xlsx-engine`（`extract_placeholders` 用于上传校验；可用最小 stub 先行但合并前须接真引擎）  
**Blocks:** `print-document-pipeline`（模板列表与默认选择）  
**ADR:** [docs/adr/2026-07-23-print-template.md](../../docs/adr/2026-07-23-print-template.md)  
**Domain terms:** 打印模板、模板占位符、明细模板行、存储接入点、文件挂接（见 `CONTEXT.md`）  
**产品说明:** [docs/产品文档/系统管理.md](../../docs/产品文档/系统管理.md)「打印模板」

---

## Problem Statement

管理员需要按资源类型维护多份 Excel 版式模板，并指定默认模板。若校验拖到打印时才失败，业务人员会在出单高峰才发现错字段。系统需要**全局共享**的模板主数据、上传即校验、管理页可维护，且不把公司维度绑进模板（抬头走占位符）。

## Solution

新增 **打印模板**（`sys_print_template`）主数据：名称 + 资源类型 + .xlsx 文件 + 默认标记 + 备注。上传只收 xlsx，提取全部占位符对照该资源**字段清单**，未知字段拒绝保存并逐个点名。系统管理菜单提供模板列表/抽屉；页面展示字段清单供制作者查阅。模板可删、无引用约束（打印瞬时不留痕）。

## User Stories

1. As a 系统管理员, I want 在系统管理中维护打印模板, so that 业务侧打印前版式已就绪
2. As a 系统管理员, I want 一份模板绑定一个资源类型（如 `sales.order`）, so that 字段清单与单据类型对齐
3. As a 系统管理员, I want 同一资源可上传多份模板, so that 内销/外销等不同版式可并存
4. As a 系统管理员, I want 同资源至多一份默认模板, so that 打印时能预选
5. As a 系统管理员, I want 设默认/取消默认有明确动作, so that 不会出现同资源两个默认
6. As a 系统管理员, I want 上传 .xlsx 后立即校验占位符, so that 错字段不会活到打印时
7. As a 系统管理员, I want 未知占位符被拒绝并逐个点名, so that 我知道改模板哪一格
8. As a 系统管理员, I want 非 .xlsx（含老 .xls）被拒绝, so that 写端格式统一
9. As a 模板制作者, I want 管理页看到该资源的《字段清单》, so that 我知道能写哪些 `${字段}`
10. As a 模板制作者, I want 清单区分头字段与明细字段（`items.*`）, so that 我知道哪行该写明细占位符
11. As a 系统管理员, I want 上传时若未检测到页面设置给出警告但不拦截, so that 版式疏忽可提示但仍能存草稿级模板
12. As a 系统管理员, I want 更新模板可替换文件, so that 改版式不必删建
13. As a 系统管理员, I want 删除模板无「被引用」拦截, so that 清理过时版式不卡流程
14. As a 系统管理员, I want 模板全局共享不分公司, so that 不用每公司维护一份相同版式
15. As a 权限管理员, I want 用 `sys.print_template` 的 create/read/update/delete 控制管理页, so that 与编号规则等系统资源一致
16. As a 业务用户, I want 无管理权限时看不到模板管理菜单, so that 界面简洁
17. As a 系统管理员, I want 模板文件走既有文件上传与存储接入, so that 不另建对象存储通道
18. As a 系统管理员, I want 模板列表能按资源类型筛选, so that 模板多时好找
19. As a 实现者, I want 首期字段清单覆盖销售订单与销售发货单, so that 与管线首期接入一致
20. As a 系统管理员, I want 创建时必传文件、名称必填, so that 不出现空壳模板

## Implementation Decisions

### 资源 `PrintTemplate`（表 `sys_print_template`）

- 权限：`permission_prefix "sys.print_template"`；`permission_actions ~w(create read update delete)`（管理类，不含 print/export）。
- 全局主数据：无公司字段；policies 按功能权限，不做公司数据过滤。
- 字段（逻辑）：
  - `name`：显示名，必填
  - `resource`：权限资源码字符串（如 `sales.order` / `sales.delivery`），创建后是否可改：建议**创建后不可改**（改资源=字段清单变了，应新建）
  - `file_id`：关联 `sys_file`（或等价挂接）；模板文件不可变内容，换版=换文件
  - `is_default`：布尔；同 `resource` 至多一条 true（partial unique 或 set_default 事务切换，对标存储接入 `set_default` 先例）
  - `remarks`：可空备注
  - timestamps
- 动作：标准 CRUD + `set_default`（update 类衍生动作，复用 update 权限码）。
- 删除：无引用约束；是否同时删 `sys_file`：若文件仅被该模板使用可级联或 fortget——实现期选一种并保证无挂接孤儿策略与文件管理一致（有挂接不可删文件的规则仍适用：模板应建 attachment 或明确 owner，使文件管理可见）。

### 上传校验

- 仅 `.xlsx`（魔数 zip / 扩展名双检，与银行导入严格度对齐但**不接受 .xls 写出**）。
- 调用 `Renderer.extract_placeholders/1` 得到 fields 与 items。
- 对照 `Printing.FieldCatalog`（或等价）该 `resource` 的允许集合：
  - 头字段 ∈ catalog.fields
  - 明细字段 ∈ catalog.items（清单里可不带 `items.` 前缀，与 extract 对齐）
  - `_seq` 为引擎保留字，视为合法明细字段，不必出现在业务 catalog 业务列中但校验放行
- 任一未知 → 拒绝保存，错误信息中文并列出全部未知名。
- 页面设置检测：解析 workbook/sheet 是否含 pageSetup / printArea 等；缺失 → **warning 通道**（若 API 只能单结果，可返回成功 + 警告字段，或仅前端/变更消息提示）；**不**拦截保存。

### 字段清单（FieldCatalog）

- 代码内注册表，按 `resource` 前缀列出稳定英文标识 + 中文说明（供管理页展示）。
- 首期：
  - `sales.order`：头字段含单号、日期、类型、状态、公司名/税号/地址等常用抬头、对手名称、币种、汇率、条款、备注等；明细含序号相关、物料编码/名称/规格、客户料号、单位、数量、单价、金额、税率、行备注等（以产品与单据实际可取字段为准，装配在 pipeline spec）。
  - `sales.delivery`：发货单号、日期、过账日、公司、对手、备注、状态；明细物料/数量/单位等。
- 清单是上传校验与后续「单据→doc」装配的**同一真相源**；pipeline 装配不得输出清单外键名（引擎运行时对未知占位从宽，但装配侧应完整）。
- 未注册 resource 的模板：创建时拒绝或仅允许已注册资源枚举。

### 文件

- 复用 `SynieCore.Files.upload`：先上传得 `sys_file`，再 create/update 模板指向该文件；或模板 create 接收 upload 一体完成——对标附件面板既有动线，优先一致。
- 下载模板原文件：有 `sys.print_template:read` 即可（管理用途）。

### GraphQL / Grid

- 注册 list/get/create/update/destroy/set_default；GridMeta 资源名供前端 DataGrid。
- 列：名称、资源类型、是否默认、备注、更新时间等；文件进抽屉。

### 前端

- 菜单：系统管理 → 打印模板（路径如 `/system/print-templates`）。
- DataGrid + RecordDrawer：资源类型选择（仅已注册 catalog 的资源）、文件上传、默认开关/行内「设为默认」。
- 抽屉或侧栏展示当前资源《字段清单》（头/明细分组、英文名 + 中文，可复制 `${...}`）。
- 标签：权限矩阵自动派生 `sys.print_template` 中文名「打印模板」。

### 依赖

- 硬依赖填充引擎的 `extract_placeholders`。
- **不**依赖 LibreOffice / PDF。
- 不实现单据侧打印按钮（pipeline spec）。

## Testing Decisions

- **好测试**：通过 Ash 动作与校验边界断言中文错误；字段清单单元测「已知/未知」；不测 React 像素。
- **覆盖**：
  - 合法模板保存成功
  - 未知占位符拒存且点名
  - 非 xlsx 拒存
  - 同资源第二个 default 经 set_default 切换唯一
  - 删除成功
  - 无权限被拒
  - 未注册 resource 拒存
- **Prior art**：`sys_numbering_rule` 资源+校验、`sys_storage` 的 set_default、银行导入的文件类型错误文案、文件上传测试。
- 模板 binary 用引擎测试夹具生成最小合法 xlsx。

## Out of Scope

- 填充算法本身（`print-xlsx-engine`）
- PDF / Docker（`print-pdf-deploy`）
- 销售订单/发货的打印导出入口（`print-document-pipeline`）
- 模板内图片、按公司隔离模板、模板版本历史/打印留痕
- 采购/库存等其它资源字段清单（可预留注册点，v1 不要求业务接入）

## Further Notes

- 产品文档与 glossary 已描述本能力；实现完成后核对 `docs/产品文档/系统管理.md` 是否与行为一致（应已对齐，无需新写产品篇）。
- 关联总览：`.scratch/print-engine/map.md`。
