# PR-2.17 制造主数据、履约需求、工单与生产入库迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，只冻结旧 Elixir/Ash/GraphQL 实际表面，
不新增业务规则。范围为工序、工艺模板、BOM、履约需求、生产工单与生产入库 12 个
Grid 资源。

事实来源按优先级为：

1. 旧 Resource 与 GraphQL 注册：
   `backend/apps/synie_core/lib/synie_core/mfg/`、
   `backend/apps/synie_core/lib/synie_core.ex`；
2. 真实 `SynieWeb.GridMeta.build/2` 输出：
   `.scratch/migration/snapshots/pr-2.17/*.grid.json`；
3. PostgreSQL 迁移与真实 PostgreSQL/Ecto 测试；
4. `CONTEXT.md`、生产 BOM/履约需求产品文档与对应 ADR。

旧运行时没有独立 `RecordMeta` 构建器；记录抽屉与编辑表同样消费 GridMeta。因此本批按
既有迁移约定，为每个资源冻结 `superadmin` 与固定 `read-only` Actor 两份真实 GridMeta，
共 24 份 JSON。字段顺序、类型、标签、filter/sort、enum、ref 降级、capability、
extended action 与 destroy mutation 的唯一精确真值是这 24 份 snapshot；下文只作人读摘要。

## 范围

| Grid 资源 | Elixir Resource | 表 | 外部权限 |
|---|---|---|---|
| `mfgOperations` | `SynieCore.Mfg.Operation` | `mfg_operation` | `mfg.operation:*` |
| `mfgProcessTemplates` | `SynieCore.Mfg.ProcessTemplate` | `mfg_process_template` | `mfg.route_template:*` |
| `mfgProcessTemplateItems` | `SynieCore.Mfg.ProcessTemplateItem` | `mfg_process_template_item` | 复用模板权限 |
| `mfgBoms` | `SynieCore.Mfg.Bom` | `mfg_bom` | `mfg.bom:*` |
| `mfgBomComponents` | `SynieCore.Mfg.BomComponent` | `mfg_bom_component` | 复用 BOM 权限 |
| `mfgBomRoutes` | `SynieCore.Mfg.BomRoute` | `mfg_bom_route` | 复用 BOM 权限 |
| `mfgBomByproducts` | `SynieCore.Mfg.BomByproduct` | `mfg_bom_byproduct` | 复用 BOM 权限 |
| `mfgDemands` | `SynieCore.Mfg.Demand` | `mfg_demand` | `mfg.demand:*` + 公司范围 |
| `mfgDemandItems` | `SynieCore.Mfg.DemandItem` | `mfg_demand_item` | 复用需求权限 + 公司范围 |
| `mfgWorkOrders` | `SynieCore.Mfg.WorkOrder` | `mfg_work_order` | `mfg.work_order:*` + 公司范围 |
| `mfgOutputs` | `SynieCore.Mfg.Output` | `mfg_output` | `mfg.output:*` + 公司范围 |
| `mfgOutputItems` | `SynieCore.Mfg.OutputItem` | `mfg_output_item` | 复用入库权限 + 公司范围 |

这批不能按 12 个孤立 CRUD 资源迁移。需求确认占用销售订单条目，采购/委外审核与入库
通过内部 seam 维护需求行 `orderedQty/receivedQty`；生产工单从自制需求行派生；生产入库
审核写库存分录并维护工单与需求行状态，作废须原路回滚。

## 可复现捕获与旧基线

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_manufacturing_contract.exs \
  ../.scratch/migration/snapshots/pr-2.17

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/mfg/mfg_test.exs \
  apps/synie_core/test/synie_core/mfg/fulfillment_test.exs
