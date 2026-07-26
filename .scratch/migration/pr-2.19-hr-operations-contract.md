# PR-2.19 考勤、工资发放与员工借款迁移前契约

记录日期：2026-07-26。本文只冻结旧 Elixir/Ash/GraphQL 与旧前端的实际表面，不新增
业务规则。范围严格为：

- `SynieCore.Hr.AttendancePunch` / `hr_attendance_punch`
- `SynieCore.Hr.AttendanceImport` / `hr_attendance_import`
- `SynieCore.Hr.AttendanceDay` / `hr_attendance_day`
- `SynieCore.Hr.AttendanceCorrection` / `hr_attendance_correction`
- `SynieCore.Hr.Payroll` / `hr_payroll`
- `SynieCore.Hr.PayrollPayment` / `hr_payroll_payment`
- `SynieCore.Hr.EmployeeLoan` / `hr_employee_loan`

事实来源按优先级为：

1. 七个旧 Ash Resource、考勤重算/解析器与工资引擎；
2. 真实 `SynieWeb.GridMeta.resolve/2` 与 GraphQL introspection 输出：
   `.scratch/migration/snapshots/pr-2.19/`；
3. 三份 PostgreSQL migration、Ash resource snapshot 与真实 PostgreSQL/Ecto 测试；
4. `CONTEXT.md`、人力薪酬产品文档、三份对应 ADR 与旧 HR 前端页面。

七个资源都是 GridMeta 白名单资源。旧运行时没有独立 `RecordMeta` 构建器；查看/编辑抽屉
复用 GridMeta。因此本批冻结 7 × 2 = **14 份**真实 GridMeta，以及一份包含相关 Root
Query/Mutation、对象、输入、分页、筛选、排序和 enum 类型的 GraphQL introspection
快照。JSON snapshot 是字段顺序、类型、label、filter/sort、ref、capability 与 destroy
mutation 的精确真值；本文只作人读摘要。

## 可复现捕获与旧基线

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_hr_operations_contract.exs \
  ../.scratch/migration/snapshots/pr-2.19

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/hr/attendance_import_parser_test.exs \
  apps/synie_core/test/synie_core/hr/attendance_import_test.exs \
  apps/synie_core/test/synie_core/hr/attendance_rules_test.exs \
  apps/synie_core/test/synie_core/hr/attendance_day_test.exs \
  apps/synie_core/test/synie_core/hr/payroll_test.exs \
  apps/synie_web/test/synie_web/schema_grid_test.exs \
  apps/synie_web/test/synie_web/graphql_exposure_test.exs \
  --seed 0
