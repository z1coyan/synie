# 银行流水导入设计

日期:2026-07-14

## 定位(产品)

#10 银行流水/导入模板的收尾:导入执行落地。用户流程(产品拍板):

1. 银行流水页工具栏,「新增」左侧「导入」下拉:**导入历史** / **新增导入**。
2. 新增导入 → 宽抽屉表单:导入公司、银行账户、导入模板(按账户过滤)、上传 xlsx 文件。
3. 点「解析」→ 表单锁定,后端按模板解析 excel 存入**导入行**表,抽屉展示解析结果或报错。
4. 用户当场确认,或之后从导入历史点开(状态**已解析**),编辑/删除有问题的行,点「导入」。
5. 导入行批量转正为银行流水;导入记录状态**已导入**,只允许查看。

两个新资源,无独立页面/菜单(入口全在银行流水页):

| 资源 | 表 | 权限 |
|---|---|---|
| 导入记录 `SynieCore.Acc.BankImport` | `acc_bank_import` | 借 `acc.bank_transaction` 前缀,全动作 `{HasPermission, as: "import"}` |
| 导入行 `SynieCore.Acc.BankImportItem` | `acc_bank_import_item` | 同上 |

## 权限:单一权限码 `acc.bank_transaction:import`

`BankTransaction.permission_actions` 加 `import`(#10 留问的答案:单设权限点,但只此一个)。整个导入链路——记录增删查、行编辑删除、导入执行——全部复用该码:两个新资源照 `GlJournalLine` 先例 `permission_prefix "acc.bank_transaction"` + `permission_actions []`(不进权限目录,矩阵只在「银行流水」行新增「导入」一格,动作标签 `import: '导入'` 已有)。

- 工具栏「导入」下拉由流水表格 meta 的 `can('import')` 门控,零新增接线。
- 历史抽屉/记录抽屉内的按钮不再单独门控:能读到数据即持码(读策略同样 `as: "import"`,fail-closed)。
- 导入执行创建流水时**带 actor 走正常授权**:用户还需 `acc.bank_transaction:create`(纵深防御,CompanyAccessible/停用账户校验一并复用);上传文件需既有 `sys.file:create`。授权提示写入权限矩阵使用文档由管理员自理。

## 资源 1:导入记录 `acc_bank_import`

| 字段 | 类型 | 说明 |
|---|---|---|
| company / bank_account / template | belongs_to | 必填;校验:同公司账户且启用(复用 OwnBankAccount check_active)、模板属于该账户 |
| file | belongs_to sys_file | 必填;上传走既有 REST `/api/files`(裸文件不挂 attachment),create 只收 file_id;用 actor 重读校验可见性 |
| status | enum parsed/failed/imported | 已解析/解析失败/已导入;graphql `acc_bank_import_status` |
| error | string(500) | 记录级解析失败原因(failed 时) |
| imported_at / imported_by | utc_datetime / belongs_to user | 导入执行留痕 |
| created_by | belongs_to user | 发起人,create change 从 actor 回填 |
| item_count / error_count | count 聚合 | 行数/错误行数(error 非空行);聚合实时准确,不落列 |

**create = 解析**(一个动作,不设 pending 态):验证过后 before_action 读文件解析(纯内存,失败不 raise 而是 force_change status=failed+error),单次 INSERT 落正确状态;after_action 把解析行 `Ash.bulk_create`(authorize?: false,GL.post! 先例;带 actor 供审计)插入导入行表。文件不可读/零数据行/超行数上限(5000)→ failed 记录照常落库(导入历史可见报错)。

**去重防呆**:create 校验同账户已存在 status≠failed 且 file.sha256 相同的导入记录 → 拒绝(「该文件已导入过,如需重导请先删除原记录」)。行级指纹仍是范围外。

**update :import**(GraphQL `importAccBankImport`):照 VAT audit 先例——构建期预检 status=parsed,change 里 force_change status/imported_at/imported_by,before_action 事务内 FOR UPDATE 重读复检(关双导入竞态),after_action 逐行 `Ash.create!` 银行流水(**带 actor**)并回填行的 transaction_id(authorize?: false)。前置:行数>0 且全部 error 为空;任一行失败 → 整事务回滚,报「第 N 行:…」。

**destroy**:仅 parsed/failed 可删(imported 留档不可删),预检+锁复检;行表 `reference :import, on_delete: :delete` 级联(凭证删行先例,行不留单独审计)。

**无 header update 动作**:解析后表单锁定(产品要求),配置错了删掉重来。

## 资源 2:导入行 `acc_bank_import_item`

| 字段 | 类型 | 说明 |
|---|---|---|
| import | belongs_to | 必填,级联删 |
| company_id | uuid | 从导入记录冗余(CompanyScope 读策略依赖,GlJournalLine 先例) |
| row_no | integer | excel 行号(1 起),read 默认按它升序 |
| occurred_at/income/expense/balance/counterparty_name/counterparty_account/summary/note | 同流水字段 | 全部可空(解析失败的字段留空),长度约束同流水 |
| error | string(500) | 行错误(解析/校验),nil = 可导入 |
| transaction | belongs_to bank_transaction | 导入后回填,追溯 |

**update**(用户修行):仅收业务字段;guard change 照 SyncJournal——父记录须 parsed,构建期预检 + before_action FOR UPDATE 锁父记录(与导入执行互斥);校验 occurred_at 必填 + 收/支恰一项>0(复用 BankTransaction.SingleSidedAmount);通过即 force_change error=nil(错误即时清除,前端实时看到 error_count 归零)。**destroy**:同 guard(删掉合计行/垃圾行,解锁导入)。create 不注册 GraphQL mutation(仅解析内部用)。

## 解析器 `SynieCore.Acc.BankImport.Parser`

纯函数模块:`parse(template, xlsx_binary) → {:ok, [%{row_no, fields..., error}]} | {:error, 记录级消息}`。

- 依赖新增 `{:xlsx_reader, "~> 0.8"}`(纯 Elixir,仅 xlsx;.xls 拒绝并提示另存为 xlsx——#10 预设的取舍,选后端解析是产品拍板)。二进制经 `Storage.read` 取回,`open(bin, source: :binary)`,取第一个工作表。
- 单元格取值:`number_type: String`(对方账号等长数字防浮点失真),日期格式单元格靠库的类型转换得 Date/NaiveDateTime/Time 结构,**原生日期类型优先于模板格式枚举**(#10 拍板),文本单元格才按格式枚举正则解析。
- 时间:单列/双列模式按模板;时间列缺省 00:00:00。**本地时间→UTC**:按固定偏移 `config :synie_core, :bank_import_utc_offset_minutes`(默认 480,即 UTC+8;国内无夏令时,不引 tzdata)。
- 金额:双列模式 0/空视为未填,恰一项>0,负数报行错误(提示检查列配置);单列带符号按正负拆收/支,0 报错。千分位逗号/空格剥离后 Decimal 解析。
- 行处理:从 start_row 起,所配列全空的行静默跳过(表尾空行);任何字段解析失败/超长 → 该行落库带 error,不阻塞其他行。数据行 0 行或 >5000 行 → 记录级 failed。
- 列号字母→索引(A=1…AA=27),模板已保证 1-2 位大写。

## 前端(全部挂在 bank-transactions.tsx,组件放 `components/bank-import/`)

**组件扩展**(先扩组件再用,三处小改):

1. `use-grid-actions`:工具栏动作序改为 导入、新增、导出(导入在新增左侧,产品要求);
2. `SynieDataGrid` 新 prop `importMenu?: {key,label,onAction(ctx)}[]`——提供时「导入」渲染为 Dropdown(仍由 `can('import')` 门控),流水页传 [导入历史, 新增导入];
3. `SynieRecordDrawer` 新 props `submitLabel?: string`(默认「保存」,导入表单用「解析」)、`footerActions?: (mode,row) => ReactNode`(view 态 footer 附加按钮,放「导入」主操作)。

**新增导入抽屉**(SynieRecordDrawer create,`w-full lg:w-[720px]`):companyId(effects 清账户+模板)→ bankAccountId(RemoteSelect 同公司启用账户,labelField alias)→ templateId(RemoteSelect accBankImportTemplates 按 bankAccountId 过滤,**直连必传 labelField name**);文件选择器在 extraContent(HeroUI 文件控件,实施时经 MCP 确认选型;仅 .xlsx,File 对象存页面状态)。onSubmit:`uploadFile` → create mutation(返回 id/status/error/itemCount/errorCount)→ toast 分状态反馈 → 关 create 抽屉、开记录抽屉看结果。

**导入记录抽屉**(SynieRecordDrawer view,rowId 自查,`w-full lg:w-[880px]`,无 onEdit):

- 头字段:公司/账户/模板/文件(fk)/状态/错误/导入时间/导入人;failed 时 extraContent 顶部 danger 横幅展示 error。
- 行区(status≠failed):**SynieDataGrid** resource accBankImportItems、`fixedFilter {importId eq}`、defaultSort rowNo asc(行可上千,要分页筛选,故不用 EditableTable);列白名单 rowNo/occurredAt/income/expense/balance/counterpartyName/summary/error,error 列红字渲染。parsed 态 rowActions(不门控):编辑 → 二级 SynieRecordDrawer(update mutation,**保存即持久化**,服务端顺手清 error,刷新行表与聚合;不走 journals 的攒批 diff——错误状态要实时回显)、删除 → 确认框 + destroy mutation。imported 态无行操作。
- footerActions:parsed 态「导入(N 行)」主按钮,errorCount>0 或 0 行时禁用并说明;确认框「将创建 N 条银行流水」→ importAccBankImport → 成功后刷新记录抽屉/历史/流水主表格。
- 抽屉内嵌 DataGrid + 三层 Sheet 叠放沿用 EditableTable 内嵌抽屉先例。

**导入历史抽屉**(HeroUI Sheet 容器 + SynieDataGrid accBankImports,`w-full lg:w-[880px]`):列 companyId/bankAccountId/templateId/status/itemCount/errorCount/insertedAt/createdById,status 胶囊(parsed 蓝/failed 红/imported 绿);onView 开导入记录抽屉(历史抽屉保持在下层);rowActions 删除(imported 行 onAction 预检提示不可删,后端兜底)。

## 系统接入清单

- `synie_core.ex`:queries `acc_bank_imports`/`acc_bank_import_items`(offset 分页);mutations create/import/destroy BankImport、update/destroy BankImportItem。
- GridMeta `@resources`:`accBankImports`/`accBankImportItems`;**顺带登记 `sysFiles`**(file 资源补 `display_field :filename` 与 read 分页/list query,使导入记录的文件 fk 显示文件名而非 uuid)。
- 前端 registry.ts:accBankImports「流水导入」、accBankImportItems「导入行」、sysFiles「文件」;logs.tsx 表标签 `acc_bank_import` 银行流水导入 / `acc_bank_import_item` 银行流水导入行;permission-labels **零改动**(import 动作标签已有)。
- 迁移:`mix ash_postgres.generate_migrations` + `mix ecto.migrate`(ash.migrate 本机失效)。
- 审计:两资源挂 Audit.Fragment,update/destroy `require_atomic? false`,destroy `primary? true`;解析批量插行照实逐行进审计(行数上限兜量)。

## 测试

- Parser 纯函数:test support 造 xlsx 二进制(:zip 手拼最小 OOXML,兼作 E2E 夹具生成);覆盖单列/双列时间、带符号单列金额、原生日期单元格优先、千分位、负数/双填/全空行错、超长截断报错、0 行/超限 failed。
- 导入记录:create 即解析落 parsed/failed;同文件去重拒绝;模板-账户不匹配拒绝;import 前置(有错误行/0 行拒绝)、成功后流水落库+行回填 transaction_id+状态 imported;双导入竞态(锁复检);imported 不可删;无 create 权限的 actor 导入被每行策略拒绝(整体回滚)。
- 导入行:父状态 guard(imported 拒改删)、SingleSidedAmount、修复后 error 清空;CompanyScope fail-closed。
- 前端:bun checks(grid/record-drawer 断言如受影响);E2E 走查全流程(建模板→新增导入→解析→改错行→导入→历史只读)。

## 否决的备选

- **前端 SheetJS 解析后提交结构化行**(#10 曾倾向):产品明确「后端解析上传的 excel」;后端解析可信、可测、留原始文件档案。代价是放弃 .xls 支持(提示另存)。
- **导入历史/记录用独立路由页**:产品描述是流水页弹层交互;抽屉方案零菜单/零路由增量。
- **BankImport 独立权限前缀 `acc.bank_import`**:会在权限目录多一行、且流水页工具栏 `can('import')` 门控接不上;单码方案矩阵零膨胀、入口反射零接线。
- **导入行攒批保存(journals diff 先例)**:行错误清除要实时反馈 error_count,保存即持久化;抽屉中途关闭也不丢已改行。
- **解析拆独立 mutation(create 先落 pending)**:多一态多一跳,「解析」按钮语义就是 create+parse 一步。
- **行内嵌 EditableTable**:无分页,千行导入撑爆抽屉 DOM;DataGrid fixedFilter 已够。

## 裁量(自主拍板,评审可推翻)

1. 仅支持 .xlsx(Elixir 生态无 .xls 解析;报错文案引导另存)。
2. 时区固定偏移 UTC+8 可配置(不引 tzdata)。
3. 行数上限 5000/次(审计量与事务时长兜底)。
4. 同账户同文件(sha256)非 failed 记录存在即拒绝重传(防呆,可删旧记录绕开)。
5. imported 记录禁删(台账追溯);parsed/failed 可删。
6. 导入执行带 actor 创建流水:import 权限之外还需 transaction create 权限(纵深防御)。
7. 双列金额 0 视为空、负数报错;单列 0 报错。

## 范围外(跟进项)

- 行级指纹去重(同文件内/跨文件重复行识别)。
- 流水 → 导入批次的反向可视化(现只能从导入行 transaction_id 正查)。
- 模板被导入记录引用后删除的友好报错(现靠 DB FK restrict 兜底)。
- 导入文件下载按钮(现文件 fk 速览可见元信息)。
- 解析失败记录的「重新解析/换文件」(现删了重来)。
- 「金额列(正数)+ 收/支方向列」第三金额模式(#10 既有跟进项,模板层缺口)。
- 上传后 create 失败产生的孤儿 sys_file 清理。
