# PR-2.14 销售/采购订单与委外清单迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，只冻结迁移前事实，不新增业务规则。
事实来源为旧 Elixir/Ash Resource、真实 `GridMeta.build/2` 输出、PostgreSQL 迁移、
旧测试、产品文档、ADR 与根 `CONTEXT.md`。本批一次迁移 6 个 Grid 资源；订单审核仍是
纯业务承诺，不在本批生成库存或总账分录。

## 范围

| Grid 资源 | Elixir Resource | 表 | 权限前缀 |
|---|---|---|---|
| `salOrders` | `SynieCore.Sales.Order` | `sal_order` | `sales.order` |
| `salOrderItems` | `SynieCore.Sales.OrderItem` | `sal_order_item` | 复用 `sales.order` |
| `purOrders` | `SynieCore.Purchase.Order` | `pur_order` | `purchase.order` |
| `purOrderItems` | `SynieCore.Purchase.OrderItem` | `pur_order_item` | 复用 `purchase.order` |
| `purOrderItemMaterials` | `SynieCore.Purchase.OrderItemMaterial` | `pur_order_item_material` | 复用 `purchase.order` |
| `purOrderItemByproducts` | `SynieCore.Purchase.OrderItemByproduct` | `pur_order_item_byproduct` | 复用 `purchase.order` |

本批还必须承接六资源页面实际依赖的非 Grid 表面：

- 销售/采购订单详情与行 diff、审核核对、关闭、作废；
- 采购订单的履约需求行池、委外 BOM 代入预览、发料/副产物清单；
- 订单“收发货历史”只读查询；
- 销售发货、采购入库、委外发料、委外入库的订单候选读取。

这些是订单模块的查询/命令表面，不额外计为迁移资源。报价资源已在 PR-2.13 迁移；
设置、公司、币种、物料、单位、文件与打印模板也已在更早批次迁移。

## 冻结资产与复现

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_order_contract.exs \
  ../.scratch/migration/snapshots/pr-2.14

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/sales/order_test.exs \
  apps/synie_core/test/synie_core/purchase/order_test.exs \
  apps/synie_core/test/synie_core/purchase/order_outsourced_test.exs \
  apps/synie_core/test/synie_core/purchase/demand_linkage_test.exs
