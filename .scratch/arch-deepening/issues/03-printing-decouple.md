# 03 D · printing 与业务域脱钩 + 删死代码

Status: ready-for-agent

## 问题

- `platform/printing/docbuilder-sales-order.ts`（263 行）直查 sal_order/
  sal_order_item/sal_customers/pur_supplier/hr_employees/inv_material/bas_unit/
  sal_quotation_item 八张业务表；`format.ts:61-107` 内置业务枚举标签——
  业务知识住在 platform。
- 内置 adapter 自装配（`printing/service.ts:67-68`），`registerDocBuilder`/
  `setPDFConverter` 两个 seam 形同虚设；注册顺序是注释里的隐性契约。
- 死代码：`sales-order-meta.ts`（282 行 100% 死，且是订单 Meta 的漂移拷贝）、
  `catalog-stubs.ts`（31/37 条已死，余 6 条向 `/printing/field-catalog`
  输出**错误的字段目录**）。

## 方向

- SalesOrderDocBuilder 迁回 `modules/trading/order/`，`index.ts` 显式
  `printing.registerDocBuilder('sales.order', …)` 装配；converter 归组合根
  构造（SOFFICE_* 归 env.ts，不再模块内直读 process.env）。
- 删除 `sales-order-meta.ts` 与 `catalog-stubs.ts`（约 470 行），
  让 Registry 的 fail-closed 自然兜住打印目录。

## 验收

- platform/printing 内零业务表查询、零业务枚举标签；
- 第二个资源接入打印（如采购订单）零改动 platform；
- 打印/导出集成测试（printing integration）全绿，字段目录输出正确。
