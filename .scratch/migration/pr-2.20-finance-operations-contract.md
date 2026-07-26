# PR-2.20 财务业务操作迁移前契约

记录日期：2026-07-26。本文只冻结旧 Elixir/Ash/GraphQL 与旧前端的实际表面，不新增
业务规则。范围严格为：

- `BankAccount`、`BankTransaction`
- `BankImportTemplate`、`BankImport`、`BankImportItem`
- `VatInvoice`
- `ExpenseReport`、`ExpenseReportItem`
- `Bill`、`BillTransaction`、`BillHolding`
- `BankReconciliation`

事实来源按优先级为：

1. 十二个旧 Ash Resource、其 validations/changes、银行导入 parser、`Reconcile`、
   `BillLedger` 与 GL 调用；
2. 真实 `SynieWeb.GridMeta.resolve/2` 与 GraphQL introspection 输出：
   `.scratch/migration/snapshots/pr-2.20/`；
3. 十三份 PostgreSQL migration、Ash resource snapshot 与真实 PostgreSQL/Ecto 测试；
4. `CONTEXT.md`、资金银行/发票/费用报销/票据产品文档、对应 ADR 与旧财务前端。

十二个资源都在 GridMeta 白名单内。旧运行时没有独立 `RecordMeta` resolver，查看/编辑
抽屉复用 GridMeta。因此本批冻结 12 × 2 = **24 份**真实 GridMeta、一份相关 GraphQL
introspection 和一份 resolver 表面说明，共 **26 份 JSON**。JSON 是字段顺序、类型、
label、筛排、ref、capability、action、destroy mutation 与 GraphQL input/output 的精确
真值；本文只作人读摘要。

## 可复现捕获与旧基线

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_finance_operations_contract.exs \
  ../.scratch/migration/snapshots/pr-2.20

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/acc/bank_account_test.exs \
  apps/synie_core/test/synie_core/acc/bank_import_template_test.exs \
  apps/synie_core/test/synie_core/acc/bank_import_parser_test.exs \
  apps/synie_core/test/synie_core/acc/bank_import_test.exs \
  apps/synie_core/test/synie_core/acc/vat_invoice_test.exs \
  apps/synie_core/test/synie_core/acc/expense_report_test.exs \
  apps/synie_core/test/synie_core/acc/bill_transaction_test.exs \
  apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs \
  apps/synie_web/test/synie_web/schema_grid_test.exs \
  apps/synie_web/test/synie_web/graphql_exposure_test.exs \
  --seed 0
