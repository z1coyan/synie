# 复杂单据 Aggregate Draft 模块

Status: ready-for-agent

## 目标

把表头、明细、阶梯的加载与保存语义收进对应业务聚合 module；页面只处理交互和结果反馈。

## 验收

- 不建立 Catalog 通用写引擎。
- 每个已迁移聚合通过明确的 Aggregate Draft interface 工作。
- production Hono adapter 与测试用 in-memory adapter 覆盖成功、校验失败和部分写失败。
- 已迁移 Drawer 不再自行执行 create/update/delete 循环。

## Comments

- 2026-07-31：分派给 subagent `aggregate_draft`，优先处理已有部分保存风险的 SCM 单据。
- 2026-07-31：首个切片选择采购入库；后端已有 fulfillment `ItemInTx` 基础，可补真正单事务 draft endpoint。报价/订单缺少对应事务 seam，不以客户端顺序循环冒充原子保存。
- 2026-07-31：采购入库已完成 draft GET/create/replace 单事务 vertical slice，Drawer 已移除手写 diff/save loop；新增第二条明细失败时整单回滚的 PG 测试（无测试数据库时 gated skip）。下一切片为销售/采购报价。
- 2026-07-31：销售/采购报价已完成双侧单事务 draft endpoint 与前端 Adapter，三个已迁移 Drawer 共 11 个 interface tests 通过；server 全测 201 pass / 144 gated skip。下一切片评估并迁移销售/采购订单，采购委外子数据必须保持完整语义。
- 2026-07-31：销售/采购订单已完成整单事务；采购委外 materials/byproducts 通过事务内 draft port 完整替换，并覆盖跨条目/未知/重复 id 与回滚。采购入库、双侧报价、双侧订单 Drawer 均改经 ResourceBinding.draft；六个聚合头禁止 writer.create/update、只保留 delete。Web 154 tests/typecheck 与 server 201 tests/typecheck 通过，149 个 PG 用例因缺测试数据库 gated skip。
- 2026-07-31：终审补齐 replace 的严格 PUT schema（全部子集合/嵌套子树必传）、严格有效日期与正金额校验、repeatable-read 一致快照及按新增/更新/删除差异保持旧 RBAC。销售发货前端 converter 对缺失集合同样 fail-closed，显式空数组才表示清空；独立临时 PostgreSQL 完整迁移后 30 个事务/回滚用例全部通过。
- 2026-07-31：最终集成审计发现 5 个 Drawer 在 edit 明细 pending/failed 时仍可能提交暂态空快照。六个聚合现统一通过 `assertAggregateDraftReady` 双重门控：加载前禁用保存/保存并审核，提交入口再次 fail-closed；销售发货同时改用类型恢复后的 `AggregateDraftAdapter<SalesDeliveryDraftInput, SalesDeliverySavedDraft>`，不再以 `unknown` 绕过草稿输入检查。
