# PR-2.11 库存域超级批次迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，不修改业务规则。迁移前运行事实以旧
Elixir/Ash Resource、`SynieCore` GraphQL Domain、真实 `GridMeta.build/2` 输出和 PostgreSQL
约束为准；迁移后仍须满足已明确的产品规则与当前 Go 已有改进。两者不一致处单列，不伪装成
机械 parity。

## 范围

### 主数据（四资源）

| Grid 资源 | Elixir Resource | 表 | 权限前缀 |
|---|---|---|---|
| `invMaterialCategories` | `SynieCore.Inv.MaterialCategory` | `inv_material_category` | `inv.material_category` |
| `invMaterials` | `SynieCore.Inv.Material` | `inv_material` | `inv.material` |
| `invMaterialUnits` | `SynieCore.Inv.MaterialUnit` | `inv_material_unit` | 复用 `inv.material` |
| `invWarehouses` | `SynieCore.Inv.Warehouse` | `inv_warehouse` | `inv.warehouse` |

### 库存事实与其他库存单（七资源）

| Grid 资源 | Elixir Resource | 表 | 权限前缀 |
|---|---|---|---|
| `invStockEntries` | `SynieCore.Inv.StockEntry` | `inv_stock_entry` | `inv.stock_entry` |
| `invStockDocs` | `SynieCore.Inv.StockDoc` | `inv_stock_doc` | `inv.stock_doc` |
| `invStockDocItems` | `SynieCore.Inv.StockDocItem` | `inv_stock_doc_item` | 复用 `inv.stock_doc` |
| `invStockTransfers` | `SynieCore.Inv.StockTransfer` | `inv_stock_transfer` | `inv.stock_transfer` |
| `invStockTransferItems` | `SynieCore.Inv.StockTransferItem` | `inv_stock_transfer_item` | 复用 `inv.stock_transfer` |
| `invStockCounts` | `SynieCore.Inv.StockCount` | `inv_stock_count` | `inv.stock_count` |
| `invStockCountItems` | `SynieCore.Inv.StockCountItem` | `inv_stock_count_item` | 复用 `inv.stock_count` |

主要一手来源：

- `backend/apps/synie_core/lib/synie_core/inv/material_category.ex`
- `backend/apps/synie_core/lib/synie_core/inv/material.ex`
- `backend/apps/synie_core/lib/synie_core/inv/material_unit.ex`
- `backend/apps/synie_core/lib/synie_core/inv/warehouse.ex`
- `backend/apps/synie_core/lib/synie_core/inv/warehouse_seed.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock_entry.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock_doc.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock_doc_item.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock_transfer.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock_transfer_item.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock_count.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock_count_item.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock.ex`
- `backend/apps/synie_core/lib/synie_core/inv/stock_item.ex`
- `backend/apps/synie_core/lib/synie_core.ex`
- `backend/apps/synie_web/lib/synie_web/grid_meta.ex`
- `backend/apps/synie_core/priv/repo/migrations/20260715131551_add_inv_material_category.exs`
- `backend/apps/synie_core/priv/repo/migrations/20260716150320_add_inv_material.exs`
- `backend/apps/synie_core/priv/repo/migrations/20260718130641_add_material_customer.exs`
- `backend/apps/synie_core/priv/repo/migrations/20260719001653_add_inv_warehouse.exs`
- `backend/apps/synie_core/priv/repo/migrations/20260719082053_add_inv_stock.exs`
- `backend/apps/synie_core/priv/repo/migrations/20260719113329_add_inv_stock_count.exs`
- `backend/apps/synie_core/priv/repo/migrations/20260724143420_warehouse_outsourced_party.exs`
- `docs/产品文档/库存物料.md`
- `CONTEXT.md`
- `docs/adr/2026-07-15-material-category.md`
- `docs/adr/2026-07-16-material.md`
- `docs/adr/2026-07-18-material-customer.md`
- `docs/adr/2026-07-18-warehouse.md`
- `docs/adr/2026-07-19-stock-ledger.md`
- `docs/adr/2026-07-19-stock-count.md`

## 可复现捕获与无污染证据

四个主数据资源：

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_inventory_master_contract.exs \
  ../.scratch/migration/snapshots/pr-2.11
```

七个库存资源：

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_inventory_documents_contract.exs \
  ../.scratch/migration/snapshots/pr-2.11
```

