# 银行流水模块设计

日期:2026-07-12

## 定位(产品)

- **银行流水台账**:登记公司各银行账户的收支流水,是银行对账单的电子档案。每行流水 = 银行导出文件里的一行:交易时间、收入/支出、余额快照、对方信息、摘要,可挂附件(汇款凭证截图等)。
- **数据以银行为准**:余额是银行口径的快照,系统不推算、不校验连续性;流水不参与记账。
- **主要录入路径是导入**(银行导出的 xls/xlsx),本轮先做手工 CRUD 与**导入模板管理**(单独页面、单独权限);导入执行本轮不做。
- **不做凭证关联**:不像增值税发票那样接 GL,后续通过其他方式补(届时凭证关联轮再设计)。

两个资源、两个页面,均归财务域「资金」菜单组:

| 资源 | 页面 | 权限前缀 |
|---|---|---|
| 银行流水 `acc_bank_transaction` | `/finance/bank-transactions` | `acc.bank_transaction` |
| 流水导入模板 `acc_bank_import_template` | `/finance/bank-import-templates` | `acc.bank_import_template` |

## 资源 1:银行流水 `SynieCore.Acc.BankTransaction`

| 字段 | 类型 | 约束 |
|---|---|---|
| company | belongs_to 公司 | 必填;建后不可改(update 不收 company_id,照银行账户先例) |
| bank_account | belongs_to 银行账户 | 必填;校验同公司;create 时校验账户启用(停用账户不再录新流水;update 只校验同公司,允许改错录归属) |
| occurred_at | utc_datetime | 交易时间,必填(带时分秒,见组件缺口①) |
| income | decimal | 收入金额,可空 |
| expense | decimal | 支出金额,可空 |
| balance | decimal | 余额,可空(银行口径快照,不推算) |
| counterparty_name | string(128) | 对方户名,可空(利息/手续费行常无对方) |
| counterparty_account | string(64) | 对方账号,可空 |
| summary | string(255) | 摘要(银行摘要/用途),可空;作 display_field(可空,速览标题缺省退 id,凭证关联轮再定) |
| note | string(255) | 备注(内部备注,区别于银行摘要),可空 |

**金额互斥**:收入/支出恰好一项非空,且该项 ≠ 0(允许负数——银行冲正/退款行现实存在,见开放疑问 1)。校验模块 + DB CHECK 双保险(照 `acc_gl_entry` `single_sided_amount` 先例):`(income IS NULL) <> (expense IS NULL)` 且非空项非零。

**货币不落字段**:随账户(fk 速览可见),报表需要时再加。索引:`(company_id, bank_account_id, occurred_at)` 常规查询索引。

权限/审计照 `Acc.BankAccount` 样板:super_admin bypass + HasPermission 全动作 + CompanyScope fail-closed 读;create 挂 `CompanyAccessible`;审计 fragment,update/destroy `require_atomic? false`,destroy `primary? true`。permission_actions:`create read update delete`(导入落地后 import 是否单设权限点届时定)。

## 资源 2:流水导入模板 `SynieCore.Acc.BankImportTemplate`

一个账户可建多个模板(同一银行不同导出渠道格式不同),不设账户维度唯一。

| 字段 | 类型 | 约束 |
|---|---|---|
| company | belongs_to 公司 | 必填;建后不可改 |
| bank_account | belongs_to 银行账户 | 关联的银行账户,必填;校验同公司 |
| name | string(64) | 模板名称,必填,同公司内唯一;作 display_field(默认反射) |
| start_row | integer | 起始行(数据首行,1 起数),必填,min 1,默认 2 |
| datetime_col / datetime_format | string(2) / string(32) | 日期时间列 / 格式(单列模式) |
| date_col / date_format | string(2) / string(32) | 日期列 / 格式(双列模式) |
| time_col / time_format | string(2) / string(32) | 时间列 / 格式(双列模式,可省) |
| income_col | string(2) | 收入金额列 |
| expense_col | string(2) | 支出金额列 |
| balance_col | string(2) | 余额列 |
| counterparty_name_col | string(2) | 对方户名列 |
| counterparty_account_col | string(2) | 对方账号列 |
| summary_col | string(2) | 摘要列 |
| note_col | string(2) | 备注列 |

