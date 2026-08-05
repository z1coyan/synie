# 12 — 扫荡：finance / accounting / hr

**What to build:** 按 08 手册迁移 finance（发票/银行/报销/承兑/票据 OCR）、accounting（凭证/分录/科目角色）、hr（员工/考勤/薪资）。要点：两个 `requireAction` 包装与 `requireCompanyWrite` 删除；发票 reverseMode 动态动作码（S9）路由内派生后 guard；银行导入的 import-as-read 重载改 anyOf 声明；考勤导入分支条件权限（D8/e4）分支内二次取 Permit；跨资源 allOf 三处（对账、考勤+文件、挂接）走 guard allOf；hr 全局表（payroll/attendance 无 company_id）声明 global。

**Blocked by:** 08

**Status:** done

- [x] 三模块全量迁移，本地包装删除
- [x] S9/D8/allOf/import-as-read 特殊形态按归宿落地
- [x] 相关集成/E2E 测试全绿；封路豁免清单清零（全库无豁免）

## Comments

### 实施落点

| 子域 | 服务 | 路由 | 备注 |
|---|---|---|---|
| 增值税发票 | `finance/invoice-service.ts` | `finance/routes.ts`（挂 `/finance/vat-invoices`） | company；S9 reverseMode 路由派生动作码（见下） |
| 银行账户 / 银行流水 | `finance/banking-accounts.ts` | `finance/ops-routes.ts` | company；列表/单条共用 `ACCOUNT_SOURCE/SELECT` 常量 |
| 流水导入模板 / 批次 / 行 | `finance/banking-import.ts` | 同上 | 批次 company + readAnyOf（import-as-read，见下）；行 via(批次) |
| 银行对账 | `finance/banking-recon.ts` | 同上 | company；reconcile 命令码挂在银行流水资源上 |
| 费用报销单 / 报销行 | `finance/expense-service.ts` | 同上 | 单 company；行 via(母单) |
| 承兑票据 / 交易 / 持有段 | `finance/bill-service.ts` | 同上 | 主档 **global + 派生可见性**（见下）；交易/持有段 company |
| 会计凭证 / 凭证行 / 总账分录 | `accounting/journal-service.ts` / `entry-service.ts` | `accounting/routes.ts`（挂 `/accounting`） | 凭证 company；行 via(头)；分录 company（多态来源，同 `invStockEntries` 判据） |
| 考勤（打卡/导入/日考勤/补卡） | `hr/attendance-service.ts` | `hr/routes.ts` | 四表全 global（无 `company_id`）；D8 分支条件权限（见下） |
| 薪资（工资单/发放/借款） | `hr/payroll-service.ts` | 同上 | 三表全 global；发放锁内核算顺序不变 |
| 装配 | 三模块 `index.ts` / `app.ts` / `composition.ts` | — | 服务构造收 `registry`；20 组路由 deps 收 `authz`（hr 7 + accounting 1 + finance 12） |
| 种子 | `setup/sampledata/finance.ts` | — | 一律 `permitFor(deps, actor, 资源, 动作)` 现取凭证（9 个调用点） |

**删除的本地包装**：`finance/common.ts:requireCompanyWrite`（工单点名）、`journal-service.ts:requireAction`、
`invoice-service.ts:requireAction`、`entry-service.ts:requireRead`、各文件的 `requirePermission`/`requireCompanyAccess`
调用点清零（grep 复核三模块零旧原语）。`bill-service.ts` 的手写派生谓词 `billScopeWhere`/`lockBillForActor` 删除，
改 `compileRowFilter` 编译；`payroll-service.ts:lockPayroll`（裸锁）被 `authorizedPayroll`（授权 + 行锁）吸收。
`finance/common.ts` 顶部补「鉴权不在本文件」注释头（与 `inventory/helpers.ts` 同口径）。

### 声明形态与理由（多数声明扫荡期已就位，本轮复核；唯一 meta 改动是 `accBankImports`）