共生成 22 份 JSON：每个资源各一份 `superadmin` 和 `read-only`。主数据 read-only Actor
仅持 `inv.material_category:read`、`inv.material:read`、`inv.warehouse:read`；库存单据
read-only Actor 仅持 `inv.stock_entry:read`、`inv.stock_doc:read`、
`inv.stock_transfer:read`、`inv.stock_count:read`。因此快照同时固定了 FK ref
的 fail-closed 行为：Actor 没有目标资源 read 权限时，FK 会退化为普通 UUID/string 列。

捕获只做 Resource 反射，不建业务数据。旧资源真实 PostgreSQL 基线：

- 主数据三份测试文件：57 passed。
- 库存引擎、余额、出入库、调拨、盘点五份测试文件：91 passed。
- 测试环境明确使用 `synie_test`，所有夹具由 Ecto SQL Sandbox 回滚。
- 捕获与测试后，开发库四个主数据表合计 `0`、七个库存表合计 `0`、含 `PR211-`
  的审计残留 `0`。

## 必须显式保留的差异

以下不是“旧后端怎样，新 Go 就照抄怎样”。

### 物料分类的启用约束

- 旧 `MaterialCategoryIsLeaf` 写路径只校验分类存在且 `is_leaf=true`；没有校验
  `active=true`。
- 旧前端物料分类选择器用 `{isLeaf: true, active: true}` 过滤，属于体验层，绕过前端仍可
  经旧 GraphQL 把物料挂到停用叶子分类。
- `docs/产品文档/库存物料.md` 明确写“只能挂启用的叶子分类”。迁移后 Go 写路径必须同时
  强制 `active + leaf`，不得以旧后端缺校验为 parity 理由放宽。

### 公司创建与默认三仓

- 旧 GraphQL 把 `createBasCompany` 与 `seedInvWarehouseDefaults` 暴露为两个独立 mutation；
  初始化向导先建公司/科目，再单独调用仓库 seed，并捕获 seed 错误继续完成向导。
  `Warehouse.seed_defaults` 自己只保证三条仓库创建在一个事务内。
- `CONTEXT.md` 的权威口径和当前 Go `company.Service.Create` 已改为：公司创建与三仓 seed
  同一事务，任一步失败整体回滚。
- 迁移后保持当前 Go 原子性，不复刻旧 GraphQL 编排缺口。验收同步已消除产品文档中
  “同一事务整体不落库”与“种子失败不阻断公司创建”的矛盾，以 `CONTEXT.md` 和当前 Go
  原子实现为准。

### 物料编号 ADR 已被后续契约替代

`docs/adr/2026-07-16-material.md` 仍写“分类编号 + 4 位序号、留空自动且可手填”。当前
Resource、Setup seed、产品文档和 `CONTEXT.md` 已一致改为：分类编号 + 可选客户编号 +
`-` + 不补零序号；`manual_entry=false`，创建不接受 `code`，创建后也不可改。迁移以
后者为准，并保留旧 ADR 作为演进记录。

### 仓库 Party 枚举的展示面大于写入面

旧 `partyType` Meta 机械反射 PartyType 全枚举：`SUPPLIER/CUSTOMER/COMPANY/EMPLOYEE`；
但 `partyId` poly ref 仅有 `SUPPLIER/COMPANY` 两个变体，Resource 写校验同样只允许这两类。
迁移后的表单和写 API 必须只允许供应商/内部公司；若 Meta 仍保留全枚举列，不得据此放宽
写入。

## 四个主数据资源

### GridMeta

| 资源 | 列数与顺序 | superadmin capability | read-only capability | destroy mutation |
|---|---|---|---|---|
| `invMaterialCategories` | 8：`id,code,name,isLeaf,active,insertedAt,updatedAt,parentId` | `create/update/delete` | `[]` | `destroyInvMaterialCategory` |
| `invMaterials` | 12：`id,code,name,spec,customerPartNo,isCustomerMaterial,active,insertedAt,updatedAt,categoryId,defaultUnitId,customerId` | `create/update/delete` | `[]` | `destroyInvMaterial` |
| `invMaterialUnits` | 6：`id,factor,insertedAt,updatedAt,materialId,unitId` | `[]` | `[]` | `destroyInvMaterialUnit` |
| `invWarehouses` | 13：`id,name,isLeaf,active,isOutsourced,partyType,partyId,allowNegative,insertedAt,updatedAt,companyId,parentId,accountId` | `create/update/delete` | `[]` | `destroyInvWarehouse` |