**列号**:1-2 位字母(A-Z、AA-ZZ,兼容超 26 列的导出),constraints match + change 归一大写。

**时间配置二选一**(校验模块):

- 单列模式:`datetime_col` 有值 → `datetime_format` 必填,且 date/time 四字段必须为空;
- 双列模式:否则 `date_col` + `date_format` 必填;`time_col` 可空(缺省时间按 00:00:00),填了则 `time_format` 必填。

**金额列**:`income_col`/`expense_col` 至少一列必填,其余列全可空(缺列导入时该字段留空)。

**格式串**是自由文本,按 `YYYY/MM/DD/HH/mm/ss` token 约定给 placeholder 示例(如 `YYYY-MM-DD HH:mm:ss`);解析语义留导入轮实现(Excel 原生日期类型单元格届时优先于格式串,文本单元格才按格式解析)。本轮不校验格式串内容。

权限/审计/公司隔离同流水资源(前缀 `acc.bank_import_template`)。模板不挂附件。

## 组件缺口(本轮顺带扩展)

1. **SynieRecordDrawer 的 datetime 编辑粒度**:现状编辑态按日期粒度截取(`SynieRecordDrawer.tsx` 内注释已预留"业务需要时分秒时换带 granularity 的 DateField")。交易时间要到时分秒:datetime 类型编辑态换带时间粒度的日期时间控件(HeroUI v3,实施时经 MCP 确认选型),`fields.ts` 值转换保留完整 ISO 串(存 UTC、显示本地),同步更新 record-drawer-checks 既有断言。date 类型行为不变。
2. **SynieDataGrid 无默认排序**:加可选 `defaultSort` prop(初始 sort state 用它),流水页默认 `occurredAt DESC`。其他页面不受影响。

## 前端页面

**银行流水页** `routes/_app/finance/bank-transactions.tsx`(照 `bank-accounts.tsx` 结构):

- DataGrid 列白名单:companyId、bankAccountId、occurredAt、summary、income、expense、balance、counterpartyName;对方账号/备注/时间戳不进表格(抽屉 rowId 自查完整记录);`defaultSort` occurredAt DESC。
- RecordDrawer fields:companyId 首字段 createOnly,effects 清 bankAccountId;bankAccountId 用 RemoteSelect 按表单公司过滤(`companyId eq` + `active eq true`,照银行账户绑定科目先例);occurredAt 必填;income/expense 并排 cols 6,轻量联动(一侧填非零值 effects 清对方);counterpartyName/counterpartyAccount 并排 cols 6。
- 附件:SynieAttachmentPanel 挂 extraContent,ownerType `acc_bank_transaction`(汇款凭证截图等)。

**流水导入模板页** `routes/_app/finance/bank-import-templates.tsx`:

- DataGrid 列白名单:companyId、name、bankAccountId、startRow、datetimeCol、dateCol(列配置细节抽屉里看)。
- RecordDrawer fields:companyId 首字段 createOnly + effects 清账户;bankAccountId RemoteSelect 同公司过滤;startRow 默认 2;列号/格式字段两两并排(cols 6),placeholder 写清用法(「填列号字母,如 D」「二选一:填了日期时间列就别填日期/时间列」「格式如 YYYY-MM-DD HH:mm:ss」)。

## 系统接入清单(既有规范逐项过)

