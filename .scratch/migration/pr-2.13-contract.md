# PR-2.13 销售/采购报价对称超级批次迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，不新增业务规则。迁移事实来自旧
Elixir/Ash Resource、真实 `GridMeta.build/2` 输出、PostgreSQL 约束、旧测试、产品文档
与根 `CONTEXT.md`。销售与采购报价业务结构对称，本批一次迁移 6 个资源；不把订单、
库存或总账事务链并入本批。

## 范围

| Grid 资源 | Elixir Resource | 表 | 权限前缀 |
|---|---|---|---|
| `salQuotations` | `SynieCore.Sales.Quotation` | `sal_quotation` | `sales.quotation` |
| `salQuotationItems` | `SynieCore.Sales.QuotationItem` | `sal_quotation_item` | 复用 `sales.quotation` |
| `salQuotationTiers` | `SynieCore.Sales.QuotationTier` | `sal_quotation_tier` | 复用 `sales.quotation` |
| `purQuotations` | `SynieCore.Purchase.Quotation` | `pur_quotation` | `purchase.quotation` |
| `purQuotationItems` | `SynieCore.Purchase.QuotationItem` | `pur_quotation_item` | 复用 `purchase.quotation` |
| `purQuotationTiers` | `SynieCore.Purchase.QuotationTier` | `pur_quotation_tier` | 复用 `purchase.quotation` |

本批同时迁移报价页面、条目页面、共用三态抽屉，以及销售订单和采购订单中的“有效报价
条目”候选查询。报价本身是纯价格承诺，不含数量、金额、汇率，不调用 GL 或库存引擎。
订单资源仍留在旧栈，本批只把它们的报价候选读取改为 Go REST。

主要一手来源：

- `backend/apps/synie_core/lib/synie_core/{sales,purchase}/quotation.ex`
- `backend/apps/synie_core/lib/synie_core/{sales,purchase}/quotation_item.ex`
- `backend/apps/synie_core/lib/synie_core/{sales,purchase}/quotation_tier.ex`
- `backend/apps/synie_core/lib/synie_core/{sales,purchase}/quotation_link.ex`
- `backend/apps/synie_core/test/synie_core/{sales,purchase}/quotation_test.exs`
- `backend/apps/synie_core/priv/repo/migrations/20260717160147_sales_quotation.exs`
- `backend/apps/synie_core/priv/repo/migrations/20260720153719_purchase_quotation_order.exs`
- `docs/产品文档/{销售报价,采购报价}.md`
- `docs/adr/2026-07-18-sales-quotation.md`
- `docs/adr/2026-07-20-purchase-line.md`
- `CONTEXT.md`

## 可复现捕获与旧基线

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_quotation_contract.exs \
  ../.scratch/migration/snapshots/pr-2.13

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/sales/quotation_test.exs \
  apps/synie_core/test/synie_core/purchase/quotation_test.exs