| 资源 | 声明 | 理由 |
|---|---|---|
| `accVatInvoices` / `accBankAccounts` / `accBankTransactions` / `accBankImportTemplates` / `accBankReconciliations` / `accExpenseReports` / `accBillTransactions` / `accBillHoldings` / `accGlJournals` / `accGlEntries` | `{ kind: 'company' }` | 自带 `company_id`；**故意不声明 owner/dept**（这些单据不按人/部门看） |
| `accGlEntries` 为何不是 via | company | 来源单据多态（`voucher_type/voucher_id` 跨资源），无法静态声明单一 parent——与 `invStockEntries` 同判据（工单 08） |
| `accExpenseReportItems` / `accGlJournalLines` / `accBankImportItems` | `{ kind: 'via', parent, fk }` | 子行判定递归归宿；动作码解析到母单前缀，supportedScopes 为 `[]`（不交没母资源档位） |
| `accBills`（承兑票据主档） | `{ kind: 'global' }` | `acc_bill` 无 `company_id` 列；「本公司可见」语义由名下交易的派生可见性给出（见下「特殊形态」） |
| `hrAttendancePunches` / `hrAttendanceImports` / `hrAttendanceDays` / `hrAttendanceCorrections` / `hrPayrolls` / `hrPayrollPayments` / `hrEmployeeLoans` | `{ kind: 'global' }` | **七张表都无 `company_id` 列**（全局 HR 数据）；行级过滤恒放行，执行点只承担码级判定与统一 404 |
| `accBankImports` | `{ kind: 'company', readAnyOf: [acc.bank_transaction:import] }` | **本轮唯一 meta 改动**：import-as-read 重载（见下）；批次不进权限目录，故 `actions` 补声明 `import`（供 `assertActionDeclared`），不新增权限码 |

`catalog-seal` 资源计数（105）与形态分布（company 34 / global 35 / via 36）两处快照**不变**；
`resource-authz.test.ts` 的 readAnyOf 清单补 `accBankImports`（既有 `hrAttendanceImports` / `scmOrderFlowItems`）；
`menu-permission-contract` 不变（无新前缀）。

### 特殊形态归宿

**S9 发票 reverseMode 动态动作码 → 路由内派生后 guard。** `void`/`reverse` 共用服务实现 `endInvoice`，
动作码派生移到路由：`finance/routes.ts:endInvoiceAction(reverseMode)` 返回 `'void' | 'reverse'`，
两个端点各挂 `guard(endInvoiceAction(...))`；两码都已在 meta 声明，不撞 `assertActionDeclared`。
服务内只留领域分支（状态门、GL 重放），不再判码。

**import-as-read 重载 → readAnyOf 声明。** 导入批次/行没有独立权限点，唯一门控码是
`acc.bank_transaction:import`（迁移前服务里就是这一个码）。`accBankImports` 声明
`readAnyOf: [import]`：读也解析到 import 码，**单码不放宽**；行经 via 递归批次。对照：
`hrAttendanceImports` 的 `readAnyOf: [read, import]` 是更早批次已落的声明（本轮开始执行），
它**是**放宽（持 read 码即可看批次），已列入语义变化表。

**跨资源 allOf（工单点名三处，实际落四处）。** 判据同工单 07/11：**每一次都必然**连带另一资源 →
声明式 allOf；附加码从 `authz.targetOf(资源).prefix` 拼，不写字面量。

```
POST /finance/bank-imports                → import ∧ sys.file:read          （建批次必然读导入文件）
POST /finance/bank-imports/:id/import     → import ∧ acc.bank_transaction:create （执行导入必然建流水）
GET  /finance/bank-reconciliations/remaining → read ∧ acc.gl_journal:read   （对账余额既读流水又读凭证）
POST /hr/attendance-imports               → import ∧ sys.file:read          （建批次必然读考勤文件）
```

四处都是旧服务内双码闸（`requirePermission` × 2）的忠实搬运，无新增码。工单写的「三处」
未单列 runImport 一处（`∧ bank_transaction:create`），此处按同判据一并落地，语义等价。

**D8 考勤导入分支条件权限 → 分支内二次取凭证。** `POST /hr/attendance-imports/:id/import` 的
`autoCreateEmployees` 分支（自动建「未知」员工）需 `hr.employee:create`——判据是**条件性**：
是否触发取决于请求体，路由算不出，故不进 allOf，在分支内 `authz.decideFor(permit.actor, EMPLOYEE_RESOURCE_NAME, 'create')`
二次取凭证，缺码即 403「无权自动创建员工…可去掉勾选仅导入已匹配的行」（凭证内核仍是唯一判定点）。

**hr 全局表 → global 声明。** 七张表无公司列即无公司边界：零公司授权照读（spec §5），
`compileRowFilter` 对 global 短路 TRUE；执行点只剩码级判定与统一 404。