```

2026-07-26 复跑结果：

- `synie_core`：**143 passed**
- `synie_web`：**44 passed**
- 合计：**187 passed**

同一脚本另捕获到临时目录后与入库快照 `diff -ru` 为零；临时目录也是 26 个文件。
当前 26 份入库 JSON 在快照目录内执行 `sha256sum *.json | sort -k2 | sha256sum` 的汇总
SHA-256 为 `c08b552f2d5ad6dada3315d632ccbf2fb99f78c23ee835c8afb49792ac6d54d8`。

## Actor、权限与公司范围

固定 read-only Meta Actor 持有本批八个独立 read 码，以及 Meta FK 所需的公司、科目、
文件、用户、客户、供应商、销售/采购对账单 read 码：

```text
acc.bank_account:read
acc.bank_transaction:read
acc.bank_import_template:read
acc.vat_invoice:read
acc.expense_report:read
acc.bill:read
acc.bill_transaction:read
acc.bill_holding:read
base.company:read
base.account:read
sys.file:read
sys.user:read
sales.customer:read
purchase.supplier:read
sales.reconciliation:read
purchase.reconciliation:read
```

这个 Actor 刻意没有任何写码，所以 12 份 read-only GridMeta 的 `capabilities` 均为空。
它也刻意没有 `hr.employee:read` 与 `base.currency:read`，对应 FK ref 按 GridMeta
fail-closed 退化；不得为了让快照“更好看”伪造权限。

权限与范围的精确归口：

| 资源 | 权限前缀 / 动作 | 公司范围 |
|---|---|---|
| BankAccount | `acc.bank_account` CRUD | `CompanyScope` |
| BankTransaction | `acc.bank_transaction` CRUD + `import/reconcile` | `CompanyScope` |
| BankImportTemplate | `acc.bank_import_template` CRUD | `CompanyScope` |
| BankImport / Item | 全部复用 `acc.bank_transaction:import` | `CompanyScope` |
| VatInvoice | `acc.vat_invoice` CRUD + `audit/void/reverse`；OCR 复用 create | `CompanyScope` |
| ExpenseReport / Item | 复用 `acc.expense_report` CRUD + `audit/void` | `CompanyScope` |
| Bill | `acc.bill` read/update/delete | 特殊 `BillCompanyScope` |
| BillTransaction | `acc.bill_transaction` CRUD + `audit/void`；OCR 复用 create | `CompanyScope` |
| BillHolding | `acc.bill_holding:read` | `CompanyScope` |
| BankReconciliation | read/remaining 复用流水 read；增删/quick create 复用 reconcile | `CompanyScope` |

`Bill` 自身没有 `company_id`；普通 Actor 只可见至少有一笔交易落在其可及公司中的票据，
没有可及公司时 fail-closed。其余资源公司字段均由用户输入或父记录派生并经可及公司校验。
超级管理员绕过 permission 与 scope。

## wire、分页与公开面

- 十二个 list query 都是 offset pagination：默认 limit 20、最大 200、可返回 count。
  除报销单的 `items` relationship 固定按 `idx ASC` 外，列表没有服务端默认稳定排序。
- UUID/ID 为 JSON string；Decimal 为 string；Date 为 `YYYY-MM-DD`；DateTime 为 UTC
  ISO-8601 string；可空值必须保持 `null`。
- GraphQL enum 使用大写 wire：
  - 导入：`PARSED/FAILED/IMPORTED`
  - 流水对账：`UNRECONCILED/PARTIAL/RECONCILED`
  - 发票方向：`INBOUND/OUTBOUND`
  - 发票状态：`DRAFT/AUDITED/VOIDED/REVERSED`
  - 发票种类：`SPECIAL/NORMAL/ELECTRONIC_SPECIAL/ELECTRONIC_NORMAL/
    DIGITAL_SPECIAL/DIGITAL_NORMAL`
  - 报销行：`INVOICED/MANUAL`；报销状态：`DRAFT/AUDITED/VOIDED`
  - 票据种类：`BANK_ACCEPTANCE/COMMERCIAL_ACCEPTANCE/FINANCE_COMPANY_ACCEPTANCE`
  - 承兑交易：`RECEIVE/ENDORSE/SETTLE/DISCOUNT/REALLOCATE`
  - 承兑交易状态：`DRAFT/AUDITED/VOIDED`
- GraphQL mutation 返回 `{result, errors {message}}`；OCR 两个 generic action 返回
  `JsonString`，不是对象。REST 可改成结构化 JSON，但字段、Decimal string 与空值语义
  不得缩水。
- introspection 精确捕获 **13 个 query**（12 个 list + `accBankReconciliationRemaining`）、
  **40 个 mutation**与 **349 个匹配类型**，expected missing 均为空。
- 必须继续不公开六个内部动作：
  `refreshReconcileAccBankTransaction/createAccBankImportItem/
  linkTransactionAccBankImportItem/registerAccBill/rebuildAccBillHolding/
  destroyAccBillHolding`。
- `Bill` 无 create mutation；`BankImportItem` 无 create mutation；`BillHolding` 无任何写
  mutation；`BankReconciliation` 无 update mutation。这些缺席本身是契约。

各 action 的输入字段、nullability、默认值、对象/分页/filter/sort 类型以
`graphql-surface.json` 为准，不能凭 Resource 的 accept 列表猜 wire。

## GridMeta 精确摘要

普通标量、FK、多态 FK 的类型/label/ref/filter/sort 均以 JSON 为准。read 不出现在
`capabilities`；下表只列 superadmin 的写能力。

| Grid | 列数 | superadmin capabilities | extended actions | destroy |
|---|---:|---|---|---|
| `accBankAccounts` | 13 | create/update/delete | 无 | `destroyAccBankAccount` |
| `accBankTransactions` | 16 | create/update/delete/import/reconcile | 无 | `destroyAccBankTransaction` |
| `accBankImportTemplates` | 21 | create/update/delete | 无 | `destroyAccBankImportTemplate` |
| `accBankImports` | 14 | 无 | 无 | `destroyAccBankImport` |
| `accBankImportItems` | 16 | 无 | 无 | `destroyAccBankImportItem` |
| `accVatInvoices` | 40 | create/update/delete/audit/void/reverse | audit/void/reverse | `destroyAccVatInvoice` |
| `accExpenseReports` | 14 | create/update/delete/audit/void | audit/void | `destroyAccExpenseReport` |
| `accExpenseReportItems` | 12 | 无 | 无 | `destroyAccExpenseReportItem` |
| `accBills` | 23 | update/delete | 无 | `destroyAccBill` |
| `accBillTransactions` | 28 | create/update/delete/audit/void | audit/void | `destroyAccBillTransaction` |
| `accBillHoldings` | 12 | 无 | 无 | 无 |
| `accBankReconciliations` | 7 | 无 | 无 | `destroyAccBankReconciliation` |

列顺序：

- BankAccount：
  `id,alias,bankName,branchName,holderName,accountNo,active,note,insertedAt,updatedAt,
  companyId,currencyId,accountId`
- BankTransaction：
  `id,occurredAt,income,expense,balance,counterpartyName,counterpartyAccount,summary,note,
  reconciledAmount,unreconciledAmount,reconcileStatus,insertedAt,updatedAt,companyId,
  bankAccountId`
- BankImportTemplate：
  `id,name,startRow,datetimeCol,datetimeFormat,dateCol,dateFormat,timeCol,timeFormat,incomeCol,
  expenseCol,amountCol,balanceCol,counterpartyNameCol,counterpartyAccountCol,summaryCol,
  noteCol,insertedAt,updatedAt,companyId,bankAccountId`
- BankImport：
  `id,status,error,importedAt,insertedAt,updatedAt,companyId,bankAccountId,templateId,fileId,
  createdById,importedById,itemCount,errorCount`
- BankImportItem：
  `id,rowNo,occurredAt,income,expense,balance,counterpartyName,counterpartyAccount,summary,note,
  error,insertedAt,updatedAt,importId,companyId,transactionId`
- VatInvoice：
  `id,docNo,direction,invoiceDate,postingDate,partyType,partyId,invoiceKind,invoiceCode,
  invoiceNo,sellerName,sellerTaxNo,sellerAddressPhone,sellerBankAccount,buyerName,buyerTaxNo,
  buyerAddressPhone,buyerBankAccount,items,netTotal,taxTotal,grossTotal,issuer,reviewer,payee,
  remarks,redInvoiceNo,status,auditedAt,insertedAt,updatedAt,companyId,partyAccountId,
  amountAccountId,taxAccountId,mirrorInvoiceId,salReconciliationId,purReconciliationId,
  createdById,auditedById`
- ExpenseReport：
  `id,docNo,expenseDate,postingDate,remarks,status,auditedAt,insertedAt,updatedAt,companyId,
  employeeId,paymentAccountId,createdById,auditedById`
- ExpenseReportItem：
  `id,idx,kind,summary,amount,remarks,insertedAt,updatedAt,reportId,companyId,invoiceId,
  expenseAccountId`
- Bill：
  `id,billNo,billKind,issueDate,dueDate,faceAmount,drawerName,drawerAccount,drawerBankName,
  drawerBankNo,payeeName,payeeAccount,payeeBankName,payeeBankNo,acceptorName,acceptorAccount,
  acceptorBankName,acceptorBankNo,transferable,acceptanceDate,remarks,insertedAt,updatedAt`
- BillTransaction：
  `id,docNo,transactionType,occurredOn,subStart,subEnd,amount,partyType,partyId,discountOrg,
  discountRate,interest,netAmount,postingDate,status,auditedAt,remarks,insertedAt,updatedAt,
  companyId,bankAccountId,toBankAccountId,billId,billAccountId,settleAccountId,
  interestAccountId,createdById,auditedById`
- BillHolding：
  `id,billNo,subStart,subEnd,amount,dueDate,acquiredOn,insertedAt,companyId,bankAccountId,
  billId,sourceTransactionId`
- BankReconciliation：
  `id,amount,insertedAt,updatedAt,companyId,bankTransactionId,journalId`

`BankImport.itemCount/errorCount` 是 aggregate；流水三个对账字段是持久化派生列；
`BillHolding` 全表是投影。它们都不能变成客户端可写字段。

## 银行账户、流水与导入

### 账户与流水

- 账户 `alias` 与 `accountNo` 分别同公司唯一；公司建后不可换。币种必填。绑定科目可空，
  非空时须同公司、启用、非汇总；科目若指定币种，必须与账户币种相同。
- 存在对账记录的账户禁止换绑或解绑科目；DB FK 也保护已有下游数据。退出方式是
  `active=false`，不是强删。
- 流水的 `income/expense` 恰一项且必须大于零，余额只是银行快照。create 要求本公司启用
  账户；update 允许继续使用停用账户以更正错录。
- `reconciledAmount/unreconciledAmount/reconcileStatus` 由对账增删和内部 refresh 维护。
  已对账流水不可删、不可换银行账户、不可收支换边，金额不能低于已对账额；金额变化后
  同事务刷新派生列。
- 账户、流水与下述模板/批次都接 Audit Fragment；审计记录随动作事务提交。

### 模板与 parser

- 模板名同公司唯一，账户必须同公司；列号只接受 A–Z/AA–ZZ，保存时 trim + uppercase；
  `startRow >= 1`，默认 2。
- 时间模式二选一：`datetimeCol + datetimeFormat`，或
  `dateCol + dateFormat` 加可选的 `timeCol + timeFormat`；两组不能混搭，缺时间按
  `00:00:00`。金额模式二选一：收入/支出双列（至少一个），或 signed `amountCol`。
- 日期时间、日期、时间预设分别为 10、8、4 个枚举值；完整 wire 与显示格式已在
  introspection 快照中冻结，不接受任意格式串。
- 支持真实 xlsx 与 BIFF8 xls，按魔数分流；伪装扩展名的 HTML/文本拒绝。原生日期/时间
  单元格优先，文本才按模板格式；本地时间按固定偏移转 UTC（当前默认 UTC+8）。
- 金额剥千分位/货币符号。双列 0/空视为未填、负数报错；signed 单列正收负支、0 报错。
  所配列全空的行静默跳过；行级解析/长度问题写 `error`，不阻断其他行。零数据行或超过
  5000 行是记录级失败。

### 批次与暂存行

- `createAccBankImport` 绑定公司、启用账户、该账户模板与 Actor 可读文件，提交即解析。
  成功落 `PARSED` 批次及全部 item；失败不回滚批次，落 `FAILED + error`。
- 同账户相同文件 SHA 已有非 failed 批次时拒绝；这是应用层先查，没有数据库 unique，
  两个并发 create 仍可能同时通过。
- Item 仅内部 create；公开只允许 parsed 父批次下 update/delete。每次写先
  `FOR UPDATE` 锁父批次，update 复用流水日期/单边金额规则并清掉 error。
- `importAccBankImport` 只接受 parsed；先锁批次，要求至少一行且无错误，逐行用 Actor
  创建流水并内部回填 transaction。执行人除 import 码还必须有
  `acc.bank_transaction:create`。任一行失败，流水、链接、批次状态全部回滚。
- imported 批次只读不可删；parsed/failed 可删，item 由 DB cascade。导入与行更新/删除
  由同一批次行锁串行；状态写 `IMPORTED`、`importedAt/importedBy`。

## 银行对账

- 对账记录是流水 ↔ 已审核凭证的 m-n 勾稽；`(bankTransactionId,journalId)` 唯一，
  无 update，调金额必须删除后重建。
- create 先由流水派生 company，再在事务内依次 `FOR UPDATE` 锁流水与凭证并权威复检：
  同公司、凭证已审核、银行账户已绑科目、凭证在正确方向含该科目、金额 > 0，且不超过
  流水剩余额度和凭证的“科目 × 借贷方向”剩余额度。
- 收入要求银行科目借方，支出要求贷方；内部转账的两个银行科目额度按科目和方向分开。
- `accBankReconciliationRemaining(bankTransactionId,journalId)` 带 Actor 读取两端并返回
  `min(流水剩余, max(凭证剩余, 0))`；缺 read 或越公司统一不可见。
- quick create 参数为流水、对方科目、金额、摘要、过账日；先锁流水，创建两行手工凭证，
  自动审核过账后建关联。对方科目不能等于银行绑定科目；还要求 Actor 有凭证 create/audit。
  凭证、分录行、GL、关联和流水派生列任一步失败整体回滚。
- create/destroy 的 after-action 在同一事务刷新流水三列。反向守卫同时禁止有对账的凭证
  cancel、流水 delete/换账户/换边/缩额，以及账户改绑科目。

## 增值税发票

- 公司内 `docNo` 唯一；非空 `invoiceNo` 以 `(invoiceCode,invoiceNo)` 公司内唯一，
  空号草稿不占唯一坑。单号留空走 `acc.vat_invoice` 自动编号；created/audited Actor 与
  UTC 时间由服务端写。
- 对手为 supplier/customer/company/employee 多态引用。内部公司不能是本公司；employee
  只允许 INBOUND 且不许任何销售/采购对账单。
- OUTBOUND 必须关联销售常规对账单；非员工 INBOUND 必须关联采购常规对账单；两类互斥。
  保存校验存在性，审核再锁定并检查确认态、公司/对手、金额完全相等与一票一单。
- 仅 DRAFT 可 update/delete。audit 必填过账日、票号、日期、三金额、往来/金额科目；
  `gross > 0`、`tax >= 0`、`net + tax = gross`，税额 > 0 时税额科目必填，所有科目走
  GL 同公司/启用/非汇总校验。
- 本票 GL：
  - OUTBOUND：Dr 往来 gross（带对手）/ Cr 金额 net / Cr 税额 tax。
  - INBOUND：Dr 金额 net / Dr 税额 tax / Cr 往来 gross（带对手）。
  - 税额为零时省税额行。
- 销售对账联动另写 Dr 对账借方科目 gross / Cr 对账贷方科目 gross（贷方带对手）；
  采购镜像为 Dr 对账借方（带对手）/ Cr 对账贷方。审核同事务把对账单结单并关闭待办。
- void 仅 AUDITED：取消原 GL，并解除/重开对账单。reverse 仅 AUDITED，必填 postingDate，
  `redInvoiceNo` 可空：GL Reverse 生成红字组，原组标 reversed，并解除/重开对账单。
  两者都是终态且互斥。
- 被非 voided 报销单挂票行引用时禁止 void/reverse。
- `items` 是 `JsonString` 中的销售清单快照，不是本批子资源；后端原样保存，不强制行汇总。
- OCR 只接受 Actor 可访问的 `fileId`，调用外部识别并返回 map，不写发票；复用 create 权限，
  错误转为可见的 `InvalidArgument`。旧前端保存成功后另行把 OCR 原图挂附件，挂接失败不
  回滚发票。

## 费用报销

- Report 单号同公司唯一，留空走 `acc.expense_report` 自动编号；公司、员工、付款科目
  必填，付款科目须本公司启用非汇总。仅 DRAFT 可改删。
- Item 的 company 从父单派生；写前锁父单且只允许 DRAFT；DB 对父单 cascade，对 invoice
  restrict。默认展示顺序 `idx ASC`。
- 两槽严格互斥：
  - `INVOICED`：只能填 invoice + remarks；invoice 必须是本公司、该员工、AUDITED
    INBOUND，且未被另一张非 voided 报销单引用。
  - `MANUAL`：invoice 必须空；summary、正 amount、本公司启用非汇总 expenseAccount 必填。
- audit 要过账日且至少一行，先 `FOR UPDATE` 锁 Report，再稳定锁涉及发票并权威复检。
  挂票行 Dr 发票 party account/gross（员工对手），无票行 Dr expense/amount，最后一行
  Cr payment account/总额；状态、审核人/时间、GL 与发票占用在一个事务内。
- void 仅 AUDITED，取消 GL 并置 VOIDED；item 不删，但 invoice 因“非 voided 引用”
  条件失效而恢复可用。无 reverse、反审核或部分核销。

## 承兑票据、交易与持有投影

### Bill

- 票号全局唯一，跨公司共享；无公开 create。接收交易的 `billAttrs` 走内部 `register`
  upsert：命中既有票只挂接、不覆盖票面。
- 票号、种类、到期日必填；票面金额可空，有值须 > 0；transferable 默认 true。票号建后
  不可改。存在任何交易（含草稿）后 dueDate/faceAmount/transferable 锁死。
- 其余票面字段可 update；只有完全无交易的遗留票据可 delete。

### BillTransaction 与 BillHolding

- create 时 RECEIVE 可在 `billId` 与 snake_case string-key `billAttrs` 二选一；其余四类
  必须 `billId`。`transactionType/companyId` 不在 update input。docNo 留空自动编号；
  created/audited Actor 与时间由服务端写。
- 段规则：`subEnd-subStart+1 = amount*100`，起点至少 1，金额 > 0；faceAmount 非空时
  `subEnd <= faceAmount*100`。字段使用 bigint，不能在 REST/前端转成 32-bit。
- RECEIVE/ENDORSE 必须 party；其余类型 party 为空。DISCOUNT 必填 org/rate/interest/net，
  rate/interest 非负、net > 0、`amount=interest+net`；非贴现四字段全空。
- REALLOCATE 必填同公司启用且不同于转出账户的 `toBankAccountId`；其他类型该字段为空。
  create 的本方账户同公司且启用，update 可保留停用账户作纠错。
- 仅 DRAFT 可 update/delete/audit；VOID 仅 AUDITED。update/delete/audit/void 都在动作事务
  内 `FOR UPDATE` 重读交易，防并发双审、审核后改删与双作废。
- 非调拨 audit 必填 postingDate、bill/settle 科目；贴现利息 > 0 时还要 interest 科目。
  RECEIVE/ENDORSE/DISCOUNT 不得晚于到期日；SETTLE 不得早于到期日；不得转让票禁止
  ENDORSE/DISCOUNT。
- GL：
  - RECEIVE：Dr bill amount / Cr settle amount（带对手）
  - ENDORSE：Dr settle amount（带对手）/ Cr bill amount
  - SETTLE：Dr settle amount / Cr bill amount
  - DISCOUNT：Dr settle net + 利息 > 0 时 Dr interest / Cr bill amount
  - REALLOCATE：无 GL
- audit 在写状态与 GL 后调用 `BillLedger.replay!`；按票锁定、重放全部 AUDITED 交易并
  整删整建 `acc_bill_holding`。非法段/时序令状态、GL、投影全部回滚。
- void 取消非调拨 GL 后重放；若后续交易已消耗本段，重放失败令 void 与 GL cancel 一起
  回滚。调拨 audit/void 只重放库存。
- BillHolding 是只读、无 Audit Fragment 的段级投影；内部 rebuild/destroy 不公开。
  `amount/acquiredOn/sourceTransactionId` 由重放决定，任何 REST 写接口都属越权。
- OCR 与发票相同：复用交易 create、只返回草稿预填 map、不落库；前端只在 RECEIVE
  新建动线展示，并在交易保存成功后挂附件。

## A/B/C/D 事务表面

### 发票

| 类型 | 精确表面 |
|---|---|
| **A. Commands** | invoice create/update/delete/audit/void/reverse/ocr |
| **B. 主表** | `acc_vat_invoice`；关联的销售/采购对账单与待办由其各自内部动作维护 |
| **C. 引擎写入** | audit 调 GL Post（本票组 + 可选对账冲回组）；void 调 GL Cancel；reverse 调 GL Reverse |
| **D. 投影/系统列** | invoice status/posting/audited/red no/Actor；对账单状态与待办状态 |

### 报销

| 类型 | 精确表面 |
|---|---|
| **A. Commands** | report/item CRUD；report audit/void |
| **B. 主表** | `acc_expense_report`、`acc_expense_report_item` |
| **C. 引擎写入** | audit 调 GL Post；void 调 GL Cancel |
| **D. 投影/系统列** | report status/audited Actor/time；发票可用性由非 voided item 引用查询推出 |

### 承兑

| 类型 | 精确表面 |
|---|---|
| **A. Commands** | bill update/delete；transaction CRUD/audit/void/ocr |
| **B. 主表** | `acc_bill`、`acc_bill_transaction` |
| **C. 引擎写入** | 非调拨 audit 调 GL Post，void 调 GL Cancel；调拨不调用 GL |
| **D. 投影/系统列** | transaction status/audited Actor/time；`acc_bill_holding` 仅 BillLedger 整体重放 |

### 银行对账 quick create

| 类型 | 精确表面 |
|---|---|
| **A. Commands** | reconciliation create/quickCreate/delete/remaining |
| **B. 主表** | `acc_bank_reconciliation`；quickCreate 还创建 journal + 两行 |
| **C. 引擎写入** | quickCreate 经 journal audit 调 GL Post；普通关联/解除不写 GL |
| **D. 投影/系统列** | bank transaction reconciled/unreconciled/status；quick journal 状态/审核列/合计 |

每个 audit/void/reverse、BillLedger replay、导入执行与 quick create 的 B/C/D 必须处在调用方
同一数据库事务中；GL 不自行 commit，来源模块不得直接写 `acc_gl_entry`。系统列与投影列
只能由上述动作/引擎写。普通银行流水本身不记账。

## 并发、锁与数据库兜底

- 流水对账：固定顺序锁流水、凭证；解除先锁流水。容量判断与派生刷新都在锁内。
- 导入：锁批次后判断 parsed；item 修改/删除也锁同一批次，和 import 串行。文件 SHA
  防重没有 unique，是明确的旧边界。
- 发票、报销、承兑交易：构建期校验只改善错误提示；事务内 `FOR UPDATE` 重读才是权威
  状态闸。对账单、报销发票、票据重放再按各模块固定顺序锁相关行。
- 关键 DB 兜底：账户 alias/accountNo、模板名、发票编号、报销单号、承兑交易单号、
  票号与流水-凭证组合的 unique；对账 amount > 0；父子 cascade 与业务 FK restrict。
- Audit Fragment 的日志与业务动作同事务；BillHolding 不审计，来源交易就是追溯事实。
  头删除的 DB cascade 不伪造逐 item destroy 审计。

## 旧前端消费面

- 银行账户、模板、流水各用通用 Grid + RecordDrawer；流水额外提供 import/reconcile
  capability 门控入口。导入是“上传解析 → 历史 → 批次详情/修错 → 执行”的三个 drawer，
  imported 行只读，failed 只显示错误。
- 对账 drawer 读取流水、账户绑定科目、已有对账与 journal Meta；支持关联、解除、remaining
  预填与 quick create。对账资源自身 capabilities 恒空，解除由外层流水 `reconcile`
  capability 门控，不能误判成无删除权限。
- 发票页面有本地 editable items、三类对手/对账单条件选择、OCR、附件、审核、作废、红冲
  与内部公司镜像建草稿；已非 DRAFT 自动只读。
- 报销页面把 Item 当子表逐行 create/update/delete，挂票与手工两槽使用自定义输入；
  只允许 DRAFT 编辑/删/审，AUDITED 才可 void。
- 承兑工作台为交易/持有两 tab。交易类型由入口确定；持有段可发起后续交易。票面修正权限
  必须读取 `accBills:update`，不能错误借用 Holding capability。OCR 只在 RECEIVE create。
- 迁移后的页面只应改 transport；上述 capability 门控、状态显隐、资源刷新链、Decimal
  string、OCR/附件的非原子边界与子表保存顺序都是可观察契约。

## 迁移验收钉

- 26 份 snapshot exact 对拍；不得给 read-only Actor 或无独立权限资源补伪 capability/ref。
- 13 query、40 mutation 的 REST/OpenAPI 对应面完整；六个内部动作继续不公开。
- 权限拒绝、CompanyScope 与 BillCompanyScope 都有正反测试。
- 导入 parser、批次失败留痕、纵深 create 权限、整批事务与并发批次锁保持。
- 发票、报销、承兑的状态机、编号、审计、GL A/B/C/D 与投影列单写者保持。
- 对账容量、方向、双侧锁、quick create 全回滚与反向守卫保持。
- OCR 只读文件并返回预填，不落业务记录；外部失败保留可读错误。
- 前端必须只打迁移后的 API，同时保持旧页面可见动作与禁用条件。
