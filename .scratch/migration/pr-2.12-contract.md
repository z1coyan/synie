# PR-2.12 总账引擎与手工凭证迁移前契约

记录日期：2026-07-26。本文是迁移验收资产，不新增业务规则。领域术语沿用根
`CONTEXT.md` 中的「总账分录」「手工会计凭证」「红冲」「往来角色」「应收应付报表」；
旧 Elixir/Ash Resource、GL 深模块、真实 `GridMeta.build/2` 输出、PostgreSQL 约束与既有
产品文档共同构成本批迁移事实。Go 实现可以加固并发与接口，但不得把事实表开放为普通 CRUD，
也不得把调用方事务拆成“单据已生效、分录未落地”的半截状态。

## 范围

| Grid 资源 | Elixir Resource | 表 | 权限前缀 | 定位 |
|---|---|---|---|---|
| `accGlEntries` | `SynieCore.Acc.GlEntry` | `acc_gl_entry` | `acc.gl_entry` | 只读财务事实 |
| `accGlJournals` | `SynieCore.Acc.GlJournal` | `acc_gl_journal` | `acc.gl_journal` | 手工凭证头 |
| `accGlJournalLines` | `SynieCore.Acc.GlJournalLine` | `acc_gl_journal_line` | 复用 `acc.gl_journal` | 手工凭证行 |

本批同时交付以下非独立 Resource 表面：

- GL 深模块 `Post / Cancel / Reverse`；
- `accGlEntries` 下的应收应付时点报表；
- 会计凭证头行 CRUD、审核、取消；
- `/finance/journals`、`/finance/entries`、`/finance/ar-ap` 三个前端消费面。

本批不迁移发票、承兑、报销、销售/采购来源单据本身；但 GL 引擎和来源多态 Meta 必须保留
这些调用方的既有 `voucher_type` 注册，供后续批次直接接入。GL 深模块不是一个可由终端用户
任意调用的“记账 REST”，`Post / Cancel / Reverse` 只允许在拥有来源单据事务的领域服务内
调用。

主要一手来源：

- `backend/apps/synie_core/lib/synie_core/acc/gl.ex`
- `backend/apps/synie_core/lib/synie_core/acc/gl_entry.ex`
- `backend/apps/synie_core/lib/synie_core/acc/gl_journal.ex`
- `backend/apps/synie_core/lib/synie_core/acc/gl_journal_line.ex`
- `backend/apps/synie_core/lib/synie_core/acc/ar_ap_report.ex`
- `backend/apps/synie_core/lib/synie_core/acc/party_type.ex`
- `backend/apps/synie_core/lib/synie_core/acc/party_exists.ex`
- `backend/apps/synie_core/test/synie_core/acc/{gl_test,gl_entry_test,gl_journal_test,gl_journal_line_test,journal_flow_test,ar_ap_report_test}.exs`
- `docs/产品文档/总账财务.md`
- `docs/adr/2026-07-09-gl-entry.md`
- `docs/adr/2026-07-12-gl-entry-voucher-poly-fk.md`
- `docs/adr/2026-07-16-ar-ap-report.md`
- `CONTEXT.md`

## 可复现捕获与旧基线

Meta 捕获：

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_gl_contract.exs \
  ../.scratch/migration/snapshots/pr-2.12
