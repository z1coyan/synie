# PR-2.15 标准收发履约迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，只冻结旧栈实际行为，不新增业务规则。
事实来源为旧 Elixir/Ash Resource、真实 `GridMeta.build/2` 输出、PostgreSQL 迁移、
真实 PostgreSQL 测试、产品文档、ADR、根 `CONTEXT.md`，以及现有页面的订单候选与
默认科目读取。本文只覆盖标准销售发货、标准采购入库四个 Grid 资源；委外发料/入库由
PR-2.15 的另一份契约独立冻结。

## 范围

| Grid 资源 | Elixir Resource | 表 | 权限前缀 |
|---|---|---|---|
| `salDeliveries` | `SynieCore.Sales.Delivery` | `sal_delivery` | `sales.delivery` |
| `salDeliveryItems` | `SynieCore.Sales.DeliveryItem` | `sal_delivery_item` | 复用 `sales.delivery` |
| `purReceipts` | `SynieCore.Purchase.Receipt` | `pur_receipt` | `purchase.receipt` |
| `purReceiptItems` | `SynieCore.Purchase.ReceiptItem` | `pur_receipt_item` | 复用 `purchase.receipt` |

四资源不能作为孤立 CRUD 迁移。审核/作废事务会同时调用：

- 库存分录组及负库存校验；
- 总账分录组及未开票应收/应付科目；
- 销售订单行 `shippedQty`、采购订单行 `receivedQty` 投影；
- 采购订单行所挂履约需求行的 `receivedQty/completed` 投影；
- 销售/采购对账对履约行 `reconciledQty` 的受控投影；
- 文件附件挂接与删除守卫；
- 公司默认过账科目读取；
- 销售/采购订单条目候选查询。

这些是标准履约模块的依赖或内部 seam，不额外计为本契约的 Grid 资源。尤其
`salCompanyAccountDefaults` 仍是独立待迁资源；本批不得把它悄悄算作第五个资源，但页面
切 REST 时必须有已迁读取或明确的同批依赖，不能为默认科目继续回退 GraphQL。

## 可复现捕获与旧基线

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_fulfillment_standard_contract.exs \
  ../.scratch/migration/snapshots/pr-2.15

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/sales/delivery_test.exs \
  apps/synie_core/test/synie_core/purchase/receipt_test.exs \
  apps/synie_core/test/synie_core/sales/company_account_default_test.exs \
  apps/synie_core/test/synie_core/purchase/demand_linkage_test.exs
