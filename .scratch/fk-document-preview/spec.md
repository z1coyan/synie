# Spec: 单据只读速览（Fk 头+行）

**Status:** done
**Feature slug:** `fk-document-preview`
**ADR:** 无新增 ADR（前端呈现层能力；不改变库存/权限领域规则）
**Domain terms:** 库存分录、来源单据、资源文档、基础资源表单、呈现扩展、权限码（见 `CONTEXT.md`）
**Depends on:** 库存分录流水与各来源单据 CRUD 已交付；全局 `FkPreviewProvider` 已存在

---

## Problem Statement

库存分录流水（及全站其它外键链接）点开来源单据时，走全局 `FkPreviewProvider`，只吃资源文档的**基础资源表单**，因此**只有单据头字段**。子表（条目/扣料/副产等）挂在各业务页的呈现扩展里，速览链路未接入。

仓管/计划从分录溯源时看不到「这一单动了哪些料、各多少」，只能再去业务列表搜单号，体验断裂。来源类型已扩到 8 类（手工出入库/调拨/盘点、销售发货、采购入库、生产入库、委外发料/入库），缺口一致。

## Solution

引入全局**单据只读速览**注册表：按资源声明「标题（单号+状态）+ 只读头字段 + 库存相关子表」。`FkPreview` 有登记则走统一只读壳，无登记则**退化**为今日仅基础表单头字段（不炸）。

产品本期以**库存分录点开来源**验收 8 类全覆盖；机制是全局的，其它入口（总账分录等）未登记资源可暂维持仅头字段。

## User Stories

1. As a 仓管, I want 从库存分录点来源单号/来源单据看到头+行, so that 不用离开分录页去搜业务单
2. As a 仓管, I want 8 类库存来源都能看到库存相关行表, so that 不论哪条分录都能核对
3. As a 仓管, I want 标题一眼看到单号与状态, so that 作废分录点进来源时知道单是否仍有效
4. As a 仓管, I want 发货速览只看出库条目不含装箱, so that 聚焦库存数量不来源
5. As a 仓管, I want 委外入库速览看到成品+扣料+副产, so that 与分录双边/多边数量对得上
6. As a 用户, I want 无来源资源 read 时打不开明细, so that 不因看过分录就穿透价税/对手
7. As a 用户, I want 速览纯只读无审核按钮, so that 溯源不会误触工作流
8. As a 用户, I want 点「来源单号」与点「来源单据」进同一套速览, so that 主路径不漏
9. As a 开发, I want 未登记资源仍可仅头字段速览, so that 不强制一次接完全站聚合单据

## Implementation Decisions

### 机制

- **注册表**（推荐落点：`web/app/components/synie-record-drawer/` 旁或 `web/app/lib/resources/document-preview/`）：`Record<resourceKey, DocumentPreviewConfig>`。
- **配置内容（概念）**：
  - `label`、单号字段名、状态字段名（标题区）
  - 头：`exclude` / `fields` 对齐该资源业务抽屉只读子集（去掉录入人、时间戳等噪音；**status 不进表单区**）
  - 子表列表：每表 `title`、行 resource/client、`parentIdField`、列白名单/overrides、排序
- **壳 UI**：`mode="view"` 的 `SynieRecordDrawer`（或等价）+ 标题区单号/状态 chip + `extraContent` 只读表（可复用只读 DataGrid / 现有条目表只读模式，禁止编辑控件）
- **`FkPreviewProvider`**：先查注册表；命中则 DocumentPreview；未命中则现有 `basicFormDrawerProps` 路径
- **不**复用完整业务抽屉的 edit/audit/void footer

### 子表范围（库存相关）

| 资源 | 子表 |
|------|------|
| `invStockDocs` | 出入库行 |
| `invStockTransfers` | 调拨行 |
| `invStockCounts` | 盘点行 |
| `salDeliveries` | **仅**发货条目（**不含**装箱箱/装箱行） |
| `purReceipts` | 入库条目 |
| `mfgOutputs` | 生产入库行 |
| `purOutsourcedIssues` | 发料条目 |
| `purOutsourcedReceipts` | 成品入库行 + 材料扣减行 + 副产物行 |

### 格式统一

- 壳统一：标题 + 只读头 + section 标题 + 只读表
- 列集**按单据**，不强行同一套列
- 有物料的行：全站**物料富单元格**

### 权限

- 严格来源资源 `read`（及公司数据权限）；无权限：link 不可点或打开后明确 403；**不做**「分录 read 穿透来源」投影 API

### 明确不做（本期）

- 不高亮/不锚定触发分录对应行
- 无「在业务页打开」跳转、无编辑/审核
- 不把装箱等非库存子表塞进速览
- 总账分录来源等其它入口不强制本期登记（机制可复用）
- 不改后端分录模型（无 `source_line_id`）

### 库存分录页

- `voucherId`（多态 fk）与 `voucherNo` **均可点**，同一 `openPreview(resource, id)`（底层 type+id）
- 仍 exclude 原始 `voucherType` 码列（类型由筛选/链接解析表达）

### 文档

- 更新 `docs/产品文档/库存物料.md` 库存分录流水：来源可点开头+行只读速览
- 无新领域术语则 `CONTEXT.md` 不动

## Out of Scope

- 业务列表页自己的 view 抽屉是否同步改壳（可继续用现有实现；速览注册表与编辑抽屉解耦）
- 资源文档声明 has_many 预览（C 方案，留跟进）
- 分录行级锚点 / 后端冗余来源行 id

## Acceptance（端到端）

持各来源 read 的用户，在库存分录流水对 8 类来源：

1. 点来源单号或来源单据 → 只读速览打开  
2. 标题可见单号 + 状态  
3. 头字段齐全（对齐业务抽屉关键头字段）  
4. 库存相关行表可见；发货无装箱；委外入库三表齐全  
5. 无来源 read 时不可穿透明细  
6. 无编辑/审核按钮  

## Tickets

| # | 文件 | 摘要 |
|---|------|------|
| 01 | [issues/01-preview-shell-and-registry.md](./issues/01-preview-shell-and-registry.md) | 只读速览壳 + 注册表 + FkPreview 接入 |
| 02 | [issues/02-register-other-stock-docs.md](./issues/02-register-other-stock-docs.md) | 登记手工出入库/调拨/盘点 |
| 03 | [issues/03-register-standard-fulfillment.md](./issues/03-register-standard-fulfillment.md) | 登记销发/采入/生产入库 |
| 04 | [issues/04-register-outsourced-docs.md](./issues/04-register-outsourced-docs.md) | 登记委外发料/入库（含三表） |
| 05 | [issues/05-stock-entries-voucher-links.md](./issues/05-stock-entries-voucher-links.md) | 分录页来源单号可点 |
| 06 | [issues/06-docs-and-acceptance.md](./issues/06-docs-and-acceptance.md) | 产品文档 + 验收收口 |