**（附带）承兑票据主档的派生可见性。** `acc_bill` global，但「本公司可见」沿用既有语义
「名下有本人可达的交易」：`billVisibleWhere` 用 `compileRowFilter(permit, billTxTarget, 'scope_tx')`
把**交易资源**的行过滤编进 `EXISTS` 子查询——判定仍归平台，模块不写公司/主体分支；
`authorizedBill` = 票据码级判定（`loadAuthorized` on global）∧ 派生可见性。迁移前是手写的
`billScopeWhere`/`lockBillForActor`（`company_id = ANY(ids)`），语义等价、声明驱动。

**（附带）凭证审核的内部 seam。** `auditJournalInTx` 收 `lockHead` 回调：HTTP 路径走
`lockAuthorizedJournal`（授权 + 行锁），对账快速建票的 `createAndAuditJournal` seam 走裸锁
（凭证刚在同一 trx 内建出，且调用方端点已由 guard 判过 `acc.bank_transaction:reconcile`，
不叠 `gl_journal:create/audit` 双码）。

### 语义变化表（逐路径）

| 路径 | 旧 | 新 |
|---|---|---|
| 公司域单条读/改/删/工作流：跨公司（发票/账户/流水/模板/批次/对账/报销单/承兑交易/持有段/凭证/凭证行/分录） | `not_found`（`requireCompanyAccess` / `canAccessCompany`→notFound） | `not_found`（统一由 `loadAuthorized`/`loadAuthorizedFrom` 产出；**行为不变**，产出点归一） |
| 各列表：零公司授权 | `empty` 早退返回空列表 | 空列表（行过滤编译为 `false`，早退义务消失） |
| 各列表：跨公司行 | 按 `companyScopeWhere` 过滤（同） | 公司 ∧ 范围原子编译（同结果，声明驱动） |
| **凭证 `POST /accounting/gl-journals`：目标公司未授权** | `forbidden`「无权操作该公司数据」 | `not_found`「会计凭证不存在」 |
| **银行账户/流水/导入模板/导入批次 `POST`：目标公司未授权** | `forbidden`「无权操作该公司数据」（`requireCompanyWrite`） | `not_found`「xx 不存在」（`assertCompanyWritable`） |
| 发票/报销单/承兑交易 `POST`：目标公司未授权 | `not_found`（旧已是 404） | `not_found`（同） |
| 发票/凭证/账户/流水/模板/报销单 create：入参非法且公司未授权 | 先撞公司闸（报公司相关） | 400 入参校验先于公司边界（404） |
| **应收应付报表 `GET /accounting/ar-ap-report`：公司未授权** | `forbidden`「无权查看该公司数据」 | 200 空结果（`rows: []` / `roleAccounts: {}`，`companyInPermitScope` 不命中即空） |
| 导入批次/行读（list/get） | 服务内 `requirePermission(acc.bank_transaction:import)` | guard `read` → readAnyOf 解析到 import 码（**同码**，声明式） |
| **考勤导入批次读（list/get）** | 服务内 `requirePermission(hr.attendance_punch:import)` | readAnyOf `[read, import]`：**放宽**——只持 read 码也可看批次（既有声明本轮开始执行） |
| via 子行单条读（报销行/凭证行/导入行） | 按行自身 `company_id` 判 | via 链 EXISTS 递归母单（归宿 company；行公司列镜像母单，**实际行集不变**） |
| **承兑票据主档 list/get/update/delete** | 手写 `EXISTS(交易.company_id = ANY(ids))`（`companyFilter`） | `compileRowFilter` 把交易资源行过滤编进 `EXISTS(scope_tx)`（**同语义**；零公司授权 → `false` → 空列表/404 同旧） |
| 发票 `POST /:id/void` 与 `POST /:id/reverse`（S9） | 服务内 `requireAction(reverseMode ? 'reverse' : 'void')` | 路由 `guard(endInvoiceAction(reverseMode))`（**同码同语义**，两码各自独立门控） |
| 考勤导入 `POST /:id/import` 勾选自动建档（D8） | 分支内 `requirePermission(hr.employee:create)` → 403 | 分支内 `decideFor` 二次取凭证 → 403（**同码同文案**；不勾选不进分支不要该码） |
| `POST /finance/bank-imports`（建批次挂接文件） | 服务内双码闸 import + `sys.file:read` | guard import ∧ allOf `sys.file:read`（同两码，缺码 `forbidden`） |
| `POST /finance/bank-imports/:id/import`（执行导入） | 服务内双码闸 import + `acc.bank_transaction:create` | guard import ∧ allOf create（同两码） |
| `GET /finance/bank-reconciliations/remaining`（跨资源读） | 服务内双码闸 `acc.bank_transaction:read` + `acc.gl_journal:read` | guard read ∧ allOf `acc.gl_journal:read`（同两码；recon 资源前缀即 `acc.bank_transaction`） |
| 对账 `POST /`、`POST /quick-create`、`DELETE /:id` | 服务内 `acc.bank_transaction:reconcile` | `guard(accBankTransactions, 'reconcile')`（meta `permissionAction: 'reconcile'`，**不新增权限码**） |
| 快速对账建凭证 | seam 注释「不叠 gl_journal 双码」（同） | 同（`auditJournalInTx` 裸锁回调，语义不变） |
| 工资单 `POST /:id/refresh` | 服务内 `hr.payroll:update` | `guard('update')`（沿用最近已声明动作，不新增码） |
| 发放 `POST /pay-remaining` | 服务内 `hr.payroll_payment:create` | `guard('create')`（同码） |
| 日考勤 `POST /recalc` | 服务内 `hr.attendance_day:recalc` | `guard('recalc')`（meta collection command 码，同码） |
| 月度聚合（`month-summary` / `month-stats` / `loan-balances`） | 服务内 read 码 | guard read；服务只做码级消费（`_permit`），**不套行过滤**（聚合投影无绑定列） |
| 发票/票据 `POST /ocr` | 服务内 create 码 + 文件可达性自判 | guard create；文件行级可达性归平台 `readReachableFile`（码 `forbidden` / 行 `not_found`） |
| hr 七表单条/列表 | 码级 `requirePermission`；无公司边界 | guard + 执行点（global 行过滤恒放行，**可见行集不变**；不存在的 id 统一 `not_found`） |
| 任一端点：缺动作码 | 服务层 `forbidden`（文案五花八门） | guard 产出 `forbidden`（**403 唯一成因＝码不满足**；服务层 forbidden 文案清零，唯一例外是 D8 考勤导入的分支条件权限——请求体决定要不要 `hr.employee:create`，路由算不出，仍在分支内二次取凭证后抛 403，判定仍出自凭证内核） |
| 各前缀 `supportedScopes` | `[all]` | `[all]`（未加 owner/dept 绑定，矩阵不新增档位）；via 子行 `[]` |