```

捕获脚本为四资源各生成 `superadmin`、`read-only` 两份 JSON，共 8 份；read-only Actor
只持 `sales.delivery:read` 与 `purchase.receipt:read`。Meta 捕获只反射 Resource，
不创建业务数据。

2026-07-26 在真实 PostgreSQL/Ecto SQL Sandbox 上复跑结果为 **49 passed**：
销售发货 11、采购入库 21、公司默认科目 6、采购需求串联 11；只有
`demand_linkage_test.exs` 两条既有“私有函数默认参数未使用”warning。旧测试直接覆盖库存/
GL/订单投影、容差、零金额、科目角色、采购作废负库存、需求已收回写、对账作废闸、
图纸挂接与清理等；旧套件没有双事务并发压力用例，因此并发结论还须结合 Resource 的
`FOR UPDATE` 实现读取，并列为 Go 真实 PG 必测项，不能声称已由这 49 条压力验证。

字段顺序、类型、标签、filter/sort、枚举、ref 降级、capability、extended action 与
destroy mutation 的唯一精确真值是
`.scratch/migration/snapshots/pr-2.15/{salDeliveries,salDeliveryItems,purReceipts,purReceiptItems}.*.grid.json`。
Go Meta 必须逐 JSON 语义对拍。

## 8 份 GridMeta 摘要

### 单头：两侧各 17 列

销售顺序固定：

`id, deliveryNo, deliveryDate, postingDate, partyType, partyId, remarks, status,
auditedAt, insertedAt, updatedAt, companyId, warehouseId, debitAccountId,
creditAccountId, createdById, auditedById`

采购顺序固定：

`id, receiptNo, receiptDate, postingDate, partyType, partyId, remarks, status,
auditedAt, insertedAt, updatedAt, companyId, warehouseId, debitAccountId,
creditAccountId, createdById, auditedById`

- `salDeliveries` superadmin capability 顺序为
  `create/update/delete/audit/void/print/export/batch_print`；`purReceipts` 只有
  `create/update/delete/audit/void`。采购入库没有打印、导出、批量打印能力。
- read-only 的 capability 都为空，但两侧 Meta 仍机械带出 `audit`、`void` 两个
  extended action。UI/REST 必须以 capability/权限决定可执行性，不能把 action 描述本身
  当授权。
- extended action 顺序为 `audit`（非危险）后 `void`（危险），mutation 分别为
  `auditSalDelivery/voidSalDelivery` 与 `auditPurReceipt/voidPurReceipt`。
- destroy mutation 分别为 `destroySalDelivery`、`destroyPurReceipt`。
- 状态枚举固定为 `DRAFT/草稿`、`AUDITED/已审核`、`VOIDED/已作废`。
- `partyType` 仍机械反射 PartyType 四值
  `SUPPLIER/CUSTOMER/COMPANY/EMPLOYEE`；写入口须收窄，销售只许
  `CUSTOMER/COMPANY`，采购只许 `SUPPLIER/COMPANY`。
- superadmin 的 ref 包括对手 poly ref、company、warehouse、debit/credit account、
  created/audited user；read-only 因无这些资源的 read 权限，全部降为 string。

### 单行：两侧各 35 列

销售顺序固定：

`id, idx, qty, baseQty, materialCode, materialName, materialSpec, customerPartNo,
unitName, orderNo, orderQty, orderBaseQty, orderUnitName, orderPrice, orderAmount,
orderBasePrice, orderBaseAmount, orderTaxRate, orderCurrencyCode, reconciledQty,
remarks, insertedAt, updatedAt, deliveryId, companyId, orderItemId, materialId,
unitId, warehouseId, deliveryNo, deliveryDate, deliveryStatus, partyType, partyId,
remainingReconcilableQty`

采购顺序相同，只把 `deliveryId/deliveryNo/deliveryDate/deliveryStatus` 对应换成
`receiptId/receiptNo/receiptDate/receiptStatus`。

- superadmin/read-only capability 与 extended action 均为空；这表示子资源不独立进入权限
  目录，不表示没有 CRUD。
- destroy mutation 分别为 `destroySalDeliveryItem`、`destroyPurReceiptItem`。
- superadmin ref 为父单、公司、订单行、物料、单位、仓库和对手 poly ref。
- read-only 只保留同权限前缀的父单 ref；其余 ref 全降级。
- 末尾单号/日期/状态/对手与 `remainingReconcilableQty` 是 calculation，不是行表快照列。

## 单头、状态与可编辑边界

- 单号必填、最多 32，在各自表内全局唯一；留空分别使用
  `sales.delivery` / `purchase.receipt` 启用编号规则，手填值原样保留，无规则时拒绝。
- `deliveryDate/receiptDate` 必填且默认当天，是库存业务日。
- `postingDate` 草稿可空，审核动作也可接收；审核锁内无条件按
  “动作输入 → 单上已有值 → 收发日期”补齐。因此旧实现连零金额单也会在审核后落
  posting date；只有正金额才真正生成 GL。
- 公司创建后不可改。对手类型/ID 必填、必须存在，内部公司不能等于单据公司；销售对手
  限客户/内部公司，采购限供应商/内部公司。
- 头默认仓可空，有值时必须是本公司启用叶子仓；它只用于页面新行预填，审核绝不把它当
  “行仓为空时的后备值”。每个行仓仍必须显式保存。
- 借贷科目在草稿 create/update 即必填，必须属于本公司、启用且非汇总；销售借方另强制
  `unbilled_receivable`，采购贷方另强制 `unbilled_payable`，另一侧角色不限。
- `remarks` 最多 512；创建人从 Actor 写入，审核成功才写审核人/审核时间。
- 已有任一行后，对手类型/ID 冻结，须先删完行才能改；公司本来就不在 update 输入。
  草稿的单号、收发日期、过账日期、默认仓、两科目、备注仍可改。
- 状态机严格为 `DRAFT → AUDITED → VOIDED`。仅草稿可更新、删除、编辑行和审核；
  仅已审核可作废；无关闭、反审核、红冲或恢复动作。审核至少一行。
- 对手为内部公司时也只落本侧履约与账：销售不自动生成买方入库/应付，采购不自动生成
  卖方出库/应收；跨公司镜像不属于本模块。

## 行绑定、数量与不可变快照

- create 必须给父单与订单行；update 不可换父单，但可在草稿内换订单行。`companyId`
  总是从父单派生，不信任客户端。
- 订单行必须存在，父订单当下必须 `AUDITED`；草稿、关闭、作废订单都拒绝。行保存会检查
  父单与订单的公司、对手完全一致；一张履约单可跨多个订单，但所有行的订单原币代码必须
  相同。同一订单行可拆成同一履约单的多行，以支持分仓。
- 物料强制取订单行，客户端不能替换。单位留空默认订单行单位；显式单位须是该物料默认
  单位或转换单位。`qty > 0`；`baseQty` 使用物料默认单位口径，默认单位时直接等于
  `qty`，转换单位时才按转换系数折算并舍入 6 位。
- 行仓必填，须为父单公司启用叶子仓。`idx` 只要求整数，没有正数或同单唯一约束；
  无显式排序时按 `idx ASC`。
- 每次 create/update 都重拍物料
  `code/name/spec/customerPartNo/unitName`，并重拍订单
  `orderNo/orderQty/orderBaseQty/orderUnitName/orderPrice/orderAmount/orderBasePrice/
  orderBaseAmount/orderTaxRate/orderCurrencyCode`。审核后行不能再编辑，快照冻结；后续订单或
  主数据变化不回溯。
- `reconciledQty` 初始 0，是默认单位口径的受控投影，只允许销售/采购对账模块在已锁行后
  加减；不得暴露成通用 REST update。数据库保证非负，调用方还必须检查本次可对账剩余。
  `remainingReconcilableQty = baseQty - reconciledQty`。
- 订单候选剩余 `remainingBaseQty` 与履约行的
  `remainingReconcilableQty` 是两个不同概念，迁移实现与筛选不能混用。

## 图纸附件快照

- 每次行 create/update 成功后，先清空该行旧 `drawing` 挂接，再读取物料当前
  `drawing` 挂接，复制相同 `fileId` 到履约行：
  销售 owner type=`sal_delivery_item`，采购=`pur_receipt_item`，category 都是
  `drawing`，company 取行公司。
- 这是附件引用快照，不复制文件字节；非 drawing 槽位不复制。即使只是改数量，也会整删
  整建并跟随物料当下图纸集合。
- 行 destroy 后清自己的挂接。删头由数据库级联删行，不触发行 destroy hook，因此头
  destroy 必须先枚举行并清挂接；附件清理与删单在同一事务同生共死。
- 物料解除图纸挂接不解除已保存履约行的挂接；只要任一履约行仍引用文件，文件删除守卫
  继续拒绝删除。
- 历史销售发货行曾由
  `20260720090000_sal_delivery_item_drawing_snapshot.exs` 做一次性回填；这是历史迁移兼容
  事实，不应在每次服务启动重复。新 Go 写路径对销售/采购都执行上述同步。

## 审核的库存、GL 与投影事务

审核必须是单一数据库事务。任一步失败，头状态、审核人/时间、库存、GL、订单投影、
采购需求投影均不得部分提交。

### 库存事实

每行生成一条数量分录：

| 侧 | voucher type | 数量 | 日期 |
|---|---|---|---|
| 销售发货 | `sales.delivery` | `-baseQty` | `deliveryDate` |
| 采购入库 | `purchase.receipt` | `+baseQty` | `receiptDate` |

voucher ID/no/company 取履约头，仓库/物料取行，库存 remarks 取头备注。库存模块先按
`(warehouseId, materialId)` 汇总本次 delta；`allowNegative=false` 的仓必须满足
“当前未取消余额 + delta ≥ 0”，允许负库存的仓跳过该闸；该检查只看当前余额，不按历史
posting date 逐时点重放。库存分录仍只记数量，不做采购估值；销售不生成销货成本分录。

### 未开票往来与总账

每行履约本币金额：

`orderBaseAmount × baseQty ÷ orderBaseQty`

若快照 `orderBaseQty = 0`，该行按 0；全单求和后统一舍入 2 位。金额严格使用履约行上的
订单快照，不回查订单当前金额。

- 全单金额 `> 0` 时写恰好两条配平 GL：
  - 销售：借选定未开票应收科目并带对手；贷选定科目且不带对手。
  - 采购：借选定科目且不带对手；贷选定未开票应付科目并带对手。
- GL voucher type/ID/no/company 对应履约单，日期取审核后 `postingDate`；每条 currency
  取所选科目自身的 `currencyId`，金额仍是上述公司本币金额；GL remarks 为空。
- 全单金额不大于 0（现有定价约束下实际为零）时完全跳过 GL，不造名义分录；但草稿两科
  依然必填。
- 不拆销项/进项税：履约金额使用订单本币含税快照，税务分拆留到发票/对账链。

因此审核生效后，销售在 GL 中形成未开票应收余额，采购形成未开票应付余额；这不是仅供
页面展示的临时计算。

### 订单与需求投影

- 审核按 `orderItemId` 分组，同一订单行在本单的多行 `baseQty` 先求和。
- 销售审核把组和加到订单行 `shippedQty`；采购加到 `receivedQty`。二者都是物料默认
  单位口径。
- 采购订单行若有 `demandLineId`，同一事务再把相同 delta 加到履约需求行
  `receivedQty`；累计达到需求 `baseQty` 时需求行自动完成。无需求来源则跳过。
- 这些投影是读性能缓存，事实来源仍是已审核未作废的履约行；投影调整只能走模块内部命令，
  不能公开成任意增减 API。

## 容差、锁与并发线性化点

- 审核先锁履约头 `FOR UPDATE` 并在锁内重查仍为草稿。所有行 create/update/destroy 也在
  动作事务内锁同一父头并重查草稿，因此审核与行编辑串行；审核时读取到的是稳定行集合。
- 按订单行分组后，对每组先锁订单行 `FOR UPDATE`，再锁父订单 `FOR UPDATE`，并重查订单
  仍为 `AUDITED`。
- 销售权威闸：
  `当前 shippedQty + 本单该订单行 ΣbaseQty <= 订单 baseQty ×
  (1 + deliveryOvershipRatio)`。
- 采购权威闸：
  `当前 receivedQty + 本单该订单行 ΣbaseQty <= 订单 baseQty ×
  (1 + receiptOverreceiveRatio)`。
- 两个比例来自供应链全局设置，缺省 0，合法范围 0～1；草稿保存不硬卡，审核锁内硬卡。
  同订单行多行必须先分组，否则会重复读取旧投影而错误放行。
- 投影写回继续锁订单行；采购再锁需求行后更新。作废走同样父头锁，并在内部投影调整时锁
  订单行/需求行。
- 库存 `post/cancel` 在校验余额前，对本次涉及的 `(warehouseId, materialId)` 去重排序，
  逐键获取事务级 `pg_advisory_xact_lock`；同仓同料的并发入出库由此串行，且多键统一排序
  避免库存锁死锁。锁与调用方审核/作废事务同生共死。
- 旧 Elixir 对 `Enum.group_by` 结果没有声明业务稳定锁顺序。Go 迁移必须按稳定
  `orderItemId` 顺序处理分组，并让所有审核/作废路径使用同一顺序；这不改变业务结果，
  只避免多订单行交叉履约时形成锁序死锁。
- 迁移后的真实 PG 并发测试至少证明：
  同单双审核只有一个成功且库存/GL/投影只记一次；审核与增删改行串行；
  两张单竞争同一订单剩余量时只有容差允许者成功；采购需求投影不丢增量；
  审核与订单关闭/作废竞争时不能在非 AUDITED 订单上提交履约；不同单据竞争同仓同料余额
  时，咨询锁后的最终余额符合仓库 `allowNegative` 规则。

## 公司默认科目

`sal_company_account_default` 一公司一行，四槽
`deliveryDebit/deliveryCredit/receiptDebit/receiptCredit` 都可空：

- 默认值只是新建表单便利，不是服务端替用户选科目。新建态选择或切换公司时，两槽整组覆盖
  为该公司默认；无默认则两槽都清空。打开已有草稿不重灌，修改默认也不追溯已有单。
- 单据保存仍按实际传入科目执行必填、公司、启用、非汇总和角色校验；不能因公司配置过默认
  就跳过校验。
- 默认槽自身采用相同角色约束：销售默认借方必须未开票应收，采购默认贷方必须未开票应付，
  另一侧角色不限。
- 默认资源读取当前复用 `sales.setting:read` 并叠加公司范围；配置写复用
  `sales.setting:update`。本批若只迁四个 Grid，必须明确协调该既有权限依赖，不得把
  `sales.delivery`/`purchase.receipt` 用户静默提权，也不得绕过公司范围直查默认表。

标准 Delivery/Receipt Resource 本身不会自动查默认表；整组代入发生在创建页面/adapter。
服务端的权威职责是校验最终所选账户。

## 候选查询与保存复检

现有页面从 PR-2.14 的订单行资源读取候选：

| 消费者 | 候选资源 | 固定条件 |
|---|---|---|
| 销售发货行 | `salOrderItems` | `orderStatus=AUDITED`、公司/对手等于履约头、`remainingBaseQty > 0` |
| 普通采购入库行 | `purOrderItems` | `orderStatus=AUDITED`、公司/对手等于履约头、`remainingBaseQty > 0` |

- 未选齐公司、对手类型与对手 ID 时不发候选查询。候选读取须支持这些结构化 filter，并受
  订单资源 read 权限和请求公司范围约束。
- 精确旧事实：普通采购入库候选和 `Purchase.ReceiptItem` 保存校验都没有
  `orderIsOutsourced=false` 条件，故已审核委外采购订单行也能进入普通采购入库。产品流程
  倾向走委外入库，但迁移不得夹带收紧；要改必须另立业务变更。
- 候选 `remainingBaseQty > 0` 只改善选择体验，并不消费数量，也不包含容差额；两张草稿
  可同时选同一余额，甚至完全履约后若直接提交既有选中值也不能只靠候选判断。
- 行保存重新校验订单存在/状态、公司、对手、原币和物料；审核再在锁内权威校验订单状态、
  当前投影与容差。客户端快照、剩余量及候选结果都不可信。

## 作废、回滚与上游阻挡

- 仅已审核履约单可作废。任一行 `reconciledQty > 0` 时，外层预检和父头锁内权威复检都拒绝，
  必须先撤回/作废相关销售或采购对账。
- 销售作废顺序语义：取消 `sales.delivery` 库存组、取消同 voucher GL 组、按订单行分组
  扣回 `shippedQty`。
- 采购作废：取消 `purchase.receipt` 库存组、取消 GL 组、扣回订单行 `receivedQty`，
  并沿订单行扣回需求行 `receivedQty`；回退后若 `receivedQty < baseQty`，需求行状态明确
  设回 `PENDING`，不是恢复某个任意历史状态。
- “取消”保留已作废事实，不是物理删除分录。零金额单的 GL 取消面对空分录组也成功。
- 采购入库作废会减少库存；对 `allowNegative=false` 的仓，若入库量已被后续业务耗用而会
  导致负数，作废失败，单据保持已审核，库存/GL/订单/需求投影全部保持原状；允许负库存仓
  跳过此余额闸。销售发货取消负向库存通常增加库存，但仍统一走库存取消接口与咨询锁。
- 作废任一步失败必须回滚整笔事务，只有全部副作用回退成功才把头置 `VOIDED`。
- 上游订单存在已审核标准履约时不可作废；存在草稿履约引用也须先删草稿。标准履约成功作废
  后解除该阻挡。订单关闭后不能新增履约，但不改历史；已关闭订单上的既有履约仍可作废纠错。

## 权限、公司范围与审计

- superadmin bypass。普通 Actor 所有动作先校验对应权限。
- 销售头权限目录为
  `create/read/update/delete/audit/void/print/export/batch_print`；采购头为
  `create/read/update/delete/audit/void`。
- 子资源不独立入权限目录；read/create/update/destroy 分别复用父前缀
  `read/create/update/delete`。`adjustReconciledQty`、订单/需求投影调整都不是外部命令。
- 头 read/update/destroy/audit/void 叠加 CompanyScope fail-closed；create 校验输入公司。
  子资源 create 先从父头派生公司再校验 CompanyAccessible；read/update/destroy 按行上冗余
  公司范围过滤。
- REST 必须权限先行：在 JSON 解码和记录存在性响应之前拒绝无权限请求；single 越公司表现
  为 not-found，list 仅返回授权公司，无公司范围返回空集。不能因内部履约事务
  `authorize?: false` 而绕开入口授权。
- 四资源都挂通用审计 Fragment。外部头/行 CRUD 与头 audit/void 保留字段级审计；内部库存、
  GL、投影动作保留各模块既有审计语义。头删除的 DB 级联不伪造逐行 destroy 审计。

## Go 模块 seam

销售发货与采购入库共享生命周期、父锁、订单绑定、数量折算、快照、图纸、容差、库存/GL
编排和回滚，但方向、权限、编号、对手、强制科目角色、订单投影以及采购需求回写不同。
Go 应由一个深的“标准履约”模块拥有共用事务内核，以受控 side 配置表达真实差异：

- 动态表名、voucher type、资源名、权限、编号和方向只能来自编译期受控配置；值全部参数化。
- 聚合根方法拥有状态迁移、锁顺序、行集合、容差、库存/GL 和投影原子性；HTTP handler
  不能自行拼接一半副作用。
- 库存、GL、订单和需求可作为本地模块接口协作，但同一 PostgreSQL 事务必须显式贯穿；
  不允许“先提交履约头，再异步补库存/账/投影”。
- 外部只暴露头/行 CRUD、audit、void、候选/默认读取；投影调整与附件同步保持内部命令。
- 对账不是本批迁移资源，但其后续迁移必须通过受控接口调整行 `reconciledQty`；当前表列、
  作废闸和 remaining calculation 不能先删。

## PR-2.15 标准履约完成门槛

- 本契约 8 份 Meta 快照逐 JSON 语义对拍，钉住列顺序、类型、枚举、ref 降级、
  capabilities、extended actions 与 destroy mutations。
- 四资源 sqlc/Go/OpenAPI/ResourceClient 完成；头/行 CRUD、audit/void、销售打印/导出能力、
  订单候选、默认科目读取和附件展示不再回退 GraphQL。
- 真实 PostgreSQL 覆盖两侧编号/日期/party/头仓与行仓、单位折算、跨订单同币、
  快照/图纸、科目必填与角色、零金额、金额比例舍入、库存方向、GL 对手、订单投影、
  采购需求投影、容差、对账作废闸、采购负库存回滚和精确 cleanup。
- 真实 PG 并发覆盖本契约“锁与并发线性化点”列出的竞争，并验证失败事务无孤儿库存、
  GL、审计或投影。
- 真实 REST 覆盖权限先行、single/multi/all/empty company scope、结构化候选过滤、四资源
  Meta、两个头动作，以及普通采购不带 `orderIsOutsourced=false` 的精确兼容行为。
- Chromium 至少覆盖一张分仓/分批销售发货与一张带需求来源的采购入库：默认科目代入、
  候选、图纸、审核、库存/未开票往来、作废/失败回滚均可见；目标会话业务 `/graphql=0`。
- 固定 Go 容器版本下全量 Go、OpenAPI、typecheck、前端测试/check/build 与 Chromium 回归
  通过；删除旧实现前本契约四份旧测试仍为 **49 passed**。
