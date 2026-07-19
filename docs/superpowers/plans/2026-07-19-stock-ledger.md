# 计划：库存分录与出入库/调拨单据（v1）

2026-07-19。设计定案见 `docs/adr/2026-07-19-stock-ledger.md`，术语见 `docs/glossary.md`。
本计划只做实施切分与命名契约，不复述设计理由。

## 命名契约

| 资源 | 表 | permission_prefix | voucher_type |
|---|---|---|---|
| `SynieCore.Inv.StockEntry` | `inv_stock_entry` | `inv.stock_entry`（read） | — |
| `SynieCore.Inv.StockIn` / `StockInItem` | `inv_stock_in` / `inv_stock_in_item` | `inv.stock_in` | `inv.stock_in` |
| `SynieCore.Inv.StockOut` / `StockOutItem` | `inv_stock_out` / `inv_stock_out_item` | `inv.stock_out` | `inv.stock_out` |
| `SynieCore.Inv.StockTransfer` / `StockTransferItem` | `inv_stock_transfer` / `inv_stock_transfer_item` | `inv.stock_transfer` | `inv.stock_transfer` |

- 领域模块 `SynieCore.Inv.Stock`：`post!/2`、`cancel!/2`、`voucher_resources/0`、负库存校验（含作废路径）、咨询锁、余额查询。照 `SynieCore.Acc.GL` 先例——单据不直接碰 `StockEntry`。
- 分录字段：company/warehouse/material/quantity（带符号、check ≠0）/posting_date/voucher_type/voucher_id/voucher_no/remarks/is_cancelled/seq（generated）/inserted_at；索引 `(company_id, warehouse_id, material_id, posting_date)`、`(voucher_type, voucher_id)`。`poly_refs` 声明 voucher_id。
- 单据头：doc_no（AutoNumber，唯一）/company/warehouse(s)/doc_date（默认当天）/summary（摘要→分录 remarks）/remarks/status/audited_at/created_by/audited_by。入出库单头一仓（warehouse_id）；调拨单三仓（from/to/transit_warehouse_id，两两不同、本公司叶子、保存+发货审核时校验启用，收货不校验）。
- 单据行：idx/material/unit/qty（录入数量>0）/base_qty（折算默认单位，保存时系统算、6 位小数）/material_code/material_name/material_spec/unit_name 快照/remark；行编辑限母单草稿（照 OrderItem 先例）；母单删除行走 DB 级联。
- 入出库单状态机：draft→audited→voided（audit/void 动作，审核派生分录：入正出负；void 过负库存校验后 cancel! 分录）。调拨单：draft→shipped→received（ship/receive 动作；ship 写「from 负+transit 正」，receive 按行实收发「transit 负+to 正」，参数 receipts=[{item_id, qty}]，0≤qty≤base_qty，置 received_qty；已发货不可作废删除）。
- 约束收口：仓有分录（含已作废）禁删、不能改非叶子；物料被分录引用禁删、default_unit 不可改。
- 报表：`StockEntry` 泛型动作 `:stock_balance`（company_id 必填，as_of/warehouse_id/material_id 可选，hide_zero 默认 true）→ 仓×物料聚合行（含仓名/物料编号名称规格/默认单位名/数量）；分录流水=标准 read。
- 编号规则 seeds（照物料先例，幂等跳过）：`inv.stock_in` RK、`inv.stock_out` CK、`inv.stock_transfer` DB，段=前缀+doc_date(YYYYMMDD)+"-"+seq(4)，per_company: true。
- GraphQL：domain 注册三个单据的 list/create/update/destroy + audit/void/ship/receive mutation + `inv_stock_entries` list + `inv_stock_balance` action。行资源的 mutation 注册照 OrderItem 先例。

## 阶段切分

1. **后端 A**：`StockEntry` + `Inv.Stock` + 入库单/出库单（含行）+ seeds + domain 注册 + 迁移 + 测试。
2. **后端 B**：调拨单（ship/receive）+ 仓库/物料约束收口 + `:stock_balance` 报表 + 测试。
3. **前端**：供应链→库存菜单五个页面（入库单/出库单/调拨单/库存余额/库存分录），codegen、权限与日志中文标签。
4. **文档**：`docs/产品文档/库存.md` 新篇 + `库存物料.md` 概述边界改写 + 相关文档互链。

## 验证

- `cd backend && mix test` 全绿；`mix format --check-formatted`；编译无警告。
- 前端：`cd web && bun run codegen && bun run build`（或项目既定检查命令）。
