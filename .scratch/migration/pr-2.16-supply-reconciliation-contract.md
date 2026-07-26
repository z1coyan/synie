# PR-2.16 供应链对账、公司默认科目与订单收发货历史迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，只冻结旧 Elixir/Ash/GraphQL 实际表面，
不新增业务规则。范围为销售对账、采购对账、公司默认过账科目和订单收发货历史 6 个
Grid 资源。

事实来源按优先级为：

1. 旧 Resource 与 GraphQL 注册：
   `backend/apps/synie_core/lib/synie_core/{sales,purchase,scm}/`、
   `backend/apps/synie_core/lib/synie_core.ex`；
2. 真实 `SynieWeb.GridMeta.build/2` 输出：
   `.scratch/migration/snapshots/pr-2.16/*.grid.json`；
3. PostgreSQL 迁移与真实 PostgreSQL/Ecto 测试；
4. `CONTEXT.md`、销售/采购对账产品文档与对应 ADR。

当 Meta 的机械反射表面与写入规则不同（最典型是 `partyType`）时，本文同时记录两者，
Go Meta 要对拍旧 JSON，REST 写入口仍须执行旧 Resource 的收窄校验。

## 范围

| Grid 资源 | Elixir Resource | 表/视图 | 外部权限 |
|---|---|---|---|
| `salReconciliations` | `SynieCore.Sales.Reconciliation` | `sal_reconciliation` | `sales.reconciliation:*` |
| `salReconciliationItems` | `SynieCore.Sales.ReconciliationItem` | `sal_reconciliation_item` | 复用 `sales.reconciliation:*` |
| `salCompanyAccountDefaults` | `SynieCore.Sales.CompanyAccountDefault` | `sal_company_account_default` | 读 `sales.setting:read`；写 `sales.setting:update` |
| `purReconciliations` | `SynieCore.Purchase.Reconciliation` | `pur_reconciliation` | `purchase.reconciliation:*` |
| `purReconciliationItems` | `SynieCore.Purchase.ReconciliationItem` | `pur_reconciliation_item` | 复用 `purchase.reconciliation:*` |
| `scmOrderFlowItems` | `SynieCore.Scm.OrderFlowItem` | 只读视图 `scm_order_flow_item` | 四个来源 read 权限任一 |

对账不能作为孤立 CRUD 迁移。两个头动作会在同一事务内调整标准/委外履约行
`reconciledQty`，赠送/样品结单还调用 GL，常规单确认/撤回调用待办；VAT 发票模块通过
内部 close/reopen seam 改对账单状态。订单历史则直接依赖 PR-2.15 四类履约表的当前事实。

证据：
`sales/reconciliation.ex`、`sales/reconciliation_item.ex`、
`purchase/reconciliation.ex`、`purchase/reconciliation_item.ex`、
`sales/company_account_default.ex`、`scm/order_flow_item.ex`，
以及 `20260721075827_add_sal_reconciliation.exs`、
`20260721141448_add_purchase_reconciliation.exs`、
`20260724164203_outsourced_receipt.exs`、
`20260725024000_create_scm_order_flow_item.exs`。

## 可复现捕获与旧基线

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_supply_reconciliation_contract.exs \
  ../.scratch/migration/snapshots/pr-2.16

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/sales/reconciliation_test.exs \
  apps/synie_core/test/synie_core/purchase/reconciliation_test.exs \
  apps/synie_core/test/synie_core/sales/company_account_default_test.exs \
  apps/synie_core/test/synie_core/scm/order_flow_item_test.exs
