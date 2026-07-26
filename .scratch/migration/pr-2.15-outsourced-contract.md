# PR-2.15 委外发料/委外入库迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，只冻结迁移前事实，不新增业务规则。
事实来源为旧 Elixir/Ash Resource、真实 `GridMeta.build/2` 输出、PostgreSQL 基线、
旧真实库测试、产品文档、ADR 与根 `CONTEXT.md`。

## 范围

| Grid 资源 | Elixir Resource | 表 | 权限前缀 |
|---|---|---|---|
| `purOutsourcedIssues` | `SynieCore.Purchase.OutsourcedIssue` | `pur_outsourced_issue` | `purchase.outsourced_issue` |
| `purOutsourcedIssueItems` | `SynieCore.Purchase.OutsourcedIssueItem` | `pur_outsourced_issue_item` | 复用 `purchase.outsourced_issue` |
| `purOutsourcedReceipts` | `SynieCore.Purchase.OutsourcedReceipt` | `pur_outsourced_receipt` | `purchase.outsourced_receipt` |
| `purOutsourcedReceiptItems` | `SynieCore.Purchase.OutsourcedReceiptItem` | `pur_outsourced_receipt_item` | 复用 `purchase.outsourced_receipt` |
| `purOutsourcedReceiptItemMaterials` | `SynieCore.Purchase.OutsourcedReceiptItemMaterial` | `pur_outsourced_receipt_item_material` | 复用 `purchase.outsourced_receipt` |
| `purOutsourcedReceiptItemByproducts` | `SynieCore.Purchase.OutsourcedReceiptItemByproduct` | `pur_outsourced_receipt_item_byproduct` | 复用 `purchase.outsourced_receipt` |

本批还必须承接页面实际依赖的聚合保存、头动作与候选读取：

- 发料单头及发料行 diff 保存、审核核对、作废；
- 入库单头、成品行、材料扣减行、副产物行的分层 diff 保存、审核核对、作废；
- 委外发料的发料清单行候选；
- 委外入库的订单行候选，以及材料/副产物清单行候选；
- 本公司普通叶子仓、当前对手外协仓候选；
- 入库行进入采购对账候选所需的只读字段。

订单、发料清单、副产物清单、仓库、库存分录、总账、需求和采购对账属于已迁移或后续
上下文；本批不能复制这些聚合的通用 CRUD，只通过受控查询和事务内投影 seam 协作。

## 冻结资产与复现

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_fulfillment_outsourced_contract.exs \
  ../.scratch/migration/snapshots/pr-2.15

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/purchase/outsourced_issue_test.exs \
  apps/synie_core/test/synie_core/purchase/outsourced_receipt_test.exs \
  apps/synie_core/test/synie_core/purchase/order_outsourced_test.exs