- `synie_core.ex`:queries `acc_bank_transactions`/`acc_bank_import_templates`(offset 分页)+ 各三 mutation,resources 登记。
- GridMeta `@resources`:`accBankTransactions`/`accBankImportTemplates`。
- `SynieCore.Files.OwnerRegistry`:登记 `acc_bank_transaction`;**顺带补漏 `acc_bank_account`**(#8 遗漏——银行账户页附件面板已上线但 owner_type 未登记,上传挂接 fail-closed 报「未知宿主」,现为主干既有 bug)。
- 前端:抽屉 `registry.ts` 两资源配置;菜单 `menu.ts` 财务「资金」组补「银行流水」「流水导入模板」;`permission-labels.ts` 补 `acc.bank_transaction` 银行流水 / `acc.bank_import_template` 流水导入模板;`logs.tsx` 补两表中文标签。
- 迁移走 `mix ash_postgres.generate_migrations` + `mix ecto.migrate`(`mix ash.migrate` 本机失效)。
- 非 super_admin 需在权限矩阵勾选两资源才能见新页面(fail-closed 预期)。

## 测试

- 流水:金额互斥(双空/双填/单项为零拒绝,负数放行);账户同公司校验、停用账户拒新增(update 放行);CompanyScope fail-closed 读。
- 模板:时间配置二选一(单列缺格式、双列缺日期格式、两模式混填均拒);金额列至少其一;列号归一大写与非法列号拒绝;同公司重名拒绝(跨公司放行);账户同公司校验。
- 前端 checks:datetime 编辑粒度断言更新、defaultSort 初始化;E2E 走查两页(建模板、录流水含附件、编辑回填、权限矩阵勾选可见性)。

## 否决的备选

- **收入/支出合一带符号金额列**:对账单双列是国内主流呈现,双列直观;单列±格式的源文件适配放导入模板层(见开放疑问 2)。
- **余额由系统推算/连续性校验**:流水是银行事实快照,推算需全量有序且与银行口径必然打架;仅存档。
- **通用导入模板框架**(sys 级泛化):YAGNI,当前只有银行流水一个导入场景;未来第二个场景出现再抽象。
- **流水挂 AutoNumber 单据编号**:流水非单据,以银行数据为准,无编号需求。
- **模板内嵌进银行账户表单**(不设独立页面):用户明确要单独页面、单独权限;且一账户多模板,独立资源更顺。

## 范围外(跟进项)

- **导入执行**:上传 → 按模板解析 → 预览确认 → 批量入库;届时定 xls/xlsx 解析方案(Elixir 库基本仅支持 xlsx,倾向前端 SheetJS 解析后提交结构化行,或限定 xlsx)、去重策略(可能加行指纹列)、导入批次追溯、import 权限点。
- **凭证关联**:用户明确后置,另行设计(届时流水 display_field 的可空问题一并定)。
- **银行对账**(流水 vs 总账勾稽)。
- 币种字段(现随账户)、多时区(现按本地时区理解,存 UTC)。
- OwnerRegistry 漏登记的防呆:AttachmentPanel 接入与 OwnerRegistry 登记二者无编译期关联,漏了只在运行时暴露(#8 已踩),可考虑测试反射兜底,单独一轮做。

## 开放疑问(已按推荐决策推进,如异议请指出)

1. **金额允许负数**(恰一项非空且 ≠ 0):为银行冲正/退款行留路。若你确定手工录入阶段不需要,可收紧为 > 0,导入轮再放开。
2. **单列±金额的源文件**(微信/支付宝账单、部分银行只有一列「交易金额」):本轮模板未支持,需要的话加「金额列(带符号)」第三模式(与收入/支出双列互斥)。你若确定要导微信/支付宝账单,建议本轮就加。
3. **列号上限放宽到两位字母**(AA-ZZ):你说的 A-Z 覆盖 26 列,个别银行导出超 26 列,放宽无成本。
4. **时间双列模式下 time_col 可省**(缺省 00:00:00):部分银行导出只有日期无时间,不省则这类文件无法建模板。
5. **格式串本轮不校验内容**:解析方言(YYYY/MM/DD token)导入轮才落地,现在校验没有依据;placeholder 给示例引导。