```

固定 read-only Actor 持：

- `hr.attendance_punch:read`
- `hr.attendance_day:read`
- `hr.attendance_correction:read`
- `hr.payroll:read`
- `hr.payroll_payment:read`
- `hr.employee_loan:read`
- `hr.employee:read`
- `sys.file:read`
- `sys.user:read`

所以员工、文件、用户、工资单与本批资源之间的 FK ref 在 read-only snapshot 中仍保留，
但全部写 capability 为空。注意 `AttendanceImport` 的所有动作（包括 read）复用
`hr.attendance_punch:import`；上述固定 Actor 是“Meta read-only 对拍 Actor”，并不能真正
读取导入批次。这是旧权限表面的真实不对称，迁移不能用 `:read` 暗中扩权。

2026-07-26 在真实 PostgreSQL/Ecto SQL Sandbox 上复跑结果：

- `synie_core`：**51 passed**
- `synie_web`：**44 passed**
- 合计：**95 passed**

覆盖解析、导入/撤销、计算规则、补卡重算、工资生成/刷新/发放/补发、借款抵扣、权限，
以及 Grid 与 GraphQL 暴露面。

## 共同 wire、分页与公司范围

- 七个资源全部是**全局 HR 数据，不挂公司、不做 CompanyScope**；这与旧员工资源一致。
- 七个 list query 都是 offset pagination，默认 limit 20、最大 200、可返回 count；
  资源没有服务端默认 sort/stable sort，调用方不传 sort 时顺序不承诺。
- UUID/ID 是 JSON string；Decimal 输出 string 保精度；Date 是 `YYYY-MM-DD`；
  Time 是 `HH:MM:SS`；DateTime 是 UTC ISO-8601 string。
- enum wire 固定大写：
  - 导入：`PARSED/FAILED/IMPORTED`
  - 日考勤：`OK/MISSING`
  - 工资单：`PENDING/PAID`
  - 发放：`NORMAL/SUPPLEMENT`
  - 借款：`BORROW/REPAY`
- 可空字段必须输出 `null`，不能改为空串、0 或假 UUID。
- 旧 GraphQL mutation 返回 `{result, errors {message}}`。通用 action 的 map/array-map
  返回 `JsonString`；REST 可改为结构化 JSON，但内层字段名、Decimal string 与计数语义
  不得缩水。

## GridMeta 精确摘要

所有资源共同遵循：`id` 可排不可筛；普通标量按 snapshot 决定筛排；FK 可筛不可排；
`extendedActions=[]`。read capability 不出现在 `capabilities` 中。

| Grid | 列数 | superadmin capabilities | destroy mutation |
|---|---:|---|---|
| `hrAttendancePunches` | 6 | `import` | 无 |
| `hrAttendanceImports` | 20 | `import` | `destroyHrAttendanceImport` |
| `hrAttendanceDays` | 13 | `recalc` | 无 |
| `hrAttendanceCorrections` | 8 | `create/update/delete` | `destroyHrAttendanceCorrection` |
| `hrPayrolls` | 19 | `create/update/delete` | `destroyHrPayroll` |
| `hrPayrollPayments` | 11 | `create/delete` | `destroyHrPayrollPayment` |
| `hrEmployeeLoans` | 10 | `create/update/delete` | `destroyHrEmployeeLoan` |

固定 read-only Actor 的七份 `capabilities` 均为空。

列顺序：

- 打卡：
  `id, attendanceNo, punchedAt, insertedAt, employeeId, importId`
- 导入：
  `id, status, error, totalRows, badRows, dupRows, matchedRows, unmatchedRows,
  unmatchedDetail, importedCount, skippedExistingRows, skippedUnmatchedRows,
  autoCreatedCount, importedAt, insertedAt, updatedAt, fileId, createdById,
  importedById, punchCount`
- 日考勤：
  `id, date, morningIn, morningOut, afternoonIn, afternoonOut, normalHours,
  overtimeHours, bonusWorkday, status, insertedAt, updatedAt, employeeId`
- 补卡：
  `id, date, times, note, insertedAt, updatedAt, employeeId, createdById`
- 工资单：
  `id, month, workdays, attendanceDays, missingDays, overtimeHours, dailyWage,
  baseAmount, allowance, bonus, fine, loanDeduction, payable, status, remarks,
  insertedAt, updatedAt, employeeId, paidTotal`
- 发放：
  `id, month, paidOn, amount, kind, remarks, insertedAt, updatedAt, payrollId,
  employeeId, createdById`
- 借款：
  `id, kind, occurredOn, amount, remarks, insertedAt, updatedAt, employeeId,
  payrollId, createdById`

两个 Meta 特例必须保持：

1. `AttendanceCorrection.times` 的 GraphQL 实际类型是 `[Time!]!`，但 GridMeta 退化为
   `type=string`，且不可筛不可排；前端自定义多时刻编辑器处理它。
2. `Payroll.paidTotal` 与 `AttendanceImport.punchCount` 是 aggregate，只展示，
   `sortable=false/filterable=false`。

## 原始打卡与导入批次

### `AttendancePunch`

- 是考勤机原始事实：员工、原始考勤号、UTC 打卡时刻、来源批次。
- `(employee_id, punched_at)` 数据库唯一；`attendance_no` 必填、最多 64。
- 对外只有 list read，须 `hr.attendance_punch:read`；无公开单条新增、修改、删除。
- 内部 create 只由导入动作调用，接受
  `employee_id/attendance_no/punched_at/import_id`，纵深权限归口
  `hr.attendance_punch:import`。
- 批次 FK `ON DELETE CASCADE`；员工 FK restrict。
- 不接通用 Audit Track。逐条打卡不留审计，留痕由受审计的导入批次和原始文件承担。

### `.dat` 解析

- 非空白行格式为“考勤机编号 + `YYYY-MM-DD HH:MM:SS`”，空白或 tab 分隔；其余列忽略。
- 编号原样保留，不能去前导零；编号 1～64 bytes。
- 本地时刻按固定偏移转 UTC，默认 UTC+8；不做夏令时。
- 坏行跳过计数；同 `(编号,时刻)` 的文件内重复行跳过计数；隔秒连按保留。
- 空文件、全坏行报记录级错误；去空白后的总行数最大 100,000。
- `.dat` 后缀只由旧前端校验，旧后端按内容解析，不校验 filename/MIME。

### `AttendanceImport`

字段与摘要：

- `file_id` 必填；状态默认占位 `parsed`，create 的解析钩子权威覆盖。
- 摘要字段为总行、坏行、文件内重复、已匹配、未匹配和最多 50 个未匹配编号统计；
  `unmatched_detail` 最多 2,000，`error` 最多 500。
- 执行结果为导入数、跳过既有、跳过未匹配、自动建员工数、导入时点/导入人；
  `punchCount` 是当前关联打卡聚合。
- `created_by/imported_by` 从 Actor 写入，可空；批次不编号。

动作与权限：

| action | 公开 GraphQL | 权限 | 语义 |
|---|---|---|---|
| `read` | `hrAttendanceImports` | `hr.attendance_punch:import` | 分页读 |
| `create` | `createHrAttendanceImport` | 同上 | 读文件并解析预览 |
| `import` | `importHrAttendanceImport` | 同上 | 仅 parsed，重新解析并写打卡 |
| `destroy` | `destroyHrAttendanceImport` | 同上 | 任意状态整批撤销 |

- create 先校验 Actor 可读该文件。相同 sha256 已有**非 failed**批次时拒绝；failed 批次
  不防重，删除原批次后也可重建。
- 解析失败不回滚 create：落一条 `FAILED` 批次和可读错误；解析成功暂不写打卡。
- import 参数 `autoCreateEmployees` 默认 false。执行前 `FOR UPDATE` 锁批次并复核
  `PARSED`，双执行、执行与删除按批次串行。
- 自动建缺失员工须额外具有 `hr.employee:create`，姓名固定 `[未知]`、考勤号回填、
  员工 code 走员工编号规则；缺权限/缺规则/任一创建失败，整个 import 回滚。
- 已匹配行中数据库已有 `(员工,时刻)` 的静默跳过；未匹配行按参数跳过或先自动建员工。
  全部行均未匹配且不自动建时，旧 API 仍允许导入成功并记 `importedCount=0`；旧 UI 会
  禁用该按钮。
- 写入打卡后，同事务重算受影响 `(员工,本地日)`；destroy 在删前收集这些 pair，批次
  级联删打卡后，同事务按剩余打卡与补卡重算/删掉空日。
- `AttendanceImport` 接 Audit Track：create/import/destroy 均留日志，日志与动作同事务。

并发精确边界：

- 批次行锁保证同一批次只能执行一次。
- “相同 sha256”只有应用层先查，没有数据库唯一索引；两个并发 create 可能都通过。
- 不同批次并发写同一 `(员工,时刻)` 时，预查不是锁，最终由打卡 unique index 拒绝一方；
  旧实现没有 conflict-ignore/retry，该方整个 import 回滚。

## 日考勤与补卡

### 计算规则

- 输入为当天真实打卡与补卡虚拟卡的并集；全天无卡不生成日考勤行。
- 本地自然日、12:00 切桶：`<12:00` 上午，`>=12:00` 下午；每桶最早/最晚卡为上下班。
- 上下午分别按 30 分钟向下取整；上午正常工时封顶 4h；下午前 4h 为正常工时，超出为
  加班；正常工时日封顶 8h。
- 取整后单日加班 >= 3.5h 奖励 0.5 工日，日封顶 0.5。
- 桶内一张卡：该段 0 工时且整日 `MISSING`；桶内无卡是无出勤，不算缺卡。
- 不处理跨零点、班次、迟到早退、工作日历；周末/节假日同式。

### `AttendanceDay`

- `(employee_id,date)` 唯一，字段为四段时刻、正常/加班工时、奖励工日、状态。
- 人工不可普通 CRUD。内部 create 是按唯一键全字段 upsert；全天无卡时内部 destroy。
- `recalcHrAttendanceDays(dateFrom,dateTo)` 复用 `hr.attendance_day:recalc`：
  - `dateFrom <= dateTo`
  - `Date.diff(dateTo,dateFrom) <= 366`
  - 重算区间内“打卡 ∪ 补卡 ∪ 已有日行”涉及的唯一员工日 pair
  - 返回 pair 数，不是自然日数或员工数
- `hrAttendanceMonthSummary(month)` 复用 `hr.attendance_day:read`；月份必须
  `YYYY-MM`。每员工返回：
  `employeeId/employeeCode/employeeName/days/missingDays/normalHours/
  overtimeHours/bonusWorkdays/workdays`。
- `workdays = ΣnormalHours / 8 + ΣbonusWorkday`；所有 Decimal 是 string；只返回当月
  有日行的员工，按员工 code/name 排序。
- 日考勤不接 Audit Track；来源导入批次/补卡单负责留痕。

`recalc` 是旧 Ash generic action，`transaction?=false`；内部多个 upsert/destroy 不是
一个覆盖整个区间的事务。重算按员工日没有额外行锁；并发导入/补卡若各自在读取时只看到
自己的未提交事实，最后 upsert 可能覆盖另一方刚算出的派生值。迁移验收至少不能误宣称旧
系统已提供 pair 级串行；若 Go 收紧为按 pair 锁/最终重算，应作为并发正确性增强记录。

### `AttendanceCorrection`

- 一单一人一天 1～20 个本地时刻；`(employee_id,date)` 唯一；备注最多 200。
- create/update 输入 `employeeId/date/times/note`；destroy 无输入。权限分别为
  `hr.attendance_correction:create/update/delete`，read 为 `:read`。
- 保存前把时刻截到秒、去重、升序；因此输入 1～20 个元素规整后可能少于原数量。
- create 记录 Actor 为 `created_by`；update 不改录入人。
- create/update/destroy 都在自身事务 after-action 重算；update 换人/改日时新旧 pair
  都重算。
- 补卡单接 Audit Track；补卡变更、派生日考勤变更与审计日志在调用动作事务内。

## 工资单

### 字段、公式与快照

- `(employee_id,month)` 唯一；month 必须 `YYYY-MM`、最多 7。
- 输入快照字段：
  `workdays/attendanceDays/missingDays/overtimeHours/dailyWage/allowance/
  bonus/fine/loanDeduction/remarks`。
- 除 remarks 外上述数值都不能为负；默认 0。数据库 Decimal 没有固定 precision/scale。
- `baseAmount = round(workdays × dailyWage, 2)`。
- `payable = baseAmount + allowance + bonus - fine - loanDeduction`。
- `baseAmount/payable/status/paidTotal` 不接受客户端写。输入项非负不代表 payable 必然
  非负；旧实现没有 `payable >= 0` 约束。
- 状态只有 `PENDING/PAID`；`paidTotal` 是所有发放金额（含负数）的 sum，可空。
- 不接编号规则；`(员工,月份)` 是业务标识；不记录 created_by。

### 动作

| action | GraphQL | 权限 | 契约 |
|---|---|---|---|
| read | `hrPayrolls` | `hr.payroll:read` | offset list |
| create | `createHrPayroll` | `:create` | 手工特批建单 |
| update | `updateHrPayroll` | `:update` | 仅 pending，不可换员工/月 |
| refresh | `refreshHrPayroll` | `:update` | 仅 pending，重取考勤/员工快照 |
| destroy | `destroyHrPayroll` | `:delete` | 仅 pending |
| generate | `generateHrPayrolls` | `:create` | 按月批量建单 |
| month_stats | `hrPayrollMonthStats` | `:read` | 月统计 |
| mark_paid/pending | **不公开** | 内部 | 只由发放联动 |

- update/destroy/refresh 都先 `FOR UPDATE` 锁工资单并权威复检 pending。
- refresh 重取工日、出勤/缺卡、加班、日薪、补贴并重算；奖金、罚款、借款抵扣、备注
  保持不变。
- generate 只为当月有日考勤的员工生成；员工档案日薪/补贴空值按 0；已有
  `(员工,月)` 跳过不覆盖。返回 `{"created":n,"skipped":n}`，其中 skipped 是该月全部
  既有工资单员工数。
- generate 是覆盖全批的服务端事务，逐行走 Payroll create，所以每张工资单有独立
  create 审计。批次内部授权已由 generate 动作完成，不额外要求逐员工读取权限。
- month stats 返回
  `count/pendingCount/payableTotal/paidTotal`，Decimal 为 string；负数发放参与实发合计。
- 工资单接 Audit Track。普通 create/update/refresh/destroy 及内部
  `mark_paid/mark_pending` 都记录真实 action name；失败/no-op 不留日志。

并发边界：

- 同一工资单的改、删、刷新、发放、删发放均以工资单行锁串行。
- generate 先批量读 existing 再逐行 insert，数据库唯一键兜底；两个并发 generate
  没有 conflict-skip/retry，一方可能因唯一冲突使整批事务回滚。

## 工资发放

字段：

- 外部 create 只接 `payrollId/paidOn/amount/remarks`。
- `month/employeeId/kind` 不接受客户端写，由锁内工资单快照强制回填；数据库/GraphQL
  仍显示为 nullable，这是旧“必填校验早于 before_action”的技术让步。
- `paidOn` 是必填 Date；amount 是任意非零 Decimal，允许负数冲回；无正数限制。
- `createdBy` 从 Actor 写入，可空；发放无编号。

动作与状态联动：

- `createHrPayrollPayment` 须 `hr.payroll_payment:create`。事务内锁工资单：
  - 当前 pending：类型强制 `NORMAL`，无论金额是否等于应发都立即翻工资单为 paid；
  - 当前 paid：类型强制 `SUPPLEMENT`。
- `payRemainingHrPayrollPayment` 同样复用 create 权限，只接
  `payrollId/paidOn/remarks`；锁内计算
  `remaining = payroll.payable - Σpayments.amount`，仅 `remaining > 0` 可创建。
- `destroyHrPayrollPayment` 须 `hr.payroll_payment:delete`。发放记录不可 update。
- 删除 `NORMAL` 即把工资单翻回 pending 并删该工资单全部自动借款归还行，**即使仍有
  SUPPLEMENT**；再次发放会产生新的 NORMAL。
- 删除 SUPPLEMENT：若仍有其他发放不翻状态；若删除后零条，则兼容性回退 pending。
- 工资单可能因此处于 pending 但仍残留 supplement；paid sum 与 pay_remaining 都继续
  包含残留行。

借款抵扣联动：

- 仅 NORMAL 创建时，若 `loanDeduction > 0`，校验员工当前借款余额足够；不足则整个
  发放失败。
- 成功后同事务创建 `EmployeeLoan(kind=REPAY, payrollId=工资单, occurredOn=paidOn,
  amount=loanDeduction)`；SUPPLEMENT 不重复校验/归还。
- 删除 NORMAL 同事务删除该工资单全部自动归还行。

发放记录、工资状态、自动借款行以及它们各自的审计日志均在同一发放/删除事务提交。
并发创建、pay_remaining、删除由工资单 `FOR UPDATE` 串行，所以同一时刻只会有一条动作
基于旧状态/旧 paid sum 成功。借款手工台账不锁工资单/员工；余额校验与并发手工归还之间
存在旧 ADR 明示接受的窄竞态。

## 员工借款台账

- 类型 `BORROW/REPAY`；日期必填；amount 必须 `> 0`；余额允许为负，不做单笔核销。
- 手工 create/update 接 `employeeId/kind/occurredOn/amount/remarks`；created_by 仅
  create 从 Actor 写入。
- 手工 read/create/update/delete 分别用
  `hr.employee_loan:read/create/update/delete`。
- `payroll_id IS NULL` 是手工行，可自由改删；非空是工资发放联动行，普通 update/delete
  一律拒绝，须从发放记录侧处理。
- 内部 `auto_repay/auto_destroy` 不注册 GraphQL，分别归口 create/delete 权限作纵深
  防御，实际只由发放事务 `authorize?: false` 调用。
- `hrEmployeeLoanBalances` 复用 read 权限，返回每个有台账员工的
  `employeeId/employeeCode/employeeName/borrowed/repaid/balance`，Decimal 为 string，
  按员工 code/name 排序。
- 台账接 Audit Track；手工与自动行的 create/update/destroy 均留 action-name 真实日志。
- employee、payroll、created_by FK 都未配置 cascade/nullify；默认数据库 restrict。

## PostgreSQL 关系与删除矩阵

| 父事实 | 子事实 | DB 删除行为 |
|---|---|---|
| 导入批次 | 打卡 | `ON DELETE CASCADE` |
| 员工 | 七资源中的员工 FK | restrict |
| 文件 | 导入批次 | restrict |
| 用户 | created/imported/created_by FK | restrict |
| 工资单 | 发放记录 | restrict |
| 工资单 | 自动借款归还行 | restrict |

工资单业务 destroy 只检查 pending；若因“删 NORMAL 但保留 SUPPLEMENT”形成 pending +
残留发放，状态门通过后仍会被数据库 FK 拒绝。这是旧实现的实际双重闸。

## GraphQL 公开面

`graphql-surface.json` 精确冻结 **10 个 query**、**18 个 mutation** 与 **154 个相关
类型**（含对象、输入、分页、筛选、排序和 enum）。

Queries：

- `hrAttendancePunches`
- `hrAttendanceImports`
- `hrAttendanceDays`
- `hrAttendanceCorrections`
- `hrAttendanceMonthSummary`
- `hrPayrolls`
- `hrPayrollPayments`
- `hrPayrollMonthStats`
- `hrEmployeeLoans`
- `hrEmployeeLoanBalances`

Mutations：

- 导入：`createHrAttendanceImport/importHrAttendanceImport/destroyHrAttendanceImport`
- 补卡：`create/update/destroyHrAttendanceCorrection`
- 日考勤：`recalcHrAttendanceDays`
- 工资单：`create/update/refresh/destroyHrPayroll`、`generateHrPayrolls`
- 发放：`create/destroyHrPayrollPayment`、`payRemainingHrPayrollPayment`
- 借款：`create/update/destroyHrEmployeeLoan`

明确**不公开**：

- 打卡单条 CUD
- 日考勤行 CUD
- 工资单 `mark_paid/mark_pending`
- 借款 `auto_repay/auto_destroy`

迁移不能为实现方便把上述内部动作做成通用 REST CRUD。

## 旧前端消费面

### 考勤

- `/hr/attendance/punches`：只读打卡 Grid，`punchedAt DESC`。
- `/hr/attendance/imports`：批次 Grid，`insertedAt DESC`；上传文件仍走既有文件 REST，
  随后 GraphQL create 解析；自定义抽屉执行导入、自动建员工、删除/撤销。
- `/hr/attendance/days`：只读日考勤 Grid，`date DESC`；页面显式提供区间重算。
- `/hr/attendance/corrections`：补卡 Grid，`insertedAt DESC`；自定义多 Time 编辑器，
  create/update 自定义 mutation，删除复用 Grid destroy。
- `/hr/attendance/monthly`：定制月汇总表，不走 Grid；解析 JsonString 行。

### 工资与借款

- `/hr/payroll/slips`：月份 fixed filter 的工资 Grid；手工建单、修改、重取快照、单张/
  批量 pay_remaining；抽屉内另列该工资单发放记录（`paidOn ASC, limit=200`）。
- 工资发放按钮必须按 **`hr.payroll_payment:create`** 门控，不能借
  `hr.payroll:update` 扩权。
- `/hr/payroll/payments`：全量发放 Grid，`paidOn DESC`，只读详情与删除，无 edit。
- `/hr/payroll/loans`：余额定制表 + 台账 Grid，`occurredOn DESC`；有 payrollId 的自动行
  前端只给 view，服务端仍须强制拒绝手改手删。
- 前端变更发放时会同时失效工资、发放、借款、月统计和借款余额缓存；REST 迁移必须保持
  跨资源联动，不能只刷新单表掩盖不一致。

## 迁移验收清单

- 14 份 GridMeta 逐 JSON 语义对拍；无伪造 RecordMeta。
- 10 query、18 mutation 的公开/内部边界与 snapshot 一致。
- 七资源全局可见、不引入 company_id/CompanyScope。
- Decimal、日期、时间、UTC DateTime 与五组 enum wire 一致。
- 导入解析、防重、文件权限、自动建员工双权限、0 行导入、批次锁、级联撤销与自动重算
  一致。
- 打卡 unique、导入并发冲突和日考勤 pair 并发缺口有真实 PostgreSQL 证据。
- 12 点切桶、分段半小时取整、缺卡、加班、奖励与月工日公式逐边界测试。
- 补卡规整、同日唯一、换人/换日双重算与审计同事务。
- 工资公式、快照 generate/refresh、pending 行锁、唯一与批量生成事务一致。
- 发放非零含负、NORMAL/SUPPLEMENT 判别、pay_remaining 锁内算差额、删除回退一致。
- 借款余额、自动归还、余额不足整笔失败、自动行禁手改删与窄竞态一致。
- Audit Track 覆盖导入/补卡/工资/发放/借款；打卡/日考勤不逐行审计。
- 旧 HR 五个考勤页面、三个工资页面和跨资源失效消费面均有 REST 等价实现。