四者 `extendedActions` 均为空。`MaterialUnit` capability 为空是“无独立权限目录”的表现，
不是没有 CRUD；其动作复用 `inv.material` 权限。

superadmin FK：

- 分类：`parentId → invMaterialCategories`。
- 物料：`categoryId → invMaterialCategories`、`defaultUnitId → basUnits`、
  `customerId → salCustomers`。
- 转换行：`materialId → invMaterials`、`unitId → basUnits`。
- 仓库：`companyId → basCompanies`、`parentId → invWarehouses`、
  `accountId → basAccounts`；`partyId` 是以 `partyType` 判别的多态 FK，只有
  `COMPANY → basCompanies` 与 `SUPPLIER → purSuppliers`。

分类和仓库都有公开 `has_children` calculation，旧页面树组件会显式查询它；Resource 没有
将它加入 `grid_calculations/0`，所以它不在上述 Meta columns 中。迁移后的树 API/DTO 仍须
提供 `hasChildren`。

### 物料分类

来源：`material_category.ex`、分类测试、物料分类 ADR。

- 全局共享，不挂公司；`code` 必填、最多 32、全局唯一，可改；`name` 必填、最多 128，
  不唯一；`isLeaf/active` 默认 true。
- 主 read 无显式 sort 时按 `code ASC`；根可多个。
- 上级可空；不能为自己；必须存在且为非叶子。旧实现不检测两节点以上成环，这是明确留
  跟进，不应误称为已支持无限树无环校验。
- 有子分类的节点不能改成叶子、不能删除；挂着物料的叶子不能改成非叶子、不能删除。
- 删除是物理删除；写动作接通用审计。

### 物料

来源：`material.ex`、`material_test.exs`、物料/客户物料 ADR。

- 全局共享，不挂公司。`name` 必填最多 128；`spec` 可空最多 128；
  `customerPartNo` 可空最多 64；`active` 默认 true。名称/规格不做组合唯一。
- `code` 最终非空最多 64、全局唯一；创建和更新都不接受手填。初始化规则：
  `category.code + customer.code(空则省略) + "-" + padding=0 的序号`，全局规则
  `per_company=false`，按非序号前缀自然分桶。改分类/客户不追溯旧编号。
- 分类写路径的新要求见前述差异：必须存在、启用且为叶子。
- 默认单位必填。存在任何 `MaterialUnit` 行时不可改；存在任何库存分录（含已作废）后也
  不可改。
- `isCustomerMaterial=false` 时系统强制清空 `customerId/customerPartNo`；
  为 true 时 `customerId` 必填，客户方料号仍可空。报价行或销售订单行一旦引用（含已
  作废单据上的行），`isCustomerMaterial/customerId` 锁死。
- 有库存分录时不可删除。无分录删除物料会由 DB 级联删除单位转换行；附件不级联删除。
- 图纸不占物料表字段：统一附件 `owner_type=inv_material`，图片槽位 `drawing` 可多张，
  其他文件用 `default`。创建态前端先上传裸文件，物料创建成功后挂接。

### 物料单位转换

来源：`material_unit.ex`、`material_test.exs:405-425`。

- 一行表达“1 默认单位 = `factor` 该单位”；`factor > 0`。
- `(material_id, unit_id)` 唯一；转换单位不得等于默认单位；允许跨单位类型，也允许同
  类型，不与 `bas_unit.ratio` 交叉校验。
- 行随物料 DB 级联删除；直接 CRUD 接通用审计，级联删除不会逐行跑 Ash destroy 审计。
- 精确授权：
  - read：`inv.material:read`；
  - create：`inv.material:update` **或** `inv.material:create`；
  - update：`inv.material:update`；
  - destroy：`inv.material:update`。
- 旧授权测试实证：只有 `inv.material:update` 的 Actor 可 create/destroy；只有 read 的
  Actor create 被拒；`inv.material:read` 可读。create-only 备选来自 Resource policy 的
  第二个 `authorize_if`，不是从空 capability 推断。

### 仓库

来源：`warehouse.ex`、`warehouse_seed.ex`、`warehouse_test.exs`、仓库 ADR。

- 按公司隔离。`name` 必填最多 128，同公司唯一，无编号；`companyId` 创建必填，更新不
  接受换公司。read/update/destroy 均受 CompanyScope fail-closed。