```

捕获脚本为三个资源各生成 `superadmin` 与 `read-only` 两份 JSON，共 6 份：

- `accGlEntries.{superadmin,read-only}.grid.json`
- `accGlJournals.{superadmin,read-only}.grid.json`
- `accGlJournalLines.{superadmin,read-only}.grid.json`

read-only Actor 只持 `acc.gl_entry:read` 与 `acc.gl_journal:read`。因此快照不仅固定列，还固定
权限感知 FK 降级：无目标资源 read 权限时，目标 ref 被移除，列退化为普通 string；仍有
`acc.gl_journal:read` 时，凭证 ref 保留。

旧 GL/凭证核心五份测试已在真实 PostgreSQL/Ecto SQL Sandbox 上实跑，结果为 **43 passed**：

- `gl_entry_test.exs`：5；
- `gl_journal_test.exs`：8；
- `gl_journal_line_test.exs`：7；
- `journal_flow_test.exs`：8；
- `gl_test.exs`：15。

`ar_ap_report_test.exs` 另作为报表行为明细来源；迁移验收须在 Go/真实 PostgreSQL 中重新
覆盖，而不能只引用旧测试结论。捕获只反射 Resource，不创建业务数据。

## 三资源 GridMeta 精确契约

下表中的 `F/S` 分别表示 `filterable/sortable`；未列 enum/ref 即为 `null`。迁移后 Go Meta
必须与 6 份快照做 JSON 语义对拍，不能只比较列名。

### `accGlEntries`

- superadmin 与 read-only 都是 `capabilities=[]`、`destroyMutation=null`、
  `extendedActions=[]`；该资源没有用户写能力。
- 列数 18，顺序与属性固定：

| # | name | label | type | F/S |
|---:|---|---|---|---|
| 1 | `id` | id | string | false/true |
| 2 | `seq` | 序号 | integer | true/true |
| 3 | `postingDate` | 过账日期 | date | true/true |
| 4 | `debit` | 借方金额 | decimal | true/true |
| 5 | `credit` | 贷方金额 | decimal | true/true |
| 6 | `partyType` | 对手类型 | enum | true/true |
| 7 | `partyId` | 对手 | fk（降级时 string） | true/false（降级时 false/true） |
| 8 | `voucherType` | 来源单据类型 | string | true/true |
| 9 | `voucherId` | 来源单据 | fk | true/false |
| 10 | `voucherNo` | 来源单据编号 | string | true/true |
| 11 | `isCancelled` | 已作废 | boolean | true/true |
| 12 | `isReversed` | 已被红冲(原凭证状态) | boolean | true/true |
| 13 | `isReversal` | 红字冲销行 | boolean | true/true |
| 14 | `remarks` | 摘要 | string | true/true |
| 15 | `insertedAt` | 创建时间 | datetime | true/true |
| 16 | `companyId` | 公司 | fk（降级时 string） | true/false（降级时 false/true） |
| 17 | `accountId` | 科目 | fk（降级时 string） | true/false（降级时 false/true） |
| 18 | `currencyId` | 币种 | fk（降级时 string） | true/false（降级时 false/true） |

`partyType` enum 顺序固定为：
`SUPPLIER/供应商`、`CUSTOMER/客户`、`COMPANY/内部公司`、`EMPLOYEE/员工`。

superadmin 的 `partyId` 是以 `partyType` 判别的 enum 多态 FK，变体顺序固定：

1. `COMPANY → basCompanies(name)`，标签「内部公司」；
2. `CUSTOMER → salCustomers(name)`，标签「客户」；
3. `EMPLOYEE → hrEmployees(name)`，标签「员工」；
4. `SUPPLIER → purSuppliers(name)`，标签「供应商」。

superadmin 的 `voucherId` 是以 string `voucherType` 判别的多态 FK，变体顺序固定：

1. `acc.bill_transaction → accBillTransactions(docNo)`，承兑交易；
2. `acc.expense_report → accExpenseReports(docNo)`，报销单；
3. `acc.gl_journal → accGlJournals(voucherNo)`，凭证；
4. `acc.vat_invoice → accVatInvoices(docNo)`，增值税发票；
5. `purchase.outsourced_receipt → purOutsourcedReceipts(receiptNo)`，委外入库单；
6. `purchase.receipt → purReceipts(receiptNo)`，采购入库单；
7. `purchase.reconciliation → purReconciliations(reconciliationNo)`，采购对账单；
8. `sales.delivery → salDeliveries(deliveryNo)`，销售发货单；
9. `sales.reconciliation → salReconciliations(reconciliationNo)`，销售对账单。

superadmin 的普通 FK 为
`companyId → basCompanies(company,name)`、
`accountId → basAccounts(account,name)`、
`currencyId → basCurrencies(currency,name)`。

read-only 因没有对手主数据、公司、科目和币种 read 权限：

- `partyId/companyId/accountId/currencyId` 退化为 string；
- `voucherId` 仍为多态 fk，但只剩
  `acc.gl_journal → accGlJournals(voucherNo)` 一个可见变体。

### `accGlJournals`

- superadmin：
  `capabilities=["create","update","delete","audit","cancel"]`；
- read-only：`capabilities=[]`；
- 两者均有 `destroyMutation="destroyAccGlJournal"`；
- 两者均无条件保留如下动作描述符，顺序固定：
  1. `audit`，标签「审核」，row，mutation=`auditAccGlJournal`，`isDanger=false`；
  2. `cancel`，标签「取消」，row，mutation=`cancelAccGlJournal`，`isDanger=true`。

动作描述符可见不代表可执行；服务端权限仍是唯一安全边界。

列数 14，顺序与属性固定：

| # | name | label | type | F/S |
|---:|---|---|---|---|
| 1 | `id` | id | string | false/true |
| 2 | `voucherNo` | 凭证编号 | string | true/true |
| 3 | `date` | 单据日期 | date | true/true |
| 4 | `postingDate` | 过账日期 | date | true/true |
| 5 | `remarks` | 凭证备注 | string | true/true |
| 6 | `status` | 状态 | enum | true/true |
| 7 | `submittedAt` | 提交时间 | datetime | true/true |
| 8 | `insertedAt` | 创建时间 | datetime | true/true |
| 9 | `updatedAt` | 更新时间 | datetime | true/true |
| 10 | `companyId` | 公司 | fk（降级时 string） | true/false（降级时 false/true） |
| 11 | `createdById` | 编写人 | fk（降级时 string） | true/false（降级时 false/true） |
| 12 | `submittedById` | 提交人 | fk（降级时 string） | true/false（降级时 false/true） |
| 13 | `debitTotal` | 借方总金额 | decimal | false/false |
| 14 | `creditTotal` | 贷方总金额 | decimal | false/false |

`status` enum 顺序固定为
`DRAFT/草稿`、`AUDITED/已审核`、`CANCELLED/已取消`。
superadmin ref 为
`companyId → basCompanies(name)`、
`createdById → sysUsers(name)`、
`submittedById → sysUsers(name)`；
read-only 三列都退化为 string。

### `accGlJournalLines`

- superadmin 与 read-only 都是 `capabilities=[]`、`extendedActions=[]`；
- 两者均为 `destroyMutation="destroyAccGlJournalLine"`。

capability 为空表示该资源不独立进入权限目录，不能据此推断行没有 CRUD；行 CRUD 复用
`acc.gl_journal` 对应动作权限。

列数 13，顺序与属性固定：

| # | name | label | type | F/S |
|---:|---|---|---|---|
| 1 | `id` | id | string | false/true |
| 2 | `idx` | 行号 | integer | true/true |
| 3 | `debit` | 借方金额 | decimal | true/true |
| 4 | `credit` | 贷方金额 | decimal | true/true |
| 5 | `partyType` | 对手类型 | enum | true/true |
| 6 | `partyId` | 对手 | fk（降级时 string） | true/false（降级时 false/true） |
| 7 | `remarks` | 行备注 | string | true/true |
| 8 | `insertedAt` | 创建时间 | datetime | true/true |
| 9 | `updatedAt` | 更新时间 | datetime | true/true |
| 10 | `journalId` | 凭证 | fk | true/false |
| 11 | `companyId` | 公司 | fk（降级时 string） | true/false（降级时 false/true） |
| 12 | `accountId` | 科目 | fk（降级时 string） | true/false（降级时 false/true） |
| 13 | `currencyId` | 币种 | fk（降级时 string） | true/false（降级时 false/true） |

`partyType` enum、superadmin `partyId` 多态变体及顺序与 `accGlEntries` 完全相同。
`journalId → accGlJournals(journal,voucherNo)`。
superadmin 的 company/account/currency ref 与分录一致。read-only 保留 `journalId` ref，
其余四个目标列 `partyId/companyId/accountId/currencyId` 退化为 string。

## GL 深模块

### `Post`

输入：

- voucher 必须含
  `voucherType/voucherId/voucherNo/companyId/postingDate`；
- 每个 entry 含
  `accountId/currencyId/debit/credit/partyType/partyId/remarks`，红冲内部路径另可写
  `isReversal=true`。

普通过账必须满足：

- 至少两行；
- 每行借贷恰一边大于零，另一边为零；
- 全组借方合计等于贷方合计；
- `partyType/partyId` 同填同空；
- 每个科目存在、属于 voucher 公司、启用、非汇总；
- 挂往来角色的科目必须填对手；费用角色不强制对手；
- 往来角色为：`unbilled_receivable`、`receivable`、`advance_received`、
  `unbilled_payable`、`payable`、`advance_paid`、`other_payable`。

通过后按输入一行追加一条 `acc_gl_entry`，统一复制来源单据字段；`seq` 由数据库生成。
`Post` 本身不开始、不提交事务，由来源单据服务传入 transaction。普通调用不得传负数；
只有 `Reverse` 内部可使用 `allowNegative`，此时每行规则变为“借贷恰一边非零”。

GL 当前不规定“每个 voucher 全局只能 Post 一次”的事实表唯一约束。防重复应由来源单据状态
锁和动作幂等控制，不能擅自加会妨碍未来同一 voucher 分阶段写组的全局唯一索引。

### `Cancel`

- 输入为 `voucherType + voucherId`；
- 在调用方事务内把该来源单据当前全部分录标记 `isCancelled=true`；
- 不删除、不改金额、不制造反向行；
- 重复调用不应制造额外事实或失败，是幂等标记；
- 报表和余额消费侧过滤 `isCancelled=true`，明细查询仍返回这些行。

### `Reverse`

- 输入为 `voucherType + voucherId + 新 postingDate`；
- 锁定原有效分录组：同来源、未作废、未被红冲、且不是红字行；
- 没有可红冲原组时拒绝；重复红冲同样拒绝；
- 对原组逐行复制 account/currency/party，借贷金额各自取负；
- 新行 `isReversal=true`，日期取本次 postingDate，摘要为
  `红冲:<原摘要>`，原摘要空时为 `红冲`；
- 新红字组仍使用原 `voucherNo/companyId/voucherType/voucherId`；
- 红字组追加成功后把原组标记 `isReversed=true`；
- 原组与红字组都不标作废，两组在报表中自然对冲为零；
- 红字行豁免“往来角色必须有对手”，以允许历史遗留无对手分录完整对冲；
- 读取原组、追加红字组、标记原组必须在同一调用方事务内完成；Go 应以行锁/受影响行数
  关闭并发双红冲竞态。

### 总账分录事实边界

- `acc_gl_entry` 只追加，除 `is_cancelled/is_reversed` 生命周期标记外不修改；
- 用户没有 create/update/delete API；Grid 只有 query/get；
- 单据服务不得直接 SQL insert/update 该表，必须调用 GL 深模块；
- GlEntry 不写通用审计：它本身就是来源单据审核形成的财务事实，来源单据承担动作审计；
- `voucher_type/voucher_id` 是开放多态引用，无数据库真外键；`voucher_no` 冗余用于只读展示；
- 数据库硬约束至少保留：借贷恰一边非零、party 同空同有、company/account/currency 外键、
  `(voucher_type,voucher_id)` 与 `(company_id,account_id,posting_date)` 索引。

## 手工凭证与凭证行

### 凭证头

- `companyId` 创建必填、创建后不可换；`voucherNo` 最多 32，公司内唯一；
- 编号可手填；留空时按 `acc.gl_journal` 编号规则生成，无可用规则时明确报错；
- `date` 必填；`postingDate` 在草稿可空，审核时必须有，也可由审核动作补填/修正；
- `remarks` 最多 512；
- 默认 `status=DRAFT`；创建时 `createdById` 取当前 actor，`submittedById/submittedAt` 为空；
- `debitTotal/creditTotal` 是行聚合只读字段；
- 仅草稿可改头和物理删除；删除草稿头由数据库 cascade 删除行。

### 凭证行

- create 接受
  `journalId,idx,accountId,debit,credit,partyType,partyId,remarks`；
  update 不接受换 `journalId`；
- `companyId` 从父凭证复制，客户端不可写；
- `currencyId` 从科目复制，客户端不可写；科目没有币种时可空；
- 科目必须存在、与凭证同公司、启用、非汇总；
- 对手类型支持供应商、客户、内部公司、员工四类；类型与 ID 同填同空，并按类型验证主数据
  存在。多态关系没有数据库真外键；
- 草稿录入允许 `debit=0,credit=0`，但金额均不得为负，且不能两边同时大于零；
- `idx` 必填，主读默认按 `idx ASC`；旧数据库没有行号唯一约束，前端以
  `max(idx)+1` 分配新行，不应误写成服务端唯一规则；
- 只有父凭证仍为草稿时才可增删改行。

### 状态机与原子性

```text
DRAFT --audit--> AUDITED --cancel--> CANCELLED
```

- `DRAFT`：头行可改删，可暂存 0/0 行；
- audit：
  - `SELECT ... FOR UPDATE` 锁凭证并在事务内重读状态和全部行；
  - 至少两行、每行恰一边大于零、借贷配平；
  - 复检科目与往来对手规则；
  - 写 `status=AUDITED`、`submittedById`、`submittedAt`；
  - 同事务调用 `GL.Post`，voucher type 固定 `acc.gl_journal`；
  - 任一步失败，状态、提交字段和分录全部回滚，凭证保持草稿；
- audit 后头行全部锁死，重复审核拒绝；
- cancel：
  - 只接受 `AUDITED`；
  - 锁凭证并复检；
  - 若存在 `acc_bank_reconciliation.journal_id` 引用则拒绝，必须先解除对账；
  - 写 `status=CANCELLED` 并同事务调用 `GL.Cancel`；
  - 任一步失败整体回滚；
- `CANCELLED` 是终态，不可复审、不可再取消、不可改删；纠错另开新凭证。

头 update/delete、行 create/update/delete、audit/cancel 都必须在事务内锁同一凭证头，关闭
以下竞态：双审核、审核与改头、审核与删头、审核与行编辑、双取消。不能仅依赖请求开始时
读取到的 stale 状态。

## 权限与公司范围

### 权限码

- GlEntry 只登记 `acc.gl_entry:read`；应收应付报表复用此 read；
- GlJournal 登记：
  `acc.gl_journal:create/read/update/delete/audit/cancel`；
- GlJournalLine 不独立进权限目录，逐动作复用母资源：
  read/create/update/delete 对应 `acc.gl_journal:read/create/update/delete`；
- superadmin bypass；
- Meta capability 与动作描述符只是展示信息，REST 每个 handler 必须独立授权；
- 权限检查必须先于请求 JSON 解码：无权限 Actor 即使提交畸形 JSON 也返回 403，而不是
  暴露字段验证的 400。

### 公司范围

- GlEntry query/get 按 `company_id` 做 CompanyScope，Actor 无可见公司时 fail-closed；
- Journal query/get/update/delete/audit/cancel 按头 `company_id` 做 CompanyScope；
- Journal create 先校验目标公司在 Actor 可访问范围；
- Line query/get/update/delete 使用冗余 `company_id` 做 CompanyScope；create 从父凭证
  回填公司后校验目标公司；
- 应收应付报表的 `companyId` 是显式参数，泛型 action 不经过行级 CompanyScope，因此
  服务层必须手工做同口径公司授权，不能只校验 `acc.gl_entry:read`；
- `allCompanies=true` 与 superadmin 可访问全部公司；普通 Actor 只能访问 `companyIds`
  集合内公司。空集合必须返回空/403，不能漏成全公司。

## 审计

- `acc_gl_journal` 与 `acc_gl_journal_line` 接通用审计；
- 头 create/update/destroy 以及 `audit/cancel` 写 `sys_audit_log`，动作名保留真实
  `audit/cancel`，不能统一伪装成 update；
- 行 create/update/destroy 分别写审计；
- 删除草稿头时行由数据库 cascade，不额外伪造逐行 destroy 审计；头 destroy 是主记录；
- GlEntry 的追加、作废标记、红冲标记不写通用审计，避免把同一来源动作重复记成若干人工
  修改；其来源单据动作审计与分录事实共同构成追溯链；
- 应收应付报表与所有 read 不写审计；
- 本批无敏感字段脱敏例外；审计仍应只增不改不删。

## 应收应付报表

输入为 `companyId + asOf`，复用 `acc.gl_entry:read` 并强制公司范围。输出固定形状：

```json
{
  "asOf": "YYYY-MM-DD",
  "roleAccounts": {
    "receivable": [{"id": "uuid", "code": "1122", "name": "应收账款"}]
  },
  "rows": [{
    "partyType": "customer",
    "partyId": "uuid",
    "partyLabel": "客户甲",
    "balances": {"receivable": "100"},
    "netReceivable": "100",
    "netPayable": "0"
  }]
}
```

口径：

- 只读 `posting_date <= asOf` 且 `is_cancelled=false` 的 `acc_gl_entry`；
- 只圈定本公司挂往来角色的科目；费用角色与无角色科目不进入；
- 按 `partyType + partyId + accountRole` 聚合，同公司多个科目挂同角色时合并；
- 借方自然角色按 `debit-credit`，贷方自然角色按 `credit-debit`；
- `netReceivable = unbilledReceivable + receivable - advanceReceived`；
- `netPayable = unbilledPayable + payable + otherPayable - advancePaid`；
- 反向余额保留负数，不搬到对侧；
- 作废组过滤；红冲原组与红字组都保留并自然对冲；截至日之后的分录不计；
- 七个 `balances` key 都应可返回：
  `unbilledReceivable/receivable/advanceReceived/unbilledPayable/payable/advancePaid/
  otherPayable`；
- 全部角色余额为零的对手不出行；
- 历史无对手的角色分录聚合为 `partyType=null,partyId=null,partyLabel=未指定对手`，并排在
  最后，保证列合计与账面一致；
- 对手标签按 customer/supplier/company/employee 对应主数据批量回查；
- `roleAccounts` 按角色分组，组内按科目 code 排序，供前端下钻圈定 account IDs；
- 没有往来角色科目的公司返回 `roleAccounts={}`、`rows=[]`；
- decimal 一律以 JSON string 返回，不能转为浮点数。

## A/B/C/D 事务表面

### 手工会计凭证

| 类型 | 本批精确表面 |
|---|---|
| **A. Commands** | journal create/update/delete/audit/cancel；line create/update/delete；journal/line query/get |
| **B. 主表** | `acc_gl_journal`、`acc_gl_journal_line` |
| **C. 事实表写入** | audit 经 GL `Post` 追加 `acc_gl_entry(voucher_type='acc.gl_journal')`；cancel 经 GL `Cancel` 标记同组 |
| **D. 投影/系统列** | `status/submitted_at/submitted_by_id` 仅 journal 状态动作写；line `company_id/currency_id` 仅服务端派生；`debit_total/credit_total` 为只读聚合 |

audit 的 B/C/D 必须在一个事务中提交；cancel 的状态与事实标记也必须同事务。草稿头创建后由
前端逐行保存是现有交互，并不要求 create 与所有后续行请求跨 HTTP 组成一个长事务；但每个
行请求须锁父凭证并保持自身原子。

### 跨域来源单据调用 GL

| 类型 | 约束 |
|---|---|
| **A. Commands** | 来源单据自身的 audit/void/reverse 等动作 |
| **B. 主表** | 由来源模块拥有，如 `acc_vat_invoice`、`sales_delivery` |
| **C. 事实表写入** | 只能调用 GL `Post/Cancel/Reverse`，按注册的 `voucher_type` 写 `acc_gl_entry` |
| **D. 投影列** | 仍由来源模块服务写，GL 不反向直改来源表 |

事务由来源模块创建并传给 GL；GL 不自行提交。这样来源状态、来源投影和财务事实要么全部成功，
要么全部回滚。禁止 handler 或来源模块绕过 GL 直接写 `acc_gl_entry`。

### GL 自身生命周期列单写者

| 列/事实 | 唯一写入路径 |
|---|---|
| 分录新增 | `GL.Post`（`GL.Reverse` 内部亦回调 Post） |
| `is_cancelled` | `GL.Cancel` |
| `is_reversed` | `GL.Reverse` |
| `is_reversal=true` | `GL.Reverse` 生成红字行 |
| `seq` | PostgreSQL sequence/default |

Go 测试必须证明上述列不能从 GlEntry REST 请求覆盖，代码审查/静态扫描必须证明没有第二个
业务包直接 `INSERT/UPDATE acc_gl_entry`。

## REST/OpenAPI 与前端消费面

### 最小接口

OpenAPI 与生成客户端至少覆盖：

- GlEntry：query、get、应收应付 report；不得有 create/update/delete；
- GlJournal：query、get、create、update、delete、audit、cancel；
- GlJournalLine：query、get、create、update、delete；
- 通用 Meta：三个资源均可取；
- `Post/Cancel/Reverse` 不公开为终端用户 REST。

列表保持统一 `{count,results}`，查询使用 FilterState 同构的 POST query；decimal 字段全部为
string。DTO 至少保留以下 join，避免前端逐行补查：

- Journal：company、createdBy、submittedBy、借贷合计；
- Line：journal、company、account、currency；
- Entry：company、account、currency、party 多态显示、voucher 多态显示。

### 当前前端消费

- `/finance/journals`
  - Journal Grid/Drawer；
  - 行按 `journalId`、`idx ASC` 拉取；
  - 新行 create、存量变化 update、快照中删除行 destroy；
  - audit 对话框允许补过账日期；
  - cancel 由 Grid 扩展动作处理；
  - 草稿可编辑，已审核/已取消只读。
- `/finance/entries`
  - 只读 Grid/Drawer；
  - 公司、截至日、科目集合、对手多态筛选；
  - 来源单据多态链接；
  - 展示作废、已被红冲、红字行三个独立标记。
- `/finance/ar-ap`
  - 公司选择 + 截至日；
  - 应收/应付两个 tab；
  - 点击金额跳 `/finance/entries` 并预置
    `company/accountIds/party/asOf/isCancelled=false` 筛选；
  - `roleAccounts` 同时供说明与下钻使用。
- 银行对账抽屉也以 `accGlJournals` Meta/查询选择已审核凭证；迁移 Journal Resource Client
  时必须确保该消费者不回退到 GraphQL。
- RecordDrawer/RemoteSelect registry 中三个资源的 ref 与标签必须改用同一 REST client。

旧 Journal 页面自定义 `partyId` 输入当前只显式渲染供应商/客户，但领域与 Meta/API 支持
供应商、客户、内部公司、员工四类；传输迁移不得据此前端限制收窄服务端规则。旧 AR/AP 页面
应付 tab 当前不单列 `otherPayable`，但 report 必须继续返回该余额并计入 `netPayable`，为后续
展示保留完整口径。

目标页面和上述共享消费者迁移后，Chromium 会话内 `/graphql` 请求必须为 0；仅把三张主路由
换成 REST、却遗漏凭证行、公司候选、银行对账候选、来源/对手 RemoteSelect 或 AR/AP action，
均不算完成。

## 验收矩阵

### Meta 与权限

- 6 份快照逐 JSON 语义对拍：列顺序、label/type、F/S、enum、ref 降级、capability、
  destroyMutation、extendedActions 及动作顺序全量比较；
- read-only Actor 三资源 query 可读，capability 为空；
- journal/line 所有写动作与 report 的无权限拒绝；
- 畸形写 JSON 仍权限先行 403；
- company scope 覆盖单公司、多公司、allCompanies、空集合与跨公司 ID。

### GL 引擎与真实 PostgreSQL

- Post：少于两行、0/0、双边、负数、借贷不平、party 不成对；
- 科目不存在、跨公司、汇总、停用；往来角色缺对手；费用角色不要求对手；
- 正常 Post 精确行数、seq、来源引用、日期、金额和 decimal 精度；
- Cancel 全组标记、重复幂等、明细仍可查、报表过滤；
- Reverse 精确取负、摘要、日期、三标记、合计归零、无组/重复拒绝、历史无对手豁免；
- Reverse 并发最多一个成功，失败事务不留半组红字；
- caller-owned tx rollback 证明：来源状态失败时分录不落，分录失败时来源状态不变；
- 静态/包边界检查没有 GL 包外直接写 `acc_gl_entry`。

### 手工凭证与凭证行

- 头 CRUD、公司内编号唯一/跨公司可重复、自动编号/手填/无规则；
- createdBy、postingDate 草稿可空、remarks 长度、公司不可换；
- 行 company/currency 系统复制且请求不可覆盖；
- 行科目存在/同公司/启用/非汇总、party 四类型存在性与同空同有；
- 草稿 0/0 可存，负数/双边拒绝；
- 头行仅草稿可改删，删除头 cascade；
- audit 缺日期、少行、不平、行 0/0、无效科目、往来角色缺对手均拒绝且无分录；
- audit 成功状态/提交人/提交时间/来源分录全部落位；
- 重复 audit、并发 audit、audit 与头/行编辑或删除竞态；
- cancel 草稿拒绝、已审核成功、重复拒绝、终态冻结；
- 银行对账引用时 cancel 拒绝，解除后可取消；
- audit/cancel 的状态与分录副作用同事务回滚。

### 报表、审计、REST 与浏览器

- AR/AP：截至日、作废过滤、红冲归零、七角色自然方向、反向负数、净额、同角色多科目、
  全零过滤、未指定对手、四类对手标签、无角色空报表；
- 审计：头 create/update/destroy/audit/cancel，行 create/update/destroy；无 read/report
  日志、无 GlEntry 重复日志、cascade 不伪造逐行 destroy；
- REST 验收覆盖 6 Meta、三资源 query/get、完整凭证生命周期、report、权限先拒绝和公司范围；
- 所有测试夹具按 UUID/测试前缀精确清理，三业务表与相关审计残留为 0；
- OpenAPI 生成、Go 全量/真实 PG、前端 openapi/typecheck/test/check/build；
- Chromium 覆盖新建草稿凭证与两行、审核、分录可见、AR/AP 下钻、取消，并断言目标会话
  `/graphql=0`；
- 旧 `backend/` 只作为事实来源，不编辑、不删除。