**未变**：hr/票据主档等 global 资源无公司边界，迁移前后可见行集完全一致；公司域资源的公司边界
语义与迁移前等价（两处 `forbidden` 系 create 统一为 `not_found`，报表 forbidden 改空结果）。

### 坑

1. **带投影子查询的单条读/锁单是两段式**：`loadAuthorizedFrom` 能管 get（发票），但要行锁只能
   `loadAuthorized(forUpdate)` 裸表授权后按原投影重读——`FOR UPDATE` 不能进子查询；考勤/薪资的
   `to_char` 时间投影同理（先授权 404，再重读投影）。列表与单条共用同一份 `SOURCE/SELECT` 常量，
   别名只有一处可写错。
2. **`readAnyOf` 资源不进权限目录，但 `assertActionDeclared` 仍查本资源 actions**：
   `accBankImports` 必须显式补 `import` 动作声明，否则 `guard(资源, 'import')` 500（meta 注释已写明）。
3. **global 资源上别名写错没有牙**（同工单 11 坑 4 的推论）：行过滤短路 TRUE，连 via 都不编译。
   本批投影带别名的两条路径（`FROM hr_attendance_import i` → `alias: 'i'`、`FROM hr_payroll p` → `alias: 'p'`）
   靠 sweep 测试「19 条列表路径都能看到本人可达的行」兜住——只断言「别人的不在」对空集永真。
4. **`loadAuthorized` 返回 `Record<string, unknown>`**（同工单 11 坑 1）：`locked.status` 等比较
   一律 `String(row.status) !== 'draft'`；`auditJournalInTx` 的 `lockHead` 回调签名也因此统一成
   `Promise<Record<string, unknown>>`，HTTP 与 seam 两种锁可以同槽传入。
5. **D8 用例要走到「有 missing 编号」才触发二次取证**：不勾选 `autoCreateEmployees`、或编号全部
   已匹配，都不会判 `hr.employee:create`——测试用真实 `.dat` 上传构造未匹配编号，并断言
   「勾选 403 / 不勾选 200」双向。
6. **`deletePayment` 加锁顺序**：先 `loadAuthorized` 定位发放行归属，再锁工资单（母行先行）；
   发放/补发路径的 `pg_advisory_xact_lock` → 锁工资单 → 读借款台账顺序原样保留。