- 树规则：上级可空、不能自己、必须同公司且非叶子；有下级不能改成叶子、不能删除。
  多根允许；多节点成环仍是留跟进。
- 只有叶子仓可发生库存。已有库存分录（含作废）时不可删除，也不可改成非叶子。
- `active` 默认 true。停用拦新不拦旧：新单保存与调拨发货要启用；已发调拨收货不再检查。
- `allowNegative` 默认 false；为 true 时库存引擎跳过该仓负库存校验。
- 关联科目可空；非空时必须同公司、非汇总、本币（`currency_id IS NULL`）。
- 外协仓必须同时绑定 `partyType + partyId`，只允许供应商或其他内部公司，不能绑本公司；
  非外协仓两字段必须同时为空。
- 非 CRUD：
  - GraphQL `invOutsourcedWarehouses(partyType,partyId)`：只返回绑定指定对手的外协仓，
    复用 `inv.warehouse:read` 与公司范围。
  - GraphQL `seedInvWarehouseDefaults(companyId)`：复用 create 权限；公司已有任意仓即
    幂等返回 0，否则建 `{code} - 所有仓库` 非叶根及默认仓/在途两个叶子，返回 3。
    三个种子仓自身无保护，均可按常规规则改、停、删。

### 主数据审计

四个 Resource 都挂 `SynieCore.Audit.Fragment`，直接 create/update/destroy 写
`sys_audit_log`，资源名分别为 `inv_material_category/inv_material/inv_material_unit/
inv_warehouse`；无敏感属性。update no-op 不写日志。仓库 seed 逐条走 create 并传 actor，
所以三仓各留一条正常 create 审计。物料删除导致的转换行 DB cascade、附件保留都不会伪造
逐子项 destroy 审计。

## 七个库存事实/单据资源

### GridMeta

| 资源 | 列数 | superadmin capability | read-only capability | 扩展动作 | destroy |
|---|---:|---|---|---|---|
| `invStockEntries` | 14 | `[]` | `[]` | `[]` | `null` |
| `invStockDocs` | 14 | `create/update/delete/audit/void` | `[]` | `audit` 审核、`void` 作废 | `destroyInvStockDoc` |
| `invStockDocItems` | 15 | `[]` | `[]` | `[]` | `destroyInvStockDocItem` |
| `invStockTransfers` | 17 | `create/update/delete/ship/receive` | `[]` | `ship` 发货、`receive` 收货 | `destroyInvStockTransfer` |
| `invStockTransferItems` | 16 | `[]` | `[]` | `[]` | `destroyInvStockTransferItem` |
| `invStockCounts` | 14 | `create/update/delete/approve/cancel` | `[]` | `approve` 审核、`cancel` 作废 | `destroyInvStockCount` |
| `invStockCountItems` | 15 | `[]` | `[]` | `[]` | `destroyInvStockCountItem` |

GridMeta 的 `extendedActions` 是无条件描述符，read-only 快照仍会看到头单据的动作描述；真正
授权由服务端 policy 执行，前端显隐不能成为安全边界。盘点 `refresh` 是独立 GraphQL
mutation，但没有列入 Grid row extended action；页面在盘点抽屉内调用它。

精确列顺序、类型、枚举、label、sortable/filterable 和所有 FK/poly refs 以 14 份快照为准。
核心枚举：

- 出入库方向：`IN/OUT`。
- 出入库状态：`DRAFT/AUDITED/VOIDED`。
- 调拨状态：`DRAFT/SHIPPED/RECEIVED`。
- 盘点状态：`DRAFT/AUDITED/CANCELLED`。

StockEntry 的 `voucherId` 是以 string `voucherType` 判别的多态 FK，八类：
`inv.stock_doc`、`inv.stock_transfer`、`inv.stock_count`、`sales.delivery`、
`purchase.receipt`、`purchase.outsourced_issue`、`purchase.outsourced_receipt`、
`mfg.output`。

### 库存分录与余额

来源：`stock_entry.ex`、`stock.ex`、`stock_balance.ex`、库存分录 ADR。

- StockEntry 是库存唯一事实表，只追加、不可由用户创建/更新/删除。GraphQL 只注册
  `invStockEntries` 查询；Resource 的 `create/mark_cancelled` 仅供 `Inv.Stock`
  以 `authorize?: false` 调用。