```

捕获脚本为 6 个资源各生成 `superadmin` 与 `read-only` 两份 JSON，共 12 份；read-only
Actor 只持 `sales.order:read` 与 `purchase.order:read`。旧订单、委外与需求串联测试复跑为
**124 passed**（仅两条既有编译 warning）。

字段顺序、枚举、ref 降级、capability、extended action 与 destroy mutation 的唯一真值是
`.scratch/migration/snapshots/pr-2.14/*.grid.json`，Go Meta 必须逐 JSON 语义对拍。关键差异：

- 销售头 19 列，superadmin 能力为
  `create/update/delete/audit/close/void/print/export/batch_print`；
  采购头 20 列，只有 `create/update/delete/audit/close/void`。旧迁移清单曾写采购可打印，
  真实 Resource/Meta 并无该能力，不得补入。
- 销售行 29 列、采购行 33 列、委外发料清单 16 列、副产物清单 9 列；四者 capability
  与 extended action 为空，但 HTTP CRUD 复用父订单权限。
- read-only 仅保留同权限前缀的父 ref（行到订单、清单到采购行），其余 ref 降为 string。
- 两侧 Meta 的 `partyType` 都机械显示四种 PartyType；写入口仍须按业务侧收窄。

Meta 捕获只反射 Resource，不创建业务数据；本次冻结不编辑旧 `backend/`。

## 共用订单头契约

事实来源：两侧 `order.ex`、订单迁移、销售/采购订单产品文档。

- `orderNo` 必填、最多 32、各侧表内全局唯一；留空分别按 `sales.order` /
  `purchase.order` 的启用编号规则自动取号，手填原样保留，无规则时拒绝。
- `orderDate` 必填，默认当天；公司创建后不可改。
- 对手类型与 ID 必填、须真实存在，内部公司不能等于单据公司。销售只允许
  `CUSTOMER/COMPANY`；采购只允许 `SUPPLIER/COMPANY`。
- `remarks` 最多 512；`terms` 可空自由文本。创建人来自 Actor，审核成功才填写审核人/
  审核时间。
- 公司本币为必填主数据。币种留空默认公司本币；本币单汇率强制为 1，即使客户端传别值；
  外币 create 或改成外币时必须显式传 `exchangeRate > 0`。
- 一单一币。草稿无条目时可改币种/汇率；汇率实际变化时同一事务重算所有行的本币列。
  有任一条目后，公司、对手、订单日期、币种冻结，须先删完条目才能改；备注、条款不受拦。
- 两侧状态机相同：
  `DRAFT → AUDITED → CLOSED` 或 `DRAFT → AUDITED → VOIDED`。
  仅草稿可改、删、编辑子资源和审核；仅已审核可关闭/作废；关闭与作废均不可逆，
  无反审核。关闭表示不再履行剩余，作废表示单据不该存在。
- 审核至少一行。订单审核本身不写库存或总账；销售发货/采购入库/委外执行单据才产生
  履约副作用。
- `orderType` 建后锁死。采购 `isOutsourced` 同样建后锁死，且与订单类型正交。

## 常规、样品与零星定价

事实来源：两侧 `OrderItem.DeriveQuotation`、`Order.VerifyItems`、
`{sales,purchase}/quotation_link.ex`、分型 ADR 与 124-test 基线。

### 常规订单

- 每行必须挂本侧报价条目；不能混用销售/采购报价。
- 有效报价判定：父报价仍为 `AUDITED`；订单日期位于
  `[quotationDate, validUntil]`（两端含）；公司、对手类型、对手 ID、币种与订单一致。
  判定使用订单日期，不使用“今天”。
- 物料、单位、原币含税单价由报价强制派生，忽略客户端同名值。固定价直接取报价行价；
  数量梯度取 `minQty <= qty` 中起订量最大的档，低于首档拒绝。
- 改 `qty` 必须重新套梯度档。税率未显式传时从报价带入，显式税率（含 0）可覆盖。
- 建行后报价被作废、配置或引用漂移时，审核锁内逐行复检；不满足则订单保持草稿。
  已经审核形成的订单不因报价后来作废而回写改价或断链。

### 销售样品订单

- `orderType=SAMPLE`；报价引用必须为空，物料/单位/价格自由录入。
- 单行录入 `qty <= sal_setting.sample_item_max_qty`；按录入数量直接比，不换算默认单位。
- 行保存与审核都按当前设置复检。销售选料还须满足客户物料规则：通用料或本客户料；
  内部公司对手只能用通用料。

### 采购零星订单

- `orderType=SPOT`；报价引用必须为空，物料/单位/价格自由录入。
- 单行录入 `qty <= sal_setting.spot_item_max_qty`，同样不换算。
- 采购不校验客户专属物料，任何物料可下单。

采购委外与普通采购都可为常规或零星：常规委外的报价是加工费报价，零星委外手填加工费。

## 条目、金额与快照

事实来源：两侧 `order_item.ex`、快照/双币 ADR、订单迁移与旧测试。

- create 输入父订单、`idx/material/unit/qty/price/taxRate/remarks` 与可空报价引用；
  update 不可换父订单。采购另有可空 `bomId/demandLineId/demandDate`。
  `companyId` 一律由父订单派生，不信任客户端。
- `idx` 只要求整数，无正数或同单唯一约束；未显式排序时主读按 `idx ASC`。
- `qty > 0`，`price >= 0`（零价合法），税率默认 `0.13` 且
  `0 <= taxRate < 1`。
- 单位限物料默认单位或其转换单位。`baseQty` 是物料默认单位口径，默认单位直接取 qty；
  转换单位按既有转换系数折算并保留 6 位。
- 金额链固定：
  `amount = round(qty × price, 2)`；
  `baseAmount = round(amount × exchangeRate, 2)`；
  `basePrice = round(price × exchangeRate, 4)`。
  本币金额从已舍入的原币金额换算，不从 `basePrice × qty` 反推。三列均系统算不可手改。
- 订单头的 `grossTotal/baseGrossTotal` 分别 sum 行 `amount/baseAmount`。
- 行每次 create/update 都重拍物料编号、名称、规格、客户料号、单位名，并把物料当前
  `drawing` 文件做不可变挂接复制；即使只改数量也重拍。审核后行不可编辑，快照冻结。
- 行删除要清理其图纸挂接；头删除由 DB 级联删行，但仍须显式清行图纸挂接，避免附件
  守卫永久锁文件。
- 销售 `shippedQty`、采购 `receivedQty` 都是默认单位口径的受控投影，初始 0、不可手改；
  `remainingBaseQty` 分别为 `baseQty - shippedQty/receivedQty`。

## 履约需求占用

事实来源：`Purchase.DemandLinePool`、采购订单的 `VerifyDemandLines` /
`AdjustDemandOrdered`、需求串联 ADR、`demand_linkage_test.exs`。

- `demandLineId` 与 `demandDate` 可空；手工采购行两者皆空合法。`demandDate` 只是来自需求行
  的展示快照，不驱动逻辑，不校验早晚。
- “从需求单勾选”池复用 `purchase.order:read`，采购员不必持需求资源读权限；仍须通过
  请求公司范围。池最多 200 行，按需求日、创建时间升序。
- 普通采购只列履约方式 `BUY`，委外订单只列 `OUTSOURCE`；父需求须 `CONFIRMED`，行未完成，
  `orderedQty < baseQty`，且公司一致。池返回默认单位口径的需求量、已下单与剩余可下单，
  建议录入量按需求行单位折回。
- 草稿引用不占量，也不锁上游；同一需求行可被多张草稿、多个订单行引用。
- 订单审核按需求行分组并 `FOR UPDATE` 锁行，复检：需求/行仍存在、需求仍已确认未关闭未
  作废、行未完成、履约方式匹配普通/委外、物料和公司一致。
- 审核硬卡
  `现有 orderedQty + 本单该需求行 ΣbaseQty <= demand baseQty ×
  (1 + demandOverorderRatio)`。池仍只建议基础剩余量，不主动消费容差。
- 审核成功同一事务累加需求行 `orderedQty`；订单作废扣回；关闭不释放已下单量。
  两张草稿竞争同一剩余量时，后审核者必须在锁内看到新投影并撞容差。
- 采购入库/委外入库沿订单条目回写需求行 `receivedQty`；累计已收达到需求量时行自动完成，
  下游入库作废时回滚。

## 委外订单与两类清单

事实来源：采购 `order*.ex`、委外采购 ADR、采购订单/委外发料/委外入库产品文档、
`order_outsourced_test.exs`。

- `isOutsourced=true` 表示整单委外加工：订单行物料是回收成品，订单行价是加工费；
  状态、编号、权限、金额链、报价分型不另起分支。
- 订单条目可空挂物料自身的 BOM。挂他物料 BOM 拒绝；BOM 只是代入来源留痕，
  删除 BOM 时引用置空，不挡删除。
- 不配 BOM、发料清单或副产物清单不挡建单和审核；没有发料清单时只是后续委外发料无候选。
- “从 BOM 代入”是快照复制：
  发料数量=`净用量 × (1 + 损耗率，空按 0) × 订单行 qty`；
  副产物数量=`单位产出量 × 订单行 qty`。
  代入后与 BOM 脱钩，可自由增删改；BOM 后改不回溯，订单行 qty 后改也不自动重算。
- 两清单都要求材料、可用单位、`quantity > 0`、可空行备注（最多 512），公司从父条目派生。
  create 可指定父条目，update 不可换父条目；随父条目/订单 DB 级联删除。
- 发料清单的 `issuedQty` 是材料默认单位口径受控投影，初始 0，委外发料审核加、作废减；
  不设超发硬闸，`remainingIssueQty` 可为负。
- 发料清单、副产物清单增删改必须锁最上层采购订单并复检仍为草稿，不能只锁/检查子行。

## 权限、公司范围、审计与锁

事实来源：六 Resource policies、`Audit.Fragment`、各 `SyncOrder` /
`SyncOrderItem` 与头动作的 `before_action`。

- superadmin bypass。普通 Actor 的所有动作先校验本侧权限。
- 销售头权限目录：
  `create/read/update/delete/audit/close/void/print/export/batch_print`；
  采购头：
  `create/read/update/delete/audit/close/void`。
- 子资源不独立入权限目录，但 read/create/update/destroy 分别复用父前缀
  `read/create/update/delete`。需求池复用 `purchase.order:read`。
- 头 read/update/destroy/audit/close/void 叠加 CompanyScope fail-closed；
  create 校验输入公司。子资源 create 先从父资源派生公司再校验，公司列不可由客户端越权；
  子资源 read/update/destroy 叠加自身冗余公司范围。
- 权限拒绝必须发生在请求 JSON 解码和记录存在性响应之前；越公司 single 返回 not-found，
  list 只返回授权公司，空公司范围返回空集。
- 六资源都挂通用审计 Fragment。外部 create/update/destroy 与头 audit/close/void 写字段级
  审计；内部重算/投影调整保留既有动作审计语义。删除头时 DB 级联子资源不伪造逐行
  destroy 审计。
- 头 update/delete/audit/close/void 与所有行/清单增删改，都在动作事务内对订单行
  `FOR UPDATE`，锁持有到提交。审核锁内重查“至少一行”和全部分型规则；
  并发审核只能一次成功。
- 采购审核涉及来源需求行时，锁顺序为订单后需求行；投影加减也锁需求行。迁移实现须固定
  顺序，避免多需求行并发死锁。
- 子表不能使用“事务外查草稿、随后裸写”的实现；构建期普通读只用于友好报错，
  权威判定是事务内父锁后的重读。

## 关闭、作废与下游引用

事实来源：两侧头 `close/void`、发货/入库 Resource 与产品文档。

- 关闭只要求当前已审核；关闭后不得新增销售发货、采购入库、委外发料或委外入库。
  关闭不回滚已经发生的 `shippedQty/receivedQty/issuedQty/orderedQty`。
- 销售订单存在已审核销售发货时不可作废；存在草稿销售发货引用时须先删草稿。
- 采购订单存在已审核采购入库或已审核委外入库时不可作废；存在任一草稿入库引用时须先删
  草稿。委外发料不是采购订单作废的阻挡条件；发料后作废订单是否合理不在迁移中另加规则。
- 采购订单作废成功后回滚来源需求行已下单投影；销售订单无对应需求投影副作用。
- 报价、BOM、订单行的溯源引用均保留历史：报价引用 `ON DELETE NO ACTION`，
  BOM 引用 `ON DELETE SET NULL`，需求行引用 `ON DELETE RESTRICT`。

## 下游候选与历史读取契约

迁移不能只让订单两个列表可用；旧前端以下选择器直接读本批行资源，并在写入时由下游
Resource 再做权威复检：

| 消费者 | 候选资源 | 迁移前候选条件 |
|---|---|---|
| 销售发货 | `salOrderItems` | `orderStatus=AUDITED`、公司/对手一致、`remainingBaseQty > 0` |
| 采购入库 | `purOrderItems` | `orderStatus=AUDITED`、公司/对手一致、`remainingBaseQty > 0` |
| 委外入库 | `purOrderItems` | 上述条件 + `orderIsOutsourced=true` |
| 委外发料 | `purOrderItemMaterials` | `orderStatus=AUDITED`、`orderIsOutsourced=true`、公司/对手一致、`remainingIssueQty > 0` |
| 委外入库材料/副产物带出 | 两类清单 | `orderItemId = 已选委外订单条目` |

精确迁移前事实：普通采购入库候选和 `Purchase.ReceiptItem` 的服务端校验都**没有**
`orderIsOutsourced=false` 闸，因此已审核委外订单行也可进入普通采购入库。产品文档把委外执行
描述为委外入库链，但迁移不得静默改变这一实际行为；若要收紧须另立业务变更，不夹带在
PR-2.14。

候选过滤只改善选择体验，保存与下游审核仍须复检：订单状态、公司/对手、同一单内原币、
物料一致，及各自超发/超收规则；不得信任客户端带出的快照或剩余量。

订单详情的“收发货历史”来自 `scm_order_flow_item` 只读 UNION 视图：

- 销售订单：销售发货行；
- 采购订单：采购入库、委外发料、委外入库行；
- 统一字段为类型、单号、日期、状态、公司、订单/订单行、物料快照、单位、数量；
- 按单据日期倒序展示。PR-2.14 可提供订单专用 REST 查询，不必把该视图计为第七个 Grid
  资源，但订单页面不得为历史 Tab 回退 GraphQL。

采购订单页面还有两个不可遗漏的专用读取：需求行池与 BOM 代入预览。后者可在订单模块提供
“按 BOM + qty 展开发料/副产物快照”的 REST seam；不能为了页面 GraphQL=0 顺手迁移全部
生产 BOM Grid。

## Go 模块 seam

销售与采购订单共享状态、双币金额链、父锁、报价套价和快照，但采购另有需求串联与委外清单。
Go 应以一个深的订单模块承载共用内核，以受控 side 配置区分表、资源、权限、编号、对手类型
与样品/零星上限；采购扩展放在同模块的明确子能力中，不复制一套销售实现。

- 动态表名只能来自编译期受控配置；值参数全部参数化。
- 订单聚合根负责锁顺序、状态迁移、行金额、报价复核、图纸挂接和审计。
- 下游库存/总账仍由发货/入库模块拥有；订单只暴露候选与受控投影调整接口。
- `adjustShippedQty/adjustReceivedQty/adjustIssuedQty/recalcBase` 是模块内部命令，
  不暴露成通用 CRUD HTTP。
- 需求行池、BOM 展开、订单历史是订单上下文查询，不需要把未迁移资源的通用 CRUD 拉入本批。

## PR-2.14 完成门槛

- 12 份 GridMeta 快照逐 JSON 语义对拍，并钉住列顺序、枚举、ref 降级、capability、
  extended action 与 destroy mutation。
- 六资源的 sqlc/Go/OpenAPI/ResourceClient 完成；头/行/清单 CRUD、audit/close/void、
  销售打印/导出能力、需求池、BOM 展开与订单历史接通。
- 真实 PostgreSQL 覆盖：
  两侧编号/default date/party/default currency/外币汇率/金额舍入/聚合；
  常规固定价与梯度套价、低于首档、样品/零星上限与审核时配置漂移；
  物料单位/base qty/五字段快照/图纸复制与清理；
  采购客户料差异、委外标记锁死、BOM 限物料/置空、两清单快照与级联；
  需求池、草稿不占、审核占用、作废释放、容差、两单竞争；
  状态冻结、下游作废阻挡、公司范围、审计和精确 cleanup。
- 并发真实 PG 至少覆盖：同单审核恰好一次成功；审核与行/清单编辑串行；
  两订单竞争同一需求余量仅容差内者成功；审计/投影不重复。
- 真实 REST 覆盖权限先行、single/multi/all/empty company scope、结构化筛选、六资源 Meta、
  三个头动作、需求池/BOM/历史及下游候选等价过滤。
- 订单抽屉与两类条目页、销售发货/采购入库/委外发料/委外入库候选、需求勾选、
  委外配置、审核核对和历史 Tab 全部使用 REST；目标会话业务 `/graphql=0`。
- Chromium 至少覆盖一张销售常规梯度订单、一张销售样品订单、一张采购零星需求来源订单、
  一张带 BOM/发料/副产物的委外订单，并验证审核、关闭/作废或下游候选。
- 固定 `golang:1.26.4-alpine` 全量 Go、OpenAPI、typecheck、前端测试/check/build 与
  Go Chromium 回归通过；旧 backend 测试在删除旧实现前仍为 124 passed。
- 通过后 6 个资源改为“已完成”，严格进度从 **44/100** 更新为 **50/100**。