7. **考勤导入批次读是放宽不是等价**：`readAnyOf: [read, import]` 声明早于本批落地，本轮 guard 接上后
   持 `hr.attendance_punch:read` 的角色 newly 能看导入批次——银行导入批次（单码 readAnyOf）无此问题。
8. **基线红别修**：hr `meta.grid` 形状 / printing / market 三个 integration 是既有基线红
   （hr 用例已用 git worktree 在 HEAD 复验同样失败），与本轮无关。

### 测试数字

- `cd server && bun run typecheck` → 0 error（见下「typecheck 输出」）；`cd web && bun run typecheck` 同样 0 error。
- 单文件：`src/modules/finance/` **20 pass / 4 文件**；`src/modules/accounting/` **4 pass / 1 文件**；
  `src/modules/hr/` **18 pass / 1 fail / 2 文件**（1 fail ＝ 既有基线红 `hr operations integration` 的
  meta.grid 形状，HEAD 复验同失败，与本轮无关）。
- `src/platform/meta/resource-authz.test.ts` **22 pass**（readAnyOf 清单 +accBankImports）；
  `src/platform/setup/setup.integration.test.ts` **3 pass**（示例数据种子链路，验 `permitFor` 接线）。
- 新增 `server/test/sweep-finance-accounting-hr.integration.test.ts`：**14 tests / 162 expect 全绿**，
  四角色（全量 / 只读 / 仅 import 码 / 仅考勤导入码）× 两公司，全程走 HTTP：
  1. 19 条列表路径别名回归（本人可达的行必须在结果里；含票据派生可见性与 `i`/`p` 两条带别名投影）；
  2. 公司域跨公司单条 404 × 9 + 列表不含 + 本公司同路径 200 对照；
  3. via 子行跨公司 404 × 3（母单不可达即 404，行自身公司列不再是判据）；
  4. 承兑票据 global：无可达交易的票据 404 / 列表不含，有交易的 200；
  5. 缺码 403 × 6（只读角色写路径）+ 同角色读路径 200 对照；
  6. 状态守卫 409 × 3（已审核发票改 / 已审核凭证删 / 有对账流水删）；
  7. create 跨公司 404 + 入参校验 400 先于公司边界；
  8. S9：只授 void 的角色 reverse 403、void 非 403（派生码分别判定）；
  9. import-as-read：单持 import 码可读批次与行、读流水仍 403；runImport 缺 create 码 403；
  10. 跨资源 allOf 三处：建导入批次缺 `sys.file:read` 403、remaining 缺 `gl_journal:read` 403、
      考勤建批次缺 `sys.file:read` 403（补齐后均非 403）；
  11. D8：勾选自动建档缺 `hr.employee:create` → 403，不勾选 → 200（真实 .dat 上传）；
  12. hr global：零公司授权照读；对照公司域零授权空列表 + 单条 404（spec §5）；
  13. ar-ap-report 公司未授权 → 200 空结果（不再 forbidden）；
  14. 本批 16 个前缀 `supportedScopes` 只出 `all`，三个 via 子行为 `[]`。
- 全量：`SYNIE_TEST_DATABASE_URL=… bun test` → **600 tests / 86 files，597 pass / 3 fail**。
  三个失败是既有基线红（hr `meta.grid` 形状 / printing / market），与本轮无关，一个没修。
- `web/app/lib/menu-permission-contract.test.ts` **3 pass**（前缀集合未变）。
- 封路豁免：删 **11 行**（accounting 2 / finance 7 / hr 2），`EXEMPT` 清零、断言改 `toBe(0)`，
  清单性质从「扫荡进度表」改为「不得回退」守卫，三例全绿（**3 pass**）。

### typecheck 输出（原文）

```
$ cd server && bun run typecheck
$ tsc --noEmit
EXIT=0
```

```
$ cd web && bun run typecheck
$ tsc --noEmit
EXIT=0
```

### 未尽事项（不阻塞本单）

- **import-as-read 与考勤批次读放宽要过一遍存量角色授权**：只持 `hr.attendance_punch:read` 的角色
  现在能看考勤导入批次（旧要求 import 码）；`acc.bank_transaction:import` 单码语义未变。
- 前端 403→404 / forbidden→空结果的提示文案随工单 14 的 QueryState 收口；
  `capabilities={[...]}` 硬覆盖同留工单 14。
- 矩阵范围 UI（self/dept 档位的授权界面）是工单 13，本批全部前缀仍只出 `all`。
