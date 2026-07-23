# 05 — 打印模板主数据 + 字段清单 + 上传校验

**What to build:** `sys_print_template` CRUD/设默认；上传 xlsx 即校验占位符；sales.order/delivery 字段清单。

**Blocked by:** 01 — XLSX 填充：头字段 + 占位符提取

**Status:** resolved

- [x] 资源 + 权限 sys.print_template
- [x] 未知占位符拒存点名；非 xlsx 拒存
- [x] 同资源至多一个默认（set_default）
- [x] FieldCatalog 注册订单与发货

## Answer

已在 2026-07-23 实现并合入。