```

捕获脚本为 6 个资源各生成 `superadmin` 与 `read-only` 两份 JSON，共 12 份；read-only
Actor 只持 `purchase.outsourced_issue:read` 与
`purchase.outsourced_receipt:read`。上述测试直接使用真实 PostgreSQL，复跑结果为
**64 passed**。

字段顺序、类型、枚举、ref 降级、capability、extended action 与 destroy mutation 的
唯一真值是 `.scratch/migration/snapshots/pr-2.15/purOutsourced*.grid.json`。
关键机械事实：

- 发料头 15 列、发料行 24 列；入库头 18 列、成品行 35 列、材料扣减行与副产物行
  各 19 列。
- 两个头的 superadmin capability 都是
  `create/update/delete/audit/void`，extended action 都是 `audit/void`；
  无 `close/print/export/batch_print`。
- read-only 的头 capability 为空，但快照仍机械带出 `audit/void` extended action；
  客户端必须以 capability/权限门控，不能因 action 元数据存在就显示可执行态。
- 五个子资源的 capability 和 extended action 均为空，但 HTTP CRUD 分别复用父权限；
  destroy mutation 仍分别是
  `destroyPurOutsourcedIssueItem`、`destroyPurOutsourcedReceiptItem`、
  `destroyPurOutsourcedReceiptItemMaterial`、
  `destroyPurOutsourcedReceiptItemByproduct`。
- read-only 只保留同权限上下文内向父资源的 ref：
  发料行 `issueId`、成品行 `receiptId`、两子行 `receiptItemId`。
  公司、物料、单位、仓库、订单/清单行、用户、科目和 Party ref 都降为普通 string。
- `partyType` 的 Meta 机械显示四类 PartyType；写入口只允许 `SUPPLIER/COMPANY`。
  superadmin 的 `partyId` poly-ref 也只含供应商与内部公司。
- 两侧状态都只有 `DRAFT/AUDITED/VOIDED`，没有关闭态。

## 共用头与生命周期

- 发料单号、入库单号分别最多 32、各表全局唯一。留空按
  `purchase.outsourced_issue` / `purchase.outsourced_receipt` 的独立启用编号规则取号；
  手填原样保留，无启用规则时拒绝。
- 业务日期默认当天：发料用 `issueDate`，入库用 `receiptDate`。它们分别是库存分录业务日。
- 公司创建后不可改；创建人来自 Actor。审核成功才填审核人、审核时间。
- 对手类型和 ID 必填且同时存在，只允许供应商/内部公司，内部公司不能是单据公司本身。
- 备注可空、最多 512，并带入库存分录 remarks。
- 头上的普通仓/外协仓都是可空默认值，只给新建行或比例带出行预填。修改头默认仓不回写
  已有行；审核只认行仓。
- 有任一行后，公司/对手类型/对手 ID 冻结，须先删除所有主行才能修改；
  单号、日期、默认仓、备注，以及入库头科目不受此“有行冻结”影响，但仍仅草稿可改。
- 两个头状态机相同：
  `DRAFT → AUDITED → VOIDED`。仅草稿可改、删、编辑所有子资源和审核；
  仅已审核可作废；作废不可逆；无反审核、红冲、关闭。
- 审核至少一条主行。审核、作废、头 update/delete 与所有层级子行增删改都须在事务内
  `FOR UPDATE` 锁最上层头，锁内重查状态；构建期普通读取只能用于友好报错。
- 头删除由数据库级联主行，委外入库主行再级联材料/副产物子行；来源订单行和清单行引用
  都是 `ON DELETE NO ACTION`，已有履约引用会阻止上游删除。

## 委外发料单

### 发料头与行

- 发料是我方材料在两个仓之间移动，所有权不变：无币种、金额、科目和总账。
- 单头可跨多张委外订单取行；全部来源订单只要求公司、对手一致，不要求同币种。
- 头 `fromWarehouseId` 可空，有值时须为本公司启用叶子仓；头
  `outsourcedWarehouseId` 可空，有值时须为本公司、绑定当前对手的外协仓。
- 发料行必挂 `orderItemMaterialId`，它是委外订单条目“发料清单行”的唯一来源。
  来源订单必须 `isOutsourced=true`、仍为 `AUDITED`，且公司/对手与发料头一致；
  `CLOSED/VOIDED/DRAFT` 都拒绝。
- `materialId/unitId` 以发料清单行强制派生，忽略客户端试图替换的值；同时拍
  `materialCode/materialName/materialSpec/unitName/orderNo`。
- `qty > 0`；单位来自清单行，本身应是该材料默认单位或转换单位。
  `baseQty` 为材料默认单位口径：默认单位直接取 qty，否则
  `round(qty ÷ factor, 6)`。
- 行 `fromWarehouseId` 必填，为本公司启用叶子仓；行
  `outsourcedWarehouseId` 必填，为绑定当前头对手的外协仓；两仓不能相同。
- `idx` 只要求整数，默认读取按 idx 升序；行备注可空、最多 512。
- 行 create 从父头派生 company；update 不可换父头。行任一 create/update 都重新拍字段
  快照；审核后字段快照冻结。

### 发料审核与作废

审核持有发料头锁，并逐组锁来源发料清单行及采购订单，重新验证订单仍已审核且公司/对手
一致。成功时在同一事务内：

1. 每条发料行写两条库存分录：
   `fromWarehouse -= baseQty`、`outsourcedWarehouse += baseQty`；
2. 分录组来源固定为 `purchase.outsourced_issue`，业务日为 `issueDate`；
3. 按 `orderItemMaterialId` 分组汇总 baseQty，锁发料清单行并累加 `issuedQty`；
4. 头改为已审核并写审核人/时间、通用审计日志。

发料**没有超发硬闸**：可使 `issuedQty > quantity`，剩余可发可为负。库存引擎仍执行
负库存校验，所以调出仓余额不足会使整笔审核回滚。

作废锁头并：

1. 取消整组库存分录；
2. 按来源发料清单行扣回 `issuedQty`；
3. 头改为已作废并写审计。

作废不是无条件成功：取消原移动会减少外协仓库存，若材料已被后续消耗而导致外协仓负库存，
作废必须失败，库存、投影和状态都保持原样。

## 委外入库单

### 入库头与财务槽

- 入库头除公司、对手、日期、默认仓、备注外，还有 `postingDate`、借方科目和贷方科目。
- `warehouseId` 是成品/副产物行默认入仓，可空但有值须为本公司启用叶子仓。
  `outsourcedWarehouseId` 是材料扣减行默认外协仓，可空但有值须绑定当前对手。
- 借贷科目在**草稿保存时即必填**。create 对客户端没显式给出的槽位按公司默认入库借/
  贷科目分别代入；手填优先。借方可选该公司可用科目，贷方必须是该公司
  `UNBILLED_PAYABLE`（未开票应付）角色科目。
- `postingDate` 可空保存；审核会按“动作输入 → 头已有值 → receiptDate”取默认。
  有金额过账时最终必须非空。

### 成品行与订单快照

- 成品行必挂 `orderItemId`。来源订单必须为已审核委外订单，且公司、对手与入库头一致；
  已关闭/已作废/草稿或普通采购订单都拒绝。
- 一张入库单可跨多张订单，但这些订单的**原币代码必须一致**。订单汇率无须相同，因为金额
  使用各订单行已冻结的本币快照。
- `materialId` 强制等于来源订单行物料；`unitId` 可空，空时取订单行单位，也可改成该物料
  默认/转换单位；`qty > 0`，`baseQty` 按默认单位口径折算 6 位。
- 行仓必填且为本公司启用叶子仓；头默认入仓只在建行时预填。
- 每次 create/update 重拍物料字段：
  `materialCode/materialName/materialSpec/customerPartNo/unitName`；
  并重拍订单字段：
  `orderNo/orderQty/orderBaseQty/orderUnitName/orderPrice/orderAmount/`
  `orderBasePrice/orderBaseAmount/orderTaxRate/orderCurrencyCode`。
- `reconciledQty` 是默认单位口径的只读受控投影，初始 0；采购对账生效加、回退减，
  不得低于 0。`remainingReconcilableQty = baseQty - reconciledQty`。
- create 从父头派生 company；update 不可换 `receiptId`。默认读取按 idx 升序。

### 材料扣减行与副产物行

新建成品行成功后，按
`ratio = 成品行 baseQty ÷ 订单行 orderBaseQty` 一次性带出：

- 发料清单行 → 材料扣减行，`qty = round(清单 quantity × ratio, 6)`；
- 副产物清单行 → 副产物行，`qty = round(清单 quantity × ratio, 6)`；
- 折算结果 `<= 0` 的来源行不带出；
- 材料扣减行预填头默认外协仓，副产物行预填头默认入仓；头未填时允许空着保存草稿；
- 带出后是独立快照，改成品行数量、改上游清单都不自动重算；可自由增删改。

材料扣减行：

- 必挂父成品行同一 `orderItemId` 下的 `orderItemMaterialId`；
- 材料/单位强制取发料清单行，拍四字段物料快照、单位名和订单号；
- `qty > 0`，`baseQty` 折默认单位 6 位；
- `outsourcedWarehouseId` 草稿可空，有值时须绑定入库头当前对手，审核时必填；
- 审核写该外协仓负向库存分录，不产生独立金额或 GL。

副产物行：

- 必挂父成品行同一 `orderItemId` 下的 `orderItemByproductId`；
- 物料/单位强制取副产物清单行，拍四字段物料快照、单位名和订单号；
- `qty > 0`，`baseQty` 折默认单位 6 位；
- `warehouseId` 草稿可空，有值时须为本公司启用叶子仓，审核时必填；
- 审核写该仓正向库存分录，无金额、无 GL。

两个子资源都从父成品行和最上层入库头派生 company；update 不可换父成品行；所有增删改都
锁最上层入库头，而不是只锁直接父行。

### 入库审核

审核持有入库头锁，并在锁内载入成品行、材料扣减行、副产物行，依次完成：

1. 至少一条成品行；
2. 逐行复检成品入仓、材料外协仓、副产物入仓；
3. 按订单行分组，`FOR UPDATE` 锁订单行和订单，复检仍为已审核委外订单；
4. 超收校验：
   `当前 receivedQty + 本单该订单行 ΣbaseQty <=
   orderBaseQty × (1 + receiptOverreceiveRatio)`；
5. 计算本币过账金额；
6. 同一个库存分录组写成品正、材料负、副产物正；
7. 金额大于零时写两条 GL；
8. 累加订单行 `receivedQty`，并沿订单行可空的 `demandLineId` 累加需求行
   `receivedQty`；需求行达到需求量时沿既有内部动作自动完成；
9. 头改为已审核并写审核人/时间和审计。

库存分录来源固定为 `purchase.outsourced_receipt`，业务日为 `receiptDate`。三类数量
分录必须用一次 `Stock.post!` 等价的原子命令同生同灭；例如外协仓材料不足时，成品和
副产物不能留下半截入库。

本币过账金额逐成品行按订单快照比例计算后汇总、最终 2 位舍入：

```text
lineGL = orderBaseAmount × receiptBaseQty ÷ orderBaseQty
glAmount = round(sum(lineGL), 2)
```

- `glAmount > 0`：借方记 glAmount，不带对手；贷方记 glAmount，带头 Party；
  voucher 类型同为 `purchase.outsourced_receipt`，GL 日期用 `postingDate`。
- `glAmount <= 0`：跳过 GL，但草稿头借贷科目仍须已填。
- 材料扣减和副产物没有金额，不进入上述 GL。

### 入库作废与下游阻挡

- 任一成品行 `reconciledQty > 0` 时整单不可作废；必须先撤回/作废相关采购对账单。
  该条件须在入库头锁内再次权威复检，不能只用事务外预查。
- 作废取消整组库存分录、取消该单 GL、按订单行扣回 `receivedQty`，并沿订单行扣回需求行
  `receivedQty`；头改为已作废，所有副作用与状态同事务。
- 作废照常过负库存校验。成品或副产物已被后续消耗时，取消正向分录可能导致负库存，
  作废必须整体失败。
- 订单存在草稿委外入库引用时不能作废订单，须先删草稿入库；存在已审核未作废委外入库时
  也不能作废订单，须先作废委外入库。

## 快照与附件的精确边界

这六个旧 Resource 的实际实现只有列快照，没有图纸或通用附件复制：

- 发料行、材料扣减行、副产物行使用 `StockItemSnapshot`，冻结
  `materialCode/materialName/materialSpec/unitName`；
- 委外入库成品行使用 `SnapshotMaterial`，多冻结 `customerPartNo`；
- 成品行另冻结完整订单价税数量快照；其他行冻结 `orderNo`；
- 六个 Resource 都没有 `SyncDrawings`、附件挂接 create/destroy hook，也没有对应页面
  附件面板；删除时无需清理这些资源名下的 drawing 挂接。

普通采购入库行会复制物料 drawing，但**不能把该语义推定到委外入库**。迁移应保持当前
事实；若产品希望委外履约也携带图纸，须另立业务变更和宿主白名单，不能夹带在本次迁移。

## 候选读取与保存权威校验

候选过滤是页面体验，不代替事务内保存/审核复检：

| 消费者 | 候选资源 | 迁移前固定筛选 |
|---|---|---|
| 委外发料行 | `purOrderItemMaterials` | `orderStatus=AUDITED`、`orderIsOutsourced=true`、公司/对手与头一致、`remainingIssueQty > 0` |
| 委外入库成品行 | `purOrderItems` | `orderStatus=AUDITED`、`orderIsOutsourced=true`、公司/对手与头一致、`remainingBaseQty > 0` |
| 材料扣减行 | `purOrderItemMaterials` | `orderItemId = 当前父成品行.orderItemId` |
| 副产物行 | `purOrderItemByproducts` | `orderItemId = 当前父成品行.orderItemId` |
| 调出仓/成品仓/副产物仓 | `invWarehouses` | 当前公司、启用、叶子；`WarehouseUsable` 不额外排除外协仓 |
| 外协仓 | `invWarehouses` | 当前公司、`isOutsourced=true`、协作方类型/ID 等于单头对手 |

两个容易误收紧的事实：

- 发料候选隐藏剩余量 `<= 0` 的清单行，但服务端明确允许超发；写入/审核不能把
  `remainingIssueQty > 0` 升格为硬校验。
- 委外入库不要求此前已有委外发料记录。只要订单、仓、库存、超收等条件满足即可入库；
  外协仓材料不足会由库存负数校验自然拦截。

HTTP 需要支持上述资源的结构化 enum/bool/fk/poly-fk/number 过滤。迁移前页面实际是
“先保存头、再逐行调用独立 GraphQL mutation”：某行失败时会明确提示“单据已创建/更新，
但部分行保存失败”，已经成功的头/行不会回滚。这是需要记录的兼容事实，不应误写成旧系统
已有聚合原子提交。

六资源独立 CRUD 必须保留这种可恢复表面。若 Go/REST 同时提供聚合保存 endpoint（推荐用于
“保存并审核”和降低半成品草稿），则顺序为：

1. 创建/更新头；
2. diff 成品或发料主行；
3. 委外入库在主行 ID 已落库后 diff 材料/副产物子行；
4. 聚合 endpoint 内任一层失败回滚整个请求；不要把它伪装成旧 GraphQL 已有的保证。

审核与作废必须是头级专用 action endpoint；库存、GL、订单投影、需求投影不开放独立
HTTP 修改入口。对账模块只通过内部 `adjustReconciledQty` seam 修改成品行投影。

## 权限、公司范围、审计与锁序

- superadmin bypass。普通 Actor 的头动作使用：
  - `purchase.outsourced_issue:{create,read,update,delete,audit,void}`；
  - `purchase.outsourced_receipt:{create,read,update,delete,audit,void}`。
- 子资源不独立入权限目录；read/create/update/destroy 分别复用父前缀的
  read/create/update/delete。
- 所有头 read/update/delete/audit/void 叠加 CompanyScope fail-closed；create 校验输入
  公司。子资源 create 先从父聚合派生 company 再校验；read/update/delete 使用自身冗余
  company 做范围过滤。
- 权限拒绝应先于请求体业务解码和记录存在性泄漏；越公司 single 按 not-found，list 只返回
  授权公司，空公司 scope 返回空集。
- 六资源都挂通用 Audit Fragment。外部 CRUD 和头 audit/void 记录字段级审计；
  DB 级联删除子行不伪造逐行 destroy 审计。
- 建议固定锁序，且同一类多 ID 排序后锁：
  - 发料：发料头 → 来源发料清单行 → 采购订单头 → 库存 `(warehouse,material)` →
    issued 投影行；
  - 入库：入库头 → 采购订单行/头 → 库存 `(warehouse,material)` → GL →
    订单 received 投影 → 需求行；
  - 作废沿同样相对顺序，避免审核/作废/子行编辑与跨单竞争形成反向锁。
- 同一头并发审核必须恰好一次成功；审核与任一层子行编辑串行；两张入库单竞争同一订单行
  剩余容差时，后审核者必须在订单行锁内看到新 `receivedQty`。
- 发料/入库审核的库存、GL、投影、头状态与审计必须同事务提交；任何错误均不得留下重复
  分录、重复投影或半截状态。

## Go 模块 seam

发料与入库共享父锁、仓校验、单位折算、快照、库存命令和状态机，但副作用明显不同。
适合由一个委外履约深模块持有两类聚合，公开面只保留：

- 六资源的受控 list/get/CRUD；
- 两个头的 `Audit` / `Void`；
- 聚合详情和候选查询；
- 供采购对账调用的事务内 reconciled 投影接口。

库存与 GL 的分录生成仍由各自领域引擎拥有；订单模块拥有 issued/received/demand 投影，
委外履约模块只在同一个数据库事务里调用明确的 post/reverse seam。动态表名不得来自请求；
所有值参数化。

## PR-2.15 实现门槛

- 12 份 `purOutsourced*.grid.json` 逐 JSON 语义对拍，钉住列顺序、枚举、ref 降级、
  capability、extended action 与 destroy mutation。
- 六资源完成 sqlc/Go/OpenAPI/ResourceClient；两类头与四类行 CRUD、audit/void、
  聚合 diff、全部候选读取接通。
- 真实 PostgreSQL 至少覆盖：
  - 两侧编号、默认日期、Party、头字段冻结、父锁、公司范围与审计；
  - 发料行强制来源、单位折算、快照、两仓校验、库存移动、超发、issued 加减；
  - 入库订单快照、同单同币、比例带出、手改脱钩、三类库存分录同生同灭；
  - 入库本币 GL 公式、零金额跳 GL、科目角色、默认科目；
  - 超收容差、received 与需求 received 加减、对账投影作废阻挡；
  - 审核/作废的负库存失败与全部回滚；
  - “无图纸/附件复制”当前语义不被误加。
- 并发真实 PG 至少覆盖：
  同单审核恰好一次成功；审核与主/子行编辑串行；两入库竞争同一订单余量；
  作废与对账投影变更串行；库存/GL/投影不重复。
- 真实 REST 覆盖权限先行、single/multi/all/empty company scope、结构化候选过滤、
  六资源 Meta、两个头动作、三层入库 diff 回滚。
- 固定 Go 容器、OpenAPI、前端 typecheck/test/build 与 Chromium 委外发料/入库主流程通过；
  删除旧实现前旧真实库 64-test 基线仍通过。