```

固定 read-only Actor 只持：

- `mfg.operation:read`
- `mfg.route_template:read`
- `mfg.bom:read`
- `mfg.demand:read`
- `mfg.work_order:read`
- `mfg.output:read`

因此制造资源间的引用会保留 ref，基础资料、用户、库存和销售订单条目因没有对应 read
权限而降为 string。例如 BOM 路线的 `bomId/operationId` 保持 ref，BOM 的
`materialId` 降为 string；需求行的 `demandId` 保持 ref，其公司、物料、单位、销售来源
均降为 string。该降级是旧 Meta 权限反射事实，REST/OpenAPI 不应把字段本身删掉。

2026-07-26 在真实 PostgreSQL/Ecto SQL Sandbox 上复跑两个制造套件为
**41 passed**。覆盖主数据约束、级联/限制删除、模板路线快照复制、权限、需求状态机、
销售占用及并发确认、工单生成/作废、生产入库容差、库存分录与审核/作废回滚。

GraphQL 的稳定序列化表面沿用全项目约定：

- list 是 `{count, results}`，offset pagination 默认 20、最大 200；
- mutation 是 `{result, errors {message}}`；
- UUID/ID 是 JSON string；
- Decimal 输出 string 以保精度，输入可接 string、integer 或 float；
- Date 是 `YYYY-MM-DD`，DateTime 是带 UTC `Z` 的 ISO-8601 string；
- enum 输出大写 GraphQL token；
- 可空字段输出 `null`，不可改为空字符串或数值 0。

## GridMeta 精确摘要

所有资源共同遵循：`id` 不可筛但可排；普通公开属性可筛可排；FK 可筛不可排。
无资源声明默认头排序。需求行与生产入库行在未显式 sort 时固定 `idx ASC`，显式 sort
覆盖默认。snapshot 中没有反射 argument calculation `applyQty`，因为它不在
`grid_calculations/0` 白名单。

### 工序与工艺模板

`mfgOperations` 6 列：

`id, code, name, note, insertedAt, updatedAt`

`mfgProcessTemplates` 6 列：

`id, code, name, note, insertedAt, updatedAt`

- superadmin capability 都是 `create/update/delete`；read-only 为空。
- extended action 都为空；destroy 分别为
  `destroyMfgOperation`、`destroyMfgProcessTemplate`。
- 编号必填、最多 32、全局唯一；留空分别按 `mfg.operation`、
  `mfg.route_template` 启用编号规则取号，手填原样保留，创建后不可修改。
- 名称必填、最多 64；备注可空、最多 255；两类主数据全局共享、不分公司。
- 工序被 BOM 路线或模板行任一引用后禁止删除。
- 删除工艺模板级联删除模板行；已经复制到 BOM 的路线与模板脱钩，不受影响。

`mfgProcessTemplateItems` 8 列：

`id, seq, requirement, isOutsourced, insertedAt, updatedAt, templateId, operationId`

- capability、extended action 为空；destroy 为 `destroyMfgProcessTemplateItem`。
- superadmin 与固定 read-only 的两个 FK 都是 ref，因为 Actor 可读模板与工序。
- `seq` 必填但没有正数/同模板唯一约束；`requirement` 最多 512；
  `isOutsourced` 必填、默认 false。
- create 接收 `templateId/operationId/seq/requirement/isOutsourced`；update 不可换模板。
- 行无独立权限点：read 用 `mfg.route_template:read`，create 接受
  `create` 或 `update`，update/destroy 用 `update`。

### BOM 头与三类行

`mfgBoms` 7 列：

`id, code, planName, note, insertedAt, updatedAt, materialId`

- superadmin capability 为 `create/update/delete`，read-only 为空；extended action 为空；
  destroy 为 `destroyMfgBom`。
- superadmin 的 `materialId` 是 `invMaterials` ref；固定 read-only 降为 string。
- 一物料允许多张 BOM，以独立 `code` 全局唯一；留空按 `mfg.bom` 编号规则取号；
  `code/materialId` 创建后不可改。
- `planName` 可空最多 64，`note` 可空最多 255；BOM 全局共享、不分公司。
- 删除 BOM 级联删除配料、路线、副产品三类行；物料被 BOM 引用时 DB restrict。
- `applyRouteTemplate` 是注册的独立 mutation，但**不在 GridMeta extended actions 中**。
  它复用 `mfg.bom:update`，接收必填 `templateId`，仅在 BOM 尚无路线时可执行；
  模板行按 `seq ASC` 整体事务复制为 BOM 私行，复制后与模板脱钩。

`mfgBomComponents` 9 列：

`id, quantity, lossRate, note, insertedAt, updatedAt, bomId, materialId, unitId`

`mfgBomRoutes` 8 列：

`id, seq, requirement, isOutsourced, insertedAt, updatedAt, bomId, operationId`

`mfgBomByproducts` 8 列：

`id, quantity, note, insertedAt, updatedAt, bomId, materialId, unitId`

- 三类行 capability、extended action 都为空；各有对应 destroy mutation。
- 固定 read-only 下 `bomId` 与路线 `operationId` 保持 ref；配料/副产品的
  `materialId/unitId` 降为 string。
- 三类行都不可在 update 时换 BOM；均随 BOM 级联删除。
- 行无独立权限点：read 用 `mfg.bom:read`，create 接受 `create` 或 `update`，
  update/destroy 用 `update`。
- 配料 `quantity > 0`、`lossRate >= 0`（可空即 0）；理论耗用内部 calculation 为
  `quantity × (1 + lossRate) × qty`。副产品 `quantity > 0`，代入数量为
  `quantity × qty`。
- 配料与副产品物料不能等于 BOM 母物料，单位只能取该物料默认单位或转换单位。
- 路线 `seq` 必填但没有正数/同 BOM 唯一约束；要求最多 512，外协标记默认 false。

### 履约需求头

`mfgDemands` 9 列：

`id, demandNo, demandDate, remarks, status, insertedAt, updatedAt, companyId,
createdById`

- superadmin capability 顺序为
  `create/update/delete/confirm/close/void`；read-only 为空。
- extended action 对两种 Actor 都机械存在：
  `confirm`（非危险）、`close`（非危险）、`void`（危险）。UI/REST 须再用
  capability/权限门控。
- destroy 为 `destroyMfgDemand`。
- 状态固定：
  `DRAFT/草稿`、`CONFIRMED/已确认`、`CLOSED/已关闭`、`VOIDED/已作废`。
- superadmin 的公司与录入人均为 ref；固定 read-only 均降为 string。
- 单号必填最多 32、全局唯一，留空按 `mfg.demand` 编号规则取号；日期默认当天；
  remarks 最多 512；公司必填、创建后不可换、须 CompanyAccessible；createdBy 从 Actor
  写入。
- 仅草稿可普通 update/delete，且写前 `FOR UPDATE` 锁头复查。删草稿级联删需求行。
- `confirm`：仅草稿、有至少一行才可确认；锁头复查后，对有销售来源的行按销售条目分组，
  锁销售条目并复核占用。
- `close`：仅已确认可关闭；关闭后不可生成工单或点完成。
- `void`：仅已确认可作废；草稿应删除。存在任一未作废生产工单，或存在引用本单需求行的
  已审核/已关闭采购或委外订单条目时拒绝。作废会让销售占用口径自然释放。

### 履约需求行

`mfgDemandItems` 23 列：

`id, idx, qty, baseQty, orderedQty, receivedQty, needDate, fulfillmentMethod,
status, materialCode, materialName, materialSpec, unitName, remarks, insertedAt,
updatedAt, demandId, companyId, materialId, unitId, salesOrderItemId, ordered,
remainingOrderableQty`

- capability、extended action 为空；destroy 为 `destroyMfgDemandItem`。
- superadmin 的 5 个 FK 都为 ref。固定 read-only 仅 `demandId` 保持 ref，其余降 string。
- 履约方式：
  `MAKE/自制`、`BUY/外购`、`OUTSOURCE/委外`、`STOCK/库存`。
- 行状态：
  `PENDING/待安排`、`SCHEDULED/已安排`、`COMPLETED/已完成`。
- `ordered` 与 `remainingOrderableQty` 是 Grid calculation：
  `ordered = orderedQty > 0 && status != COMPLETED`，
  `remainingOrderableQty = baseQty - orderedQty`。
- create/update/delete 都锁父头并要求父单仍为草稿；update 不可换父单。`idx` 必填但无
  正数/同父唯一约束；`qty > 0`；remarks 最多 512。
- 行从父头派生 company；单位须为物料默认单位或转换单位；服务端折算 `baseQty` 并重拍
  物料/单位文本快照。客户端不可直接写 `baseQty/orderedQty/receivedQty/status`。
- 销售来源可空。非空时来源条目须同公司，且销售订单已审核未关闭；草稿行不占量。
  需求确认时按销售条目分组，以 `FOR UPDATE` 保证
  `已确认未作废占用 + 本单 base 合计 <= 销售条目订购 base`。
- `completeMfgDemandItem` 与 `changeFulfillmentMfgDemandItem` 是已注册 mutation，
  但**都不在 GridMeta extended actions 中**，并复用 `mfg.demand:update`。
- 手工 complete 只允许已确认需求单上的 `PENDING` 非自制行，且 `orderedQty == 0`；
  自制须经生产入库完工，已下单行须等入库回写。
- 已确认后改履约方式要求行未完成，且无未作废工单、无已审核/已关闭采购或委外订单条目；
  已安排行改方式时回退待安排。
- 内部 `adjustOrderedQty` 由采购/委外订单审核加、作废减；不得减成负数。内部
  `adjustReceivedQty` 由标准/委外入库审核加、作废减；累计达到 base 自动完成，
  回滚不足则回待安排。
- `mfgSalesItemOccupancies` 是非分页 action query，接收销售订单条目 ID 数组，返回
  订购 base、已确认占用 base、剩余可占用 base；复用 `mfg.demand:read`。

### 生产工单

`mfgWorkOrders` 20 列：

`id, workOrderNo, qty, baseQty, receivedBaseQty, needDate, materialCode,
materialName, materialSpec, unitName, status, insertedAt, updatedAt, companyId,
demandId, demandItemId, materialId, unitId, createdById, remainingBaseQty`

- superadmin capability 为 `create/update/delete/void`；read-only 为空。
- extended action `void` 对两种 Actor 都机械存在且为危险；destroy 为
  `destroyMfgWorkOrder`。
- 状态：
  `IN_PROGRESS/进行中`、`COMPLETED/已完工`、`VOIDED/已作废`。
- `remainingBaseQty = baseQty - receivedBaseQty`，是公开 Grid calculation。
- superadmin 的全部 FK 为 ref。固定 read-only 的 `demandId/demandItemId` 保持 ref；
  公司、物料、单位、录入人降为 string。
- create 外部只接收可空 `workOrderNo` 与必填 argument `demandItemId`；公司、需求头、
  物料、单位、数量、交期和快照全部从需求行派生，录入人来自 Actor。单号最多 32、
  全局唯一，留空按 `mfg.work_order` 编号规则取号。
- 仅已确认需求单上的 `MAKE`、未完成且尚无未作废工单的行可生成；生成时锁需求行，
  并把需求行改为 `SCHEDULED`。数据库部分唯一索引保证一需求行至多一张未作废工单。
- 普通 update 只允许进行中且只可改 `workOrderNo`。
- 删除：已作废工单可删；进行中且无已审核生产入库可删，并把需求行回退
  `PENDING`；已完工或有已审核入库时拒绝。
- void：仅进行中且无已审核生产入库可作废，并把需求行回退 `PENDING`。
- 生产入库内部 `adjustReceived` 加减 `receivedBaseQty`：累计达到工单 base 时工单
  `COMPLETED`、需求行 `COMPLETED`；作废回滚不足时工单回 `IN_PROGRESS`、需求行回
  `SCHEDULED`。数量不得减为负数。

### 生产入库头与行

`mfgOutputs` 12 列：

`id, outputNo, outputDate, remarks, status, auditedAt, insertedAt, updatedAt,
companyId, warehouseId, createdById, auditedById`

- superadmin capability 为 `create/update/delete/audit/void`；read-only 为空。
- extended action 对两种 Actor 都机械存在：
  `audit`（非危险）、`void`（危险）；destroy 为 `destroyMfgOutput`。
- 状态：`DRAFT/草稿`、`AUDITED/已审核`、`VOIDED/已作废`；没有反审核。
- superadmin 的 4 个 FK 都是 ref；固定 read-only 全降 string。
- 单号必填最多 32、全局唯一，留空按 `mfg.output` 编号规则取号；日期默认当天；
  remarks 最多 512；公司创建后不可换且须 CompanyAccessible。
- 头默认仓可空，仅用作新建行预填；非空时须为本公司启用叶子仓。createdBy 从 Actor
  写入，审核时写 auditedAt/auditedBy。
- 仅草稿可普通 update/delete，写前锁头复查；删草稿级联删入库行。
- audit：仅草稿、有至少一行；锁头后逐行复查仓与工单，按工单分组锁定并复核超入容差；
  写正向库存分录，再按工单汇总增加已入量。设置比例为 `r` 时：
  `累计已入 + 本单 base 合计 <= 工单 base × (1 + r)`。
- void：仅已审核；取消 `mfg.output` 库存分录，再按工单汇总扣回已入量并回滚工单/需求行
  状态。两动作在同一事务内，无 GL 分录。

`mfgOutputItems` 17 列：

`id, idx, qty, baseQty, materialCode, materialName, materialSpec, unitName,
remarks, insertedAt, updatedAt, outputId, companyId, workOrderId, materialId,
unitId, warehouseId`

- capability、extended action 为空；destroy 为 `destroyMfgOutputItem`。
- superadmin 的 6 个 FK 都为 ref。固定 read-only 的 `outputId/workOrderId` 保持 ref，
  公司、物料、单位、仓库降为 string。
- create/update/delete 都锁父头并要求仍为草稿；update 不可换父单。`idx` 必填但无
  正数/同父唯一约束；`qty > 0`；remarks 最多 512。
- 工单必填、须同公司且未作废；物料强制取工单物料，忽略外部 material 输入。单位须为
  该物料默认单位或转换单位；仓须为本公司启用叶子仓；服务端折算 baseQty 并重拍快照。

## GraphQL CRUD/动作表面

12 个 list query 与 Grid 资源同名。标准 mutations：

- 工序、工艺模板、模板行、BOM、三类 BOM 行：各自
  `create/update/destroyMfg...`；
- 履约需求头/行、工单、生产入库头/行：各自 `create/update/destroyMfg...`。

专用 mutations：

- `applyMfgBomRouteTemplate`
- `confirmMfgDemand`
- `closeMfgDemand`
- `voidMfgDemand`
- `completeMfgDemandItem`
- `changeFulfillmentMfgDemandItem`
- `voidMfgWorkOrder`
- `auditMfgOutput`
- `voidMfgOutput`

专用 query action：

- `mfgSalesItemOccupancies`

子表页面的旧保存语义是“先保存头，再逐行顺序调用独立 mutation”：先删除移除行，再
新增/更新；某行失败会汇总行错误，但已经成功的头或其他行不会回滚。模板带入路线、
需求确认、工单生成及生产入库审核/作废自身是服务端事务动作，不能拆成客户端对内部
投影列的普通 update。

## 权限、公司范围与删除矩阵

| 资源 | 读 | create | update / 专用动作 | destroy |
|---|---|---|---|---|
| 工序 | `mfg.operation:read` | `:create` | `:update` | `:delete`，被引用拒绝 |
| 工艺模板 | `mfg.route_template:read` | `:create` | `:update` | `:delete`，级联模板行 |
| 工艺模板行 | 主表 `:read` | 主表 `:create` 或 `:update` | 主表 `:update` | 主表 `:update` |
| BOM | `mfg.bom:read` | `:create` | `:update`；带入模板亦复用 | `:delete`，级联三类行 |
| 三类 BOM 行 | 主表 `:read` | 主表 `:create` 或 `:update` | 主表 `:update` | 主表 `:update` |
| 需求头 | `mfg.demand:read` + 公司范围 | `:create` + CompanyAccessible | `:update/confirm/close/void` + 公司范围 | `:delete` + 公司范围，仅草稿 |
| 需求行 | 主表 `:read` + 公司范围 | 主表通用策略 + CompanyAccessible | 主表 `:update` + 公司范围 | 主表通用策略 + 公司范围，仅父草稿 |
| 工单 | `mfg.work_order:read` + 公司范围 | `:create` + CompanyAccessible | `:update/void` + 公司范围 | `:delete` + 公司范围及入库闸 |
| 入库头 | `mfg.output:read` + 公司范围 | `:create` + CompanyAccessible | `:update/audit/void` + 公司范围 | `:delete` + 公司范围，仅草稿 |
| 入库行 | 主表 `:read` + 公司范围 | 主表通用策略 + CompanyAccessible | 主表通用策略 + 公司范围 | 主表通用策略 + 公司范围，仅父草稿 |

GraphQL mutations 的存在不等于 Actor 有能力。特别是行资源 `permission_actions/0` 为空，
所以 Meta capability 为空，但 mutation 仍存在并由 Ash policy 复用父权限。extended
actions 也是资源级静态描述，不按 Actor 裁剪；REST 必须同时做 endpoint 权限校验，
前端必须以 capability/显式权限配置门控。

## 迁移验收必须保留的并发与事务边界

- 需求头 update/delete/confirm/close/void 与需求行 CRUD 都锁需求头复查状态。
- 同一销售订单条目的多张草稿允许共存；确认才占量。并发确认必须锁销售条目，使超占时
  最多一方成功，不能把候选页面剩余量当权威。
- 工单生成锁需求行，数据库部分唯一索引兜底“一需求行一张未作废工单”。
- 生产入库审核锁入库头，并按工单分组锁工单后复核容差；同单多个行挂同一工单必须先
  求和，不能逐行读取相同旧余额。
- 库存过账、工单累计、需求行状态与入库头状态必须同事务提交；作废按相反方向完整回滚。
- 普通客户端不能写 `status/baseQty/orderedQty/receivedQty/receivedBaseQty` 等服务端
  投影，也不能绕过专用动作直接制造状态跃迁。

## 已知契约歧义与迁移取舍

1. 旧 GridMeta 只暴露静态 `extendedActions`。因此 BOM 带入模板、需求行完成/改履约方式
   虽有 GraphQL mutation，却不出现在 Meta；Go REST/OpenAPI 必须保留这些专用端点，
   Web 继续显式配置按钮，而不是以 Meta 缺失判定功能不存在。
2. 行资源 capability 为空不是“只读”：它们有 CRUD mutation，写权限复用父资源。
3. BOM 配料/副产品的 `applyQty` 是带 argument 的内部/public calculation，但没有进入
   GridMeta；它服务委外订单 BOM 代入，不是普通 Grid 列。
4. 工单普通 update 接受 `workOrderNo`，与工序/BOM/模板“编号创建后不可改”不同；
   迁移不可顺手统一成不可改。
5. 生产入库头仓可空而行仓必填；头仓只是新建行预填，不是审核时覆盖全部行的权威仓。
6. `idx/seq` 都没有正数或同父唯一约束。前端通常生成顺序值，但 REST 不得擅自收窄旧
   合法输入。

## 证据索引

- Meta：`.scratch/migration/snapshots/pr-2.17/*.grid.json`
- 捕获：`.scratch/migration/capture_manufacturing_contract.exs`
- Resources：`backend/apps/synie_core/lib/synie_core/mfg/{operation,process_template,
  process_template_item,bom,bom_component,bom_route,bom_byproduct,demand,demand_item,
  work_order,output,output_item}.ex`
- 注册：`backend/apps/synie_core/lib/synie_core.ex`
- 数据库：
  `20260722134257_add_mfg.exs`、
  `20260724094233_add_mfg_fulfillment.exs`、
  `20260724141125_bom_multi_per_material.exs`、
  `20260725110000_demand_purchase_linkage.exs`
- 真实旧测试：
  `backend/apps/synie_core/test/synie_core/mfg/mfg_test.exs`、
  `backend/apps/synie_core/test/synie_core/mfg/fulfillment_test.exs`
