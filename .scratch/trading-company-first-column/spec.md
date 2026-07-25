# Spec: 购销单据公司首列设计

**Status:** ready-for-agent
**Feature slug:** `trading-company-first-column`

## 目标

采购订单、采购报价、销售报价、销售订单四个页面的所有业务表格都以“公司”作为第一列，便于跨内部公司浏览、筛选和辨识单据归属。

## 现状

四个页面均包含“条目”和“整单”两个 Tab：

- 整单表已经把 `companyId` 放在列白名单首位，符合要求。
- 默认打开的条目表明确排除了 `companyId`，因此看不到单据所属公司。
- 四类条目资源已经冗余保存父单据的 `company_id`，该字段用于公司数据权限；DataGrid 元数据已能把它作为公司外键展示和筛选。

## 设计

在以下四张条目表的 `GRID_COLUMNS` 首位加入 `companyId`：

- `web/app/routes/_app/scm/purchase/items.tsx`
- `web/app/routes/_app/scm/purchase-quotations/items.tsx`
- `web/app/routes/_app/scm/quotations/items.tsx`
- `web/app/routes/_app/scm/sales-orders/items.tsx`

最终列顺序统一为：

1. 公司
2. 订单号或报价单号
3. 其余现有列，顺序不变

整单表保持现状，不做无意义改写。

## 数据与组件

直接使用条目资源现有的 `companyId` 字段和 `SynieDataGrid` 默认外键列能力：

- 沿用现有公司外键筛选与排序。
- 沿用资源既有公司授权过滤。
- 不增加请求、不增加 calculation、不增加自定义渲染。
- 不修改数据库、GraphQL 资源或业务逻辑。

## 已知权限边界

公司主数据本身有独立 `base.company:read` 权限；GridMeta 对无该权限的用户会把公司外键降级为普通 UUID 文本列。本变更不改变这一既有权限语义：授权链完整且具备公司读取权限时，四个页面显示公司名称并提供公司筛选；未具备公司读取权限时，公司列按既有元数据降级规则显示。

## 文档

同步更新：

- `docs/产品文档/采购订单.md`
- `docs/产品文档/采购报价.md`
- `docs/产品文档/销售报价.md`
- `docs/产品文档/销售订单.md`
- `CONTEXT.md`

四篇产品文档的条目列表字段说明明确以“公司”开头；`CONTEXT.md` 记录购销报价和订单跨公司列表统一以内部公司为首列的口径。

## 验证

## 非目标

- 不改变公司权限或数据隔离规则。
- 不要求仅有购销单据读取权限的用户获得 `base.company:read`。
- 不改变整单表其他列的顺序。
- 不增加顶部公司选择器。
- 不改抽屉表单中的公司字段行为。