- 一行是一条叶子仓×物料数量变化，`quantity` 必须非零，恒为物料默认单位口径，表上没有
  unit。`seq` 为生成的 bigserial；来源单据用 `voucherType/voucherId/voucherNo`。
- 作废不删分录，只写 `isCancelled=true` 与 `cancelledAt`；已作废分录仍保留历史引用。
- `Stock.post!` 在调用方事务内校验：至少一行、数量非零、仓存在且同公司且为叶子、物料
  存在；仓停用不在此再拦，保存/发货侧负责“拦新”。
- 审核与作废统一负库存口径：按仓×物料汇总当前未作废余额 + 本次变化不得小于 0；
  `allowNegative=true` 的仓跳过。涉及键排序后获取 `pg_advisory_xact_lock`，串行化并发
  抢货。只校验当前总余额，不逐业务时点重放。
- `invStockBalance` 是 StockEntry 的非 CRUD action，复用 `inv.stock_entry:read`；
  参数为 `companyId` 必填及可选 `asOf/warehouseId/materialId/hideZero`。默认截至今天、
  默认隐藏零；只聚合未作废且 `postingDate <= asOf` 的分录，返回
  `warehouseId/warehouseName/materialId/materialCode/materialName/materialSpec/
  unitName/quantity`，数量编码为 decimal string。
- StockEntry 不挂 Audit Fragment：它本身是来源单据审核产生的事实，审计由来源单据承担。

### 单据行的共同系统写边界

三个行 Resource 的用户输入与系统投影必须分开：

- StockDocItem create 接受 `stockDocId,idx,materialId,unitId,qty,remark`；update 不接受
  `stockDocId`。StockTransferItem 同构，父键为 `stockTransferId`。
- StockCountItem create 接受 `countId,materialId,unitId,countedQuantity,remark`；
  update 不接受 `countId`。
- `companyId` 一律由母单复制，用户不可写；行只有在母单草稿时可增删改，构建期预检后还会
  在同事务 `FOR UPDATE` 锁母单并复检，关闭与审核/发货/刷新并发的竞态。
- 行单位必须是物料默认单位或其 MaterialUnit 转换单位。
- 出入库/调拨 `baseQty` 系统计算：默认单位时等于 qty，否则
  `qty / factor`，round 6；不可由 API 写。
- 盘点 `convertedCounted` 同口径计算；`countedQuantity` 可空但非空必须 ≥0。
  `bookQuantity` 是系统取数的未作废余额快照，不可由 API 写。
- `materialCode/materialName/materialSpec/unitName` 是行保存时重拍的物理快照，均不可由
  API 写；审核/发货后行锁死，主数据后续修改不回溯。
- StockTransferItem `receivedQty` 只允许母单 receive 调内部 `write_received` 回写。
  StockCountItem `bookQuantity` 只允许 refresh 调内部 `sync_book_quantity` 回写。
- 头单物理删除只允许草稿；行随头 DB cascade。cascade 不逐行执行 Ash destroy。

### 手工出入库单

- 编号全局唯一、最多 32；留空按启用规则自动取号，也允许手填。初始化规则按公司计数：
  `I(D)-{docDate:YYYYMMDD}-{4位序号}`。
- 公司创建后不可换；方向创建后锁死；头仓必须属于公司、启用且为叶子。
- 状态机：`DRAFT → AUDITED → VOIDED`。只有草稿可改删；审核要求至少一行。
- 审核一行派生一条 StockEntry：入库 `+baseQty`，出库 `-baseQty`，摘要写入分录 remarks。
- 只有已审核单可作废；作废分录同样过负库存校验。无反审核、无关闭态。
- GraphQL 除 CRUD 外暴露 `auditInvStockDoc`、`voidInvStockDoc`。

### 手工调拨单

- 编号全局唯一、最多 32；留空自动或手填。初始化规则：
  `I(T)-{docDate:YYYYMMDD}-{4位序号}`，按公司计数。
- 公司创建后不可换；调出、调入、在途三仓必须属于同公司、启用、叶子且两两不同。
- 状态机：`DRAFT → SHIPPED → RECEIVED`。只有草稿可改删；已发货无作废，纠错走反向调拨。
- ship 要至少一行，并在锁内复检三仓仍启用；每行写“调出仓 `-baseQty` + 在途仓
  `+baseQty`”。