```

捕获脚本为 6 个资源各生成 `superadmin` 与 `read-only` 两份 JSON，共 12 份。read-only
Actor 只持 `sales.quotation:read` 与 `purchase.quotation:read`，因此同权限前缀的
quotation/item ref 保留，其他公司、币种、用户、物料、单位及对手 ref 均降级。

旧报价测试在真实 PostgreSQL/Ecto SQL Sandbox 上复跑 **47 passed**。Meta 捕获只反射
Resource，不创建业务数据；旧 `backend/` 不因本批迁移而编辑或删除。

## 12 份 GridMeta 精确契约

Go Meta 必须直接对拍 `snapshots/pr-2.13/`，不能只比较列名。

### 报价头（两侧各 16 列）

顺序固定：

`id, quotationNo, quotationDate, validUntil, partyType, partyId, terms, remarks, status,
auditedAt, insertedAt, updatedAt, companyId, currencyId, createdById, auditedById`

- superadmin capability 均为 `create/update/delete/audit/void`；read-only 均为空。
- destroy mutation 分别为 `destroySalQuotation` / `destroyPurQuotation`。
- extended action 顺序均为 `audit`、`void`，分别非危险/危险行操作。
- `status` enum 固定为 `DRAFT/草稿`、`AUDITED/已审核`、`VOIDED/已作废`。
- `partyType` 因共用 PartyType 机械反射，Meta 仍固定显示四值
  `SUPPLIER/CUSTOMER/COMPANY/EMPLOYEE`；写入口不得因此放宽。
- 销售 `partyId` poly ref 只有
  `COMPANY → basCompanies`、`CUSTOMER → salCustomers`；
  采购只有 `COMPANY → basCompanies`、`SUPPLIER → purSuppliers`。
- superadmin 的普通 FK 为 company、currency、createdBy、auditedBy；read-only 全部退化
  为 string。

销售与采购唯一列标签差异是对手/条款语境：销售为客户/内部公司、对客户条款，采购为
供应商/内部公司、对供应商条款。

### 报价条目（两侧各 24 列）

顺序固定：

`id, idx, pricingMode, price, taxRate, materialCode, materialName, materialSpec,
customerPartNo, unitName, remarks, insertedAt, updatedAt, quotationId, companyId,
materialId, unitId, tierCount, quotationDate, validUntil, quotationStatus, partyType,
partyId, currencyCode`

- superadmin/read-only capability 均为空，destroy mutation 分别为
  `destroySalQuotationItem` / `destroyPurQuotationItem`。
- capability 为空表示“不独立进入权限目录”，不是没有 CRUD；动作复用父权限。
- `pricingMode` 固定为 `FIXED/固定价`、`QTY_TIERED/数量梯度`。
- `quotationStatus` 与头状态 enum 相同。
- `tierCount` 是不可筛、不可排 aggregate。
- 6 个尾部头字段是 calculation，不落条目物理列；`currencyCode` 是 string。
- read-only 仍保留同前缀的 `quotationId` ref，其他 FK/poly ref 降级。

### 价格档（两侧各 7 列）

顺序固定：

`id, minQty, price, insertedAt, updatedAt, itemId, companyId`

superadmin/read-only capability 均为空；destroy mutation 分别为
`destroySalQuotationTier` / `destroyPurQuotationTier`。read-only 保留同前缀的
`itemId` ref，`companyId` 降级。

## 共用业务不变量

### 报价头

- 单号必填、最多 32、全局唯一；留空按各自资源的启用编号规则自动取号，手填原样保留。
  无规则时拒绝，不允许静默生成替代编号。
- `quotationDate` 必填默认当天，`validUntil` 必填且不得早于报价日期；截止当日仍有效。
- 公司创建后不可改。币种可空入参，保存时默认公司本币；有条目后币种与对手均冻结，
  须先删完条目才能改。
- 对手类型与 ID 必填并须真实存在；内部公司不能等于单据所属公司。
- `remarks` 最多 512；`terms` 可空自由文本。
- 创建人取当前 Actor；审核人/时间仅在审核成功时填写。
- 状态机严格为 `DRAFT → AUDITED → VOIDED`。仅草稿可修改、删除和编辑子资源；仅草稿
  可审核；仅已审核可作废。无反审核、无关闭，作废是终态。
- “已过期”是派生展示态：`AUDITED && today > validUntil`，不落库；过期报价仍可作废。
- 审核必须至少一行，且每个数量梯度条目至少一个价格档。
- 头更新/删除/audit/void、行与档增删改共用父报价单 `FOR UPDATE` 锁，在同一事务内
  权威复检状态和梯度模式；不能用无锁“先查后写”替代。

### 报价条目

- create 输入 quotation、idx、material、unit、pricingMode、price、taxRate、remarks；
  update 不可换父报价单。公司只从父报价派生，不信任客户端。
- `(quotationId, materialId, unitId)` 唯一；同物料不同单位允许。idx 后端只要求整数，
  默认读按 idx 升序，不擅自新增正数或唯一约束。
- 单位必须是物料默认单位或其转换单位。保存时重拍物料编号、名称、规格、客户料号、单位
  名称；审核后冻结，主数据变化不回溯。
- 固定价必须填非负 `price`；数量梯度强制行价为 null。税率默认 `0.13` 且
  `0 <= taxRate < 1`，只作口径标注，不参与报价金额计算。
- 梯度切回固定价时必须同时提供固定价，并在同一事务清空该行全部价格档。

### 价格档

- 仅数量梯度条目、且父报价仍为草稿时可增删改。
- `minQty > 0`，`price >= 0`（零价合法），同条目起订量唯一。
- 档价不要求随数量递减。订购量适用 `minQty <= qty` 中起订量最大的档；低于首档表示
  无报价。
- 默认读按 `minQty ASC`；删条目由 DB 级联删档。

## 销售与采购的明确差异

- 销售对手只允许 `CUSTOMER/COMPANY`；采购只允许 `SUPPLIER/COMPANY`。
- 销售客户专属物料只能报给对应客户，内部公司只能使用通用料；采购不做客户专属物料
  约束，任何物料均可报价。
- 权限与编号资源分别是 `sales.quotation`、`purchase.quotation`。
- 两侧表、GraphQL/Grid key、destroy/action 名和审计 resource 名不同，其他状态、
  定价、快照、锁与公司范围行为对称。
- `pricingMode` 当前只有 FIXED/QTY_TIERED；行情挂钩仍是未来规划，本批不得顺手预实现。

## 权限、公司范围与审计

- superadmin bypass；普通 Actor 所有动作先校验对应权限。
- 头权限目录为 `create/read/update/delete/audit/void`。Item/Tier 不独立入目录，但
  read/create/update/destroy 分别复用父前缀的 read/create/update/delete。
- read/update/destroy/audit/void 叠加 CompanyScope fail-closed；create 先从输入或父资源
  派生公司，再校验 CompanyAccessible。权限必须先于 JSON 解码与记录存在性响应。
- 三资源直接 CRUD/audit/void 写通用审计。删除头时 item/tier DB 级联不伪造逐行 destroy
  审计；删除 item 时 tier 同理。梯度切固定价属于模块内部清档，迁移后不把内部清理暴露成
  终端动作。

## 下游读取契约

销售/采购常规订单使用“有效报价条目”：

- 父报价已审核；
- 订单日期在 `[quotationDate, validUntil]`；
- 公司、对手、币种与订单完全一致；
- 固定价直接返回行价；梯度价按数量选最高适用档，低于首档拒绝；
- 销售再受客户专属物料规则约束。

报价后来作废不回写已形成订单，但仍处于草稿的订单在审核时会复检并拒绝。本批的
ResourceClient 必须支持订单抽屉所需嵌套筛选或提供等价的专用候选读取，不能只迁移两个
报价页面。

## Go 模块与 seam 取舍

销售/采购是两个真实变体，但状态、事务锁、定价与快照实现不应复制。Go 以一个深的报价
模块承载共用实现，对外只暴露销售/采购两个构造入口和头/行/档的业务方法；调用方不需要
知道锁顺序、派生字段、内部清档或表差异。

- 模块定义持有受控的 side 配置：表/资源/权限/编号名与允许对手类型。
- PostgreSQL 是本地可替代依赖，真实 PG 测试直接穿过模块 interface；不为单一生产
  实现额外暴露浅 port。
- 所有动态标识符只能来自编译期受控配置，值参数继续参数化；sqlc 保留两侧静态 SQL，
  模块内部适配成同一实现。
- Meta、HTTP 与前端可分销售/采购 adapter，但业务状态与校验只在模块内实现一次。

删除该模块会让父锁、定价、快照、权限与审计规则重新散落到两侧，说明该 seam 具备真实
leverage 与 locality。

## PR-2.13 完成门槛

- 12 份 Meta 快照逐 JSON 语义对拍。
- 六资源 sqlc/Go/OpenAPI/ResourceClient 完成；销售/采购报价页面及订单报价选择器的目标
  GraphQL marker 为 0。
- 真实 PG 覆盖两侧 CRUD、默认币种/编号、party 差异、客户物料差异、单位、固定/梯度、
  切模式清档、审核门槛、并发审核、状态冻结、公司范围、审计与级联。
- 真实 REST 覆盖权限先行、single/multi/all/empty scope、嵌套筛选及精确 cleanup=0。
- Chromium 覆盖销售/采购各一张混合固定价+梯度价报价的创建、审核、过期显示或作废，
  以及订单报价候选读取；目标会话 `/graphql=0`。
- 固定 `golang:1.26.4-alpine` 全量 Go、OpenAPI、typecheck、前端测试/check/build 通过。
- 通过后 6 个资源改为“已完成”，严格进度从 **38/100** 更新为 **44/100**。