```

捕获脚本为 6 个资源各生成 `superadmin`、`read-only` 两份 JSON，共 12 份。read-only
Actor 固定只持：

- `sales.reconciliation:read`
- `purchase.reconciliation:read`
- `sales.setting:read`
- `sales.delivery:read`（作为订单历史四个来源 read 权限中的一个）

这组权限刻意让权限敏感的 ref 降级结果可复现；例如销售对账行的
`deliveryItemId` 仍为 ref，而采购对账行的两个入库来源降为 string。

2026-07-26 在真实 PostgreSQL/Ecto SQL Sandbox 上复跑结果为 **50 passed**：
销售对账 21、采购对账 20、公司默认科目 6、订单历史 3。旧套件覆盖状态机、金额链、
默认科目、GL、待办/发票联动、剩余量锁内复核、标准履约作废闸和视图/权限；它没有
双连接并发压力测试，因此 Go 仍须以真实 PG 补同单动作竞争与跨单剩余量竞争。

GraphQL 的稳定序列化表面：

- list 是 `{count, results}`，offset pagination 默认 20、最大 200；
- mutation 是 `{result, errors {message}}`；
- UUID/ID 是 JSON string；
- Decimal 由 Absinthe `Decimal` scalar 输出为 string 以保精度，输入可接 string、
  integer 或 float；
- Date 是 `YYYY-MM-DD`，DateTime 是带 UTC `Z` 的 ISO-8601 string；
- enum 输出为大写 GraphQL token，例如 `GIFT_SAMPLE`、`CONFIRMED`；
- 可空字段输出 `null`，不可把缺值改成空字符串或数值 0。

字段顺序、类型、标签、filter/sort、enum、ref 降级、capability、extended action 与
destroy mutation 的唯一精确真值是 12 份 snapshot；下文只作人读摘要。

## GridMeta 精确摘要

### 对账头：销售与采购各 16 列

两侧顺序相同：

`id, reconciliationNo, reconciliationType, partyType, partyId, postingDate,
remarks, status, insertedAt, updatedAt, companyId, debitAccountId, creditAccountId,
createdById, grossTotal, baseGrossTotal`

- `reconciliationType` 固定：
  `REGULAR/常规`、`GIFT_SAMPLE/赠送/样品`。
- 状态固定：
  `DRAFT/草稿`、销售或采购语义的 `CONFIRMED`、`CLOSED/已结单`、
  `VOIDED/已作废`。
- `partyType` Meta 机械反射四值
  `SUPPLIER/CUSTOMER/COMPANY/EMPLOYEE`；销售写入口只允许
  `CUSTOMER/COMPANY`，采购只允许 `SUPPLIER/COMPANY`。
- superadmin 的 `partyId` poly-ref：销售只含 `salCustomers/basCompanies`，
  采购只含 `purSuppliers/basCompanies`；read-only 因没有这些引用资源的 read 权限，
  `partyId` 降为 string。
- superadmin 的 company、两科目、createdBy 都是 ref；read-only 全降 string。
- 除 `id` 不可筛、`grossTotal/baseGrossTotal` 不可筛不可排外，其余普通列都可筛可排；
  `partyId` 和普通 FK 可筛但不可排。`id` 可排。
- superadmin capability 顺序固定为
  `create/update/delete/confirm/unconfirm/audit/void`；read-only 为空。
- 两侧即使 read-only capability 为空，extended actions 仍机械存在，顺序为：
  `confirm`（非危险）、`unconfirm`（危险）、`audit`（非危险）、`void`（危险）。
  UI/REST 必须再用 capability/权限门控。
- 销售 mutation：
  `confirmSalReconciliation`、`unconfirmSalReconciliation`、
  `auditSalReconciliation`、`voidSalReconciliation`；
  destroy 为 `destroySalReconciliation`。
- 采购 mutation：
  `confirmPurReconciliation`、`unconfirmPurReconciliation`、
  `auditPurReconciliation`、`voidPurReconciliation`；
  destroy 为 `destroyPurReconciliation`。

证据：两份 Reconciliation Resource 的 `permission_actions/0`、`grid_actions/0`、
attributes/relationships/aggregates，以及
`{sal,pur}Reconciliations.*.grid.json`。

### 销售对账行：19 列

顺序：

`id, idx, qty, baseQty, amount, baseAmount, remarks, insertedAt, updatedAt,
reconciliationId, companyId, deliveryItemId, reconciliationNo,
reconciliationStatus, deliveryNo, deliveryDate, materialName, unitName,
orderCurrencyCode`

- capability、extended action 都为空；destroy mutation 为
  `destroySalReconciliationItem`。
- superadmin 的父单、公司、发货行均为 ref。固定 read-only Actor 因同时持
  `sales.delivery:read`，父单与发货行仍为 ref，公司降为 string。
- `id` 不可筛但可排；所有 decimal/文本/日期/calculation 均可筛可排；
  FK 可筛不可排。
- 默认读取 `idx ASC`；调用方显式 sort 时覆盖默认。
- `reconciliationNo/status`、`deliveryNo/date`、物料名、单位名、订单币种代码都是
  calculation，不是本行冻结的新快照；物料与价税真值仍来自发货行快照。

证据：`sales/reconciliation_item.ex` 的 `grid_calculations/0`、read prepare、
actions/attributes/calculations，以及两份销售行 snapshot。

### 采购对账行：20 列

顺序：

`id, idx, qty, baseQty, amount, baseAmount, remarks, insertedAt, updatedAt,
reconciliationId, companyId, receiptItemId, outsourcedReceiptItemId,
reconciliationNo, reconciliationStatus, receiptNo, receiptDate, materialName,
unitName, orderCurrencyCode`

- capability、extended action 都为空；destroy mutation 为
  `destroyPurReconciliationItem`。
- superadmin 的父单、公司、标准入库行、委外入库行都是 ref。固定 read-only Actor 只让
  父单保留 ref，另外三个降为 string。
- filter/sort 规则与销售行一致；默认 `idx ASC`。
- 两个来源 ID 可空但数据库要求**恰一非空**；REST 不能把它放宽成可同时为空/同时有值。
- calculation 按恰一来源在标准入库行与委外入库行之间选择相同口径字段。

证据：`purchase/reconciliation_item.ex` 的 `receipt_item_exactly_one`、read prepare、
calculations，以及两份采购行 snapshot。

### 公司默认过账科目：8 列

顺序：

`id, insertedAt, updatedAt, companyId, deliveryDebitAccountId,
deliveryCreditAccountId, receiptDebitAccountId, receiptCreditAccountId`

- 8 列中仅 `id` 不可筛；时间可筛可排，5 个 FK 可筛不可排，`id` 可排。
- superadmin 的 5 个 ID 都是 ref；固定 read-only Actor 全降 string。
- **superadmin 与 read-only 的 capability 都为空，extended action 为空，
  `destroyMutation=null`。**
- 旧 GraphQL 只有 list、create、update；**没有 destroy 动作**。REST 不得凭通用
  ResourceClient 习惯擅自增加 DELETE。
- 无声明默认排序。

证据：`sales/company_account_default.ex` actions/policies/relationships，
`SynieCore` GraphQL 注册，以及两份公司默认 snapshot。

### 订单收发货历史：14 列

顺序：

`id, flowType, voucherNo, voucherDate, status, qty, materialCode, materialName,
materialSpec, customerPartNo, unitName, orderId, orderItemId, companyId`

- 所有列都是普通值，没有 ref；capability/action/destroy 全为空。
- `id` 是 `"flow_type:source_row_uuid"`，不是 UUID。例如
  `outsourced_issue:<uuid>`。
- `flowType` 固定：
  `PURCHASE_RECEIPT/采购入库`、`OUTSOURCED_ISSUE/委外发料`、
  `OUTSOURCED_RECEIPT/委外入库`、`SALES_DELIVERY/销售发货`。
- `status` 固定 `DRAFT/AUDITED/VOIDED`；视图不隐藏草稿或已作废记录。
- `id`、flow、单号、日期、状态、数量、5 个快照文本都可筛可排；
  `orderId/orderItemId/companyId` 在 Meta 中是 string、不可筛但可排。
  但旧 Ash 资源与真实测试会直接按 `orderId` 过滤；迁移后的专用历史端点必须保留这一
  必需过滤能力，即使不能靠通用 Meta 筛选器暴露。
- 默认排序 `voucherDate DESC, id ASC`；显式 sort 覆盖。
- 数量始终取来源业务行正数，不用符号表达出入方向。

证据：`scm/order_flow_item.ex`、`20260725024000_create_scm_order_flow_item.exs`、
`scm/order_flow_item_test.exs` 与两份历史 snapshot。

## GraphQL CRUD/动作表面

旧注册的 list query：

- `salReconciliations`
- `salReconciliationItems`
- `salCompanyAccountDefaults`
- `purReconciliations`
- `purReconciliationItems`
- `scmOrderFlowItems`

销售对账头 mutations：

- `createSalReconciliation`
- `updateSalReconciliation`
- `destroySalReconciliation`
- `confirmSalReconciliation`
- `unconfirmSalReconciliation`
- `auditSalReconciliation`
- `voidSalReconciliation`

销售行 mutations：

- `createSalReconciliationItem`
- `updateSalReconciliationItem`
- `destroySalReconciliationItem`

采购侧为同名 `Pur` 版本。公司默认只有
`createSalCompanyAccountDefault/updateSalCompanyAccountDefault`。订单历史没有 mutation。

页面旧保存语义是“先保存头，再逐行顺序调用独立 mutation”：先删除移除行，再新增/更新；
某行失败会汇总行错误，但已经成功的头或其他行不会回滚。这是兼容事实，不是聚合原子保存。
Go 可另给聚合 endpoint，但 6 个独立 Resource 的 CRUD 表面仍应保留；动作必须是头级专用
endpoint，`reconciledQty`、GL、待办与发票状态 seam 不能开放为任意外部 update。

证据：`SynieCore` GraphQL queries/mutations 注册，以及两个
`-reconciliation-drawer.tsx` 的 `persistItems`。

## 对账头共用不变量

- 单号必填、最多 32、销售/采购各表全局唯一；留空分别由
  `sales.reconciliation` / `purchase.reconciliation` 的启用编号规则取号，手填原样保留。
- 公司必填且创建后不可换；创建时须 CompanyAccessible。
- 类型必填且创建后锁死。
- Party 两列必填、须同时存在；内部公司不能等于单据公司。销售只允许客户/内部公司，
  采购只允许供应商/内部公司。
- 两科目草稿保存即必填、本公司、启用、非汇总：
  - 销售贷方强制 `UNBILLED_RECEIVABLE`，借方角色不限；
  - 采购借方强制 `UNBILLED_PAYABLE`，贷方角色不限。
- create 对客户端未显式传入的科目按公司默认补：
  - 销售借方 ← 默认发货贷方，销售贷方 ← 默认发货借方；
  - 采购借方 ← 默认入库贷方，采购贷方 ← 默认入库借方。
  手填优先；默认缺失后仍由必填校验拒绝。
- remarks 可空、最多 512；createdBy 从 Actor 写入。
- postingDate 不在普通 create/update accept 中，只由赠送/样品 `audit` 动作接收；
  未传时旧实现无条件写结单当天。零金额单也会留下 postingDate，只是不会生成 GL。
- 仅草稿可普通 update/delete。已有任一行后 Party 类型/ID 冻结，须先删行；单号、科目、
  remarks 仍可改。
- 头 update/delete、四个动作与行 create/update/delete 都在事务内
  `FOR UPDATE` 锁父头并复查状态，动作与行编辑串行。
- aggregate `grossTotal/baseGrossTotal` 分别求所有行 `amount/baseAmount` 之和。

证据：两份头 Resource 的 validation/change/action/aggregate 实现及编号/Party/科目复用
validation。

## 对账行绑定、金额、候选与权威复检

共用：

- 行仅能编辑草稿父单；create 从父单派生 company，update 不可换父单。
- `idx` 必填 integer，但无正数或同父唯一约束；`qty > 0`；remarks 最多 512。
- create/update 都先锁父单，再锁来源履约行。
- `baseQty = round(qty × source.baseQty ÷ source.qty, 6)`；源 qty 为 0 的防御分支直接用
  qty。
- `amount = round(qty × source.orderPrice, 2)`；
  `baseAmount = round(amount × sourceOrder.exchangeRate, 2)`。
- 金额、baseQty 是服务端受控列，不接受客户端直接写。
- 同一对账单所有来源订单原币代码必须一致。
- 保存时即要求本行 baseQty 不大于来源
  `baseQty - reconciledQty`；confirm/audit 生效时再锁来源行并按来源分组汇总复核，
  防两个草稿竞争同一余额。
- 同一来源可拆成同单多行；生效时必须先分组求和，不能逐行读取同一个旧投影。

销售：

- 来源必为已审核未作废销售发货行；发货头公司、Party 必须等于对账头。
- 常规单拒绝样品订单来源和 `orderPrice <= 0`；赠送/样品不限。
- 候选页面固定筛：
  `deliveryStatus=AUDITED`、company/party 等于头、
  `remainingReconcilableQty>0`、若已有行则同币种；常规再筛
  `orderPrice>0` 与源订单 `orderType!=SAMPLE`。

采购：

- 来源是标准采购入库行或委外入库成品行，恰一；父入库必须已审核未作废，公司、Party
  必须等于对账头。
- 常规单只拒绝 `orderPrice <= 0`，没有样品订单来源规则；赠送/样品不限。
- 两种来源共享同单币种约束，可在一张采购对账单内混合，只要币种一致。
- 标准与委外候选页面都固定筛：
  `receiptStatus=AUDITED`、company/party 等于头、
  `remainingReconcilableQty>0`、若已有行则同币种；常规再筛 `orderPrice>0`。

候选过滤只改善录入体验，不能替代行保存和动作锁内复检。草稿不占用
`reconciledQty`，所以多张草稿可看到同一候选。

证据：两份 Item Resource 的 Sync/Bind change，以及两个对账抽屉的 fixedFilter。

## 两类型状态机、GL、投影与待办

### 常规单

销售/采购都走：

`DRAFT --confirm--> CONFIRMED --invoice seam--> CLOSED`

- confirm 只允许常规草稿且至少一行；在来源行锁内复核剩余量后，把每组 baseQty 加到来源
  `reconciledQty`。
- 销售确认同事务新建 `ISSUE_INVOICE` 待办，采购新建 `RECEIVE_INVOICE` 待办；
  sourceType 分别为 `sales.reconciliation` / `purchase.reconciliation`，保存源单号、
  company、Party、本币合计与操作人。
- unconfirm 只允许常规 CONFIRMED 且**没有任何仍引用本单的发票，包括草稿发票**；
  减回投影并关闭 active 待办，原因 `unconfirm`。
- 常规确认/撤回不写 GL。CLOSED 不是用户 action：VAT 发票审核调用内部
  `close_from_invoice`，关闭待办；发票作废/红冲先解除引用再调用
  `reopen_from_invoice`，退回 CONFIRMED 并新建 active 待办，旧 closed 待办留历史。
- 常规 CLOSED 没有独立 void。旧 Meta 虽机械列出 `void`，调用会明确拒绝并要求从发票侧
  作废/红冲。

VAT 发票的金额、一对一、方向、公司/Party 校验和五笔分录属于发票资源，但 close/reopen
是本次对账模块必须保留的内部接口，不能等迁发票时再临时跨表改状态。

### 赠送/样品单

销售/采购都走：

`DRAFT --audit--> CLOSED --void--> VOIDED`

- audit 只允许赠送/样品草稿且至少一行；先消费来源 `reconciledQty`，再按行
  `baseAmount` 求和并最终 round 2。
- 金额 `<= 0` 跳过 GL；金额大于 0 写恰好两条：
  - 销售：借头 debit（不带 Party），贷头 credit（带 Party），voucher type
    `sales.reconciliation`；
  - 采购：借头 debit（带 Party），贷头 credit（不带 Party），voucher type
    `purchase.reconciliation`。
- 每条 GL currency 取对应科目自身 currencyId；remarks 为 null；postingDate 取 audit
  输入或动作补的当天。
- void 只允许赠送/样品 CLOSED；调用 GL `cancel!`（不是 reverse/红冲），再减回所有来源
  `reconciledQty`，最后置 VOIDED。零金额空分录组 cancel 也成功。
- 动作的投影、GL、状态和通用审计同事务；任一步失败全部回滚。

证据：两份 Reconciliation 的 confirm/unconfirm/audit/void、
`post_gift_gl!/cancel_gift_gl!`、adjust helpers，以及 `sys/todo.ex` 生产者 API。

## 公司默认过账科目

- 一公司一行，数据库 unique company；company 创建后不可换。
- 四槽都可空：
  `deliveryDebit/DeliveryCredit/ReceiptDebit/ReceiptCredit`。
- 槽位有值时都须本公司、启用、非汇总；发货借方额外强制
  `UNBILLED_RECEIVABLE`，入库贷方额外强制 `UNBILLED_PAYABLE`。
- create 接 company 与四槽；update 只接四槽。部分 update 不覆盖未传入的另一侧槽，
  因此销售/采购设置 Tab 可独立保存。
- 不提供 delete；“清配置”是把四槽更新为 null，不是删行。
- 外部 read 使用 `sales.setting:read`，create/update 都使用
  `sales.setting:update`；普通 Actor read/update 叠加 CompanyScope，create 走输入公司
  CompanyAccessible。
- 设置默认只影响以后 create 的代入；不追溯既有履约/对账单。

证据：公司默认 Resource、公司默认科目 ADR、迁移
`20260721023559_company_account_default_and_required_accounts.exs` 与 6 条旧测试。

## 订单收发货历史视图

视图是 `UNION ALL` 四臂：

| flowType | 来源行/头 | order 锚点 | customerPartNo |
|---|---|---|---|
| `PURCHASE_RECEIPT` | `pur_receipt_item/pur_receipt` | 经 `pur_order_item` | 行快照 |
| `OUTSOURCED_RECEIPT` | `pur_outsourced_receipt_item/...receipt` | 经 `pur_order_item` | 行快照 |
| `OUTSOURCED_ISSUE` | `pur_outsourced_issue_item/...issue` | 经 `pur_order_item_material` 桥接 | 恒 null |
| `SALES_DELIVERY` | `sal_delivery_item/sal_delivery` | 经 `sal_order_item` | 行快照 |

- 视图不落库，不产生独立审计，不允许 create/update/delete。
- 行 ID 以 flow type 为前缀避免四表 UUID 命名空间碰撞。
- 历史行直接反映来源头当前 status；来源作废后历史仍在但状态变 VOIDED。
- 持以下任一权限即可读：
  `purchase.receipt:read`、
  `purchase.outsourced_issue:read`、
  `purchase.outsourced_receipt:read`、
  `sales.delivery:read`。
  不存在 `scm.order_flow:read` 目录项。
- 上述 OR 权限之后还必须通过 CompanyScope；无公司授权返回空集。superadmin bypass。
- 采购订单抽屉按 orderId 能看到前三类；销售订单抽屉按 orderId 看销售发货。未来新增退货
  要扩视图 UNION 臂与 FlowType enum，不应在客户端拼多个查询。

证据：订单历史 ADR、Resource policies、视图迁移和 3 条旧测试。

## 权限、公司范围、审计与 REST 门槛

- superadmin bypass。
- 销售/采购头权限目录都是
  `create/read/update/delete/confirm/unconfirm/audit/void`。
- 行资源不进权限目录，但动作名仍映射父前缀：
  read/create/update/destroy 分别复用 `read/create/update/delete`。
- 头 read/update/delete/confirm/unconfirm/audit/void 叠加 CompanyScope；create 校验输入公司。
  行 create 从父头派生 company 再做 CompanyAccessible；read/update/delete 以行冗余
  company 做范围过滤。
- 公司默认和订单历史使用前文的特殊权限映射，不得改成通用资源前缀。
- REST 必须权限先行：无权限先于 JSON 业务解码和记录存在性返回；single 越公司表现
  not-found，list 只返回授权公司，空 company scope 返回空集。
- 对账头/行和公司默认都挂通用 Audit Fragment；外部 CRUD/动作保留字段级审计。
  头 destroy 由 FK cascade 删除行，不伪造逐行 destroy 审计。只读视图无审计写入。

证据：各 Resource policies/permission functions、通用 HasPermission 动作映射与 Audit
Fragment。

## 过滤、排序与序列化验收

迁移后的结构化过滤至少覆盖旧页面与 Meta 所声明的类型：

- 对账头：编号、类型、Party、postingDate、状态、时间、company、科目、createdBy；
- 对账行：父 ID、来源履约行 ID、idx、qty/baseQty/amount/baseAmount、日期与所有 calculation；
- 默认科目：company 精确筛；
- 订单历史：至少 orderId/orderItemId/company、flowType、voucherNo/date、status 与物料字段。

注意 `scmOrderFlowItems` 的 Meta 把三个 UUID 锚点呈现为不可筛 string，但旧订单抽屉必须按
orderId 读取；REST 可用专用 `/orders/{id}/history` 或显式 query filter 保留行为，不能机械
照 Meta 去掉能力。

排序必须允许显式多列并保持稳定分页；行默认 idx 升序，历史默认
voucherDate 降序再 id 升序。头和默认配置旧 Resource 没有声明默认 sort，Go 为稳定分页
若补 `insertedAt/id` 次序属于传输层确定性，不得改变显式 sort 语义。

所有 Decimal 必须按 string 输出，保留数据库/Decimal 的尾数表示；不得先转 float。
日期与 datetime 遵循前文格式；enum 必须大写；Party 类型应在响应中统一大写。

## 并发线性化与 Go 模块 seam

两个方向高度对称，适合一个深的 reconciliation module，以受控 side 配置表达：

- 权限/编号/voucher type、Party 范围、来源表、强制科目角色、GL Party 侧；
- 来源可为销售单一表，或采购标准/委外二选一；
- 同一个公共接口拥有头/行 CRUD、confirm/unconfirm/audit/void 与 invoice close/reopen；
- HTTP adapter 只做权限、DTO 与错误映射，不自行拼投影/GL/待办。

旧实现的线性化点：

1. 父对账头 `FOR UPDATE`；
2. 来源履约行按来源键锁定；
3. 调整 `reconciledQty`；
4. GL/待办；
5. 状态与审计。

旧 `Enum.group_by` 没有显式稳定锁序；Go 必须按来源类型再 UUID 稳定排序，且 add/sub 使用
同一顺序。真实 PG 至少证明：

- 同一头并发 confirm/audit 只有一次成功；
- 动作与行编辑串行，动作看到完整稳定行集；
- 两张单竞争同一来源剩余量时只有余额允许者成功；
- 同单多行同来源先分组，不丢增量、不超量；
- audit/void 的 GL、投影、状态、待办/审计无半截提交；
- 发票 close/reopen 与 unconfirm 竞争时，不在错误状态提交。

公司默认科目是独立小模块，提供按公司 Get/Upsert，不应埋进 HTTP handler；标准履约与对账
共用它的只读 seam。订单历史是单一 SQL read model，不应复制四套查询到客户端。

## PR-2.16 本范围完成门槛

- 12 份 Meta JSON 逐语义对拍，钉住列顺序、类型、enum、ref 降级、capability/action 和
  destroy（尤其默认科目无 DELETE）。
- 6 资源 sqlc/Go/OpenAPI/ResourceClient 完成；目标页面与订单历史目标会话
  `/graphql=0`。
- 对账头/行完整 CRUD、四动作、公司默认 Get/Upsert、订单历史 read；发票 close/reopen、
  待办和履约 `reconciledQty` 使用内部 seam。
- 真实 PG 覆盖两方向 Party/科目/默认/编号、双来源、币种、类型不对称、金额/舍入、
  状态机、投影、GL Cancel、待办、发票 seam 与前述并发。
- 真实 REST 覆盖权限先行、single/list/all/empty company scope、结构化候选过滤、
  Decimal/date/enum 序列化、6 Meta、动作与无 DELETE 表面。
- Chromium 至少覆盖销售常规确认/撤回、销售赠送结单/作废、采购标准+委外混合对账、
  设置两 Tab 不互相覆盖，以及销售/采购订单统一收发货历史；目标业务会话 GraphQL 为零。
- 固定 Go 容器下全量 Go、OpenAPI、typecheck、前端测试/check/build/Chromium 通过；
  删除旧实现前本契约四份旧测试保持 **50 passed**。