- receive 只接受已发货单。`receipts` 缺省表示全部行足额收；传入时必须覆盖全部行，不得
  含非本单行，每行 `0 ≤ qty ≤ baseQty`。正实收行写“在途仓 `-qty` + 调入仓
  `+qty`”，零实收不写；差额自然留在在途。收货是一次终结动作，不分批，并回写每行
  `receivedQty`。
- “停用拦新不拦旧”：收货不复检仓 active，保证在途单能收尾。
- GraphQL 除 CRUD 外暴露 `shipInvStockTransfer`、
  `receiveInvStockTransfer(id,input:{receipts})`。

### 库存盘点单

- 编号全局唯一、最多 32；留空自动或手填。初始化规则：
  `I(C)-{postingDate:YYYYMMDD}-{4位序号}`，按公司计数。
- create 可传 `items` 随头原子建行，或 `loadAll=true` 把该仓当前非零余额物料按编号顺序
  带出；账面为零的物料可手工加。头在创建时写 `snapshotTakenAt`。
- `refreshInvStockCount` 仅草稿可用，复用 `inv.stock_count:update` 权限；重取所有既有行的
  `bookQuantity`，保留已填 `countedQuantity`，并更新快照时间。
- 状态机：`DRAFT → AUDITED → CANCELLED`。仅草稿可改删；审核要求至少一行且每行实盘数
  已填、≥0。
- 审核锁内检查：快照后同仓是否出现新分录，或既有分录是否在快照后被作废；命中即拒绝，
  要求 refresh。通过后按 `convertedCounted - bookQuantity` 写差异分录，零差异不写。
- 已审核才可 cancel；撤销盘盈可能使库存变负，因此作废仍走统一负库存校验。
- GraphQL 除 CRUD/refresh 外暴露 `approveInvStockCount`、`cancelInvStockCount`。

### 权限与公司范围

- StockEntry 只登记 `read` 权限；余额 action 复用 read，且在实现内手工检查公司范围。
- 三个头单据分别登记各自 CRUD 与状态动作权限。read/update/destroy 受 CompanyScope；
  create 用 `CompanyAccessible` 校验目标公司。
- 三个行 Resource 不进权限目录：
  - DocItem 的 read/create/update/destroy 分别复用母单同名权限。
  - TransferItem 同理复用 `inv.stock_transfer`。
  - CountItem 同理复用 `inv.stock_count`。
  create 时先从母单回填 company，再校验 CompanyAccessible；read/update/destroy 受
  CompanyScope。
- superadmin bypass 全部 policy。无权限 Actor 即使从 Meta 看见 extended action，也会被
  服务端拒绝。

### 审计

- StockDoc/Item、StockTransfer/Item、StockCount/Item 都挂通用 Audit Fragment；
  create/update/destroy 与头状态动作写审计，资源名为各自 GraphQL type 的 snake case。
- 头单 audit/void/ship/receive/refresh/approve/cancel 都是 update action，审计的
  `action_name` 保留真实动作名，不应统一伪装成 `update`。
- Transfer receive 的内部 `write_received` 与 Count refresh 的内部
  `sync_book_quantity` 会对系统投影列留下行级 update 审计；调用路径不传 actor 时 Actor
  可为空，但变化事实仍记录。
- 删除草稿头时行由数据库级联，按旧明确约定不留逐行 destroy 审计；头 destroy 审计是删除
  事件的主记录。
- StockEntry 不审计，原因见前述：其创建/作废就是来源单据动作的业务事实。

### PostgreSQL 硬约束

- 分类 code、物料 code、三类单据 doc_no 各自唯一；仓库 `(company_id,name)` 唯一；
  MaterialUnit `(material_id,unit_id)` 唯一。
- MaterialUnit 随 Material cascade；三类单据行随母单 cascade。
- `inv_material.customer_material_pair` 保证客户物料布尔与 customer_id 配对；
  `inv_warehouse.party_pair` 保证 party_type/party_id 同空同有。
- StockEntry `quantity <> 0`；DocItem/TransferItem `qty > 0`；
  CountItem 非空 `counted_quantity >= 0`。
- StockEntry 对 `(voucher_type,voucher_id)` 与
  `(company_id,warehouse_id,material_id,posting_date)` 建索引。
- 业务状态机、树叶子、公司一致性、单位可用性、快照过期与负库存不只靠外键/check，必须在
  Go Service 事务内复刻；不得因数据库没有对应 check 而遗漏。

## 前端消费面与迁移接口需求

当前旧 GraphQL 消费面（只读盘点，本文不改前端）：

- `material-categories.tsx`：分类 Grid/Drawer CRUD、active 行切换、树 `hasChildren`。
- `materials.tsx`：物料 Grid/Drawer、active、单位转换查询/diff CRUD、图纸/默认附件。
- `warehouses.tsx`：公司选择、仓库树 CRUD、active、科目/协作方候选。
- `MaterialUnitSelect.tsx`：同一请求读取 Material.defaultUnit 与 MaterialUnit.unit，供销售、
  采购、库存、生产行复用。
- `other-stock/docs.tsx` + `-stock-doc.tsx`：Doc/Item CRUD 与头动作。
- `other-stock/transfers.tsx`：Transfer/Item CRUD、三仓、在途默认查找、ship/receive。
- `other-stock/counts.tsx`：Count/Item CRUD、loadAll/refresh/approve/cancel。
- `stock-entries.tsx`：只读 Grid 与来源单据速览。
- `inventory.tsx`：`invStockBalance` 余额 action。
- 销售/采购订单抽屉、BOM、库存单据等多处以 `RemoteSelect resource="invMaterials"` 选料；
  stock doc/inventory/transfer 等多处以 `invWarehouses` 选仓。

REST DTO 至少保留这些 join，避免前端回退到逐行补查：

- Material：`category{id,name,code}`、`defaultUnit{id,name}`、可空
  `customer{id,name}`。
- MaterialUnit：`material` 与 `unit{id,name,symbol}`。
- Warehouse：company/parent/account（account 需 code+name）及 Party 多态显示。
- 三类头单据：company、仓库、created/audited/shipped/received user 引用。
- 三类行：父单引用、company、material、unit；同时返回已经冻结的 snapshot 列。
- StockEntry：company/warehouse/material 与 voucher 多态 ref。

迁移验收必须在页面会话记录 `/graphql` 请求并断言目标范围为 0；只替换三张主页面而遗漏
`MaterialUnitSelect`、在途仓显式查询、余额 action 或 RemoteSelect registry，均不算完成。

## 建议验收矩阵

除逐 JSON 对拍 22 份 Meta 外，REST/真实 PG 至少覆盖：

- 四主数据 CRUD、必填/长度/唯一、树约束、active+leaf 新权威约束、自动编号、客户物料互斥
  与引用锁、单位转换权限组合、附件 owner/category、仓库科目/外协/公司范围。
- 公司创建与三仓 seed 同事务；seed 幂等、种子无保护。
- StockEntry 用户写入口不存在，余额截至日/隐藏零/公司权限，八类 voucher ref。
- 三类行系统字段不可由请求覆盖；转换折算 round 6；快照重拍；非草稿并发编辑被锁内复检
  拒绝。
- 出入库 audit/void 正负分录与作废负库存。
- 调拨三仓两两不同、ship 两边分录、receive 缺省/全覆盖/0/部分/超收、收货不受停用阻断。
- 盘点 items/loadAll、账面零手工行、refresh 保留实盘、快照过期、零差异不落分录、
  approve/cancel。
- read-only Actor：query 可读、capability 空、畸形写 JSON 也必须权限先行返回 403；
  extended action 描述符可见不代表可执行。
- 所有夹具按 UUID/测试前缀精确清理，审计与 11 张表残留归零。

## 迁移完成验收

2026-07-26 完成全部 11 个资源并满足上述矩阵：

- 22 份 Meta 快照逐 JSON 语义对拍；永久 Go 契约测试覆盖 superadmin/read-only 输出、
  扩展动作顺序和权限感知 ref 降级。
- `Post / Cancel / Balance` 库存深模块在调用方事务内运行；真实 PostgreSQL 测试覆盖并发
  advisory lock、负库存、余额、作废以及三类单据完整状态机。
- REST 验收覆盖 22 份 Meta、10 个权限先拒绝场景、4 类主数据、2 张出入库单、
  1 张调拨单、1 张盘点单、7 条库存分录、3 组余额和 7 条审计，清理残留为 0。
- 目标前端页面、共享选择器与 Resource registry 的业务 GraphQL 为 0；OpenAPI、类型检查、
  45 个前端测试、组件检查、生产构建与 Chromium 12/12 全量回归通过。
- 空 PostgreSQL 数据库从 baseline 顺序迁移到当前版本成功；验证库随后精确删除。
- 旧后端仅作为迁移前事实来源，未编辑、未删除。
