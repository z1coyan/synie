# 银行流水导入实施计划

> Spec:`docs/superpowers/specs/2026-07-14-bank-import-design.md`。按任务顺序 TDD、频繁提交。

**目标:** 银行流水导入执行:流水页「导入」下拉入口 → 上传 xlsx 按模板解析入导入行 → 确认/修行 → 批量转正为银行流水,导入记录状态机(已解析/解析失败/已导入)。

**关键技术决策(探索已定):**

- 依赖新增 `{:xlsx_reader, "~> 0.8"}`;仅 .xlsx,`Storage.read` 取回二进制 `open(bin, source: :binary)`;`number_type: String` 防长数字失真,原生日期单元格优先于格式枚举。
- 权限单码 `acc.bank_transaction:import`:BankTransaction permission_actions 加 import;两新资源照 `GlJournalLine` 借前缀 + actions 空,全动作 `{HasPermission, as: "import"}`;导入执行创建流水**带 actor**(纵深防御)。
- create 即解析:before_action 解析(失败落 failed 不 raise),after_action `bulk_create` 导入行(authorize?: false 带 actor);import 动作照 VAT audit 先例(预检 + FOR UPDATE 复检 + after_action 逐行建流水回填 transaction_id)。
- 行编辑 guard 照 `GlJournalLine.SyncJournal`(父 parsed + 锁父);校验复用 `BankTransaction.SingleSidedAmount`,通过即清 error。
- 时区固定偏移 `config :synie_core, :bank_import_utc_offset_minutes` 默认 480;行数上限 5000;同账户同 sha256 非 failed 拒重传。
- 组件三小扩:工具栏序改 导入|新增|导出、DataGrid `importMenu` 下拉、RecordDrawer `submitLabel`/`footerActions`。
- sysFiles 进 GridMeta(file 资源补 `display_field :filename` + read 分页 + list query),文件 fk 显示文件名。

## Task 1:xlsx 测试夹具 + 解析器纯函数(TDD)

- Modify `backend/apps/synie_core/mix.exs`:加 `{:xlsx_reader, "~> 0.8"}`;`mix deps.get`
- Create `backend/apps/synie_core/test/support/xlsx_fixture.ex`::zip 手拼最小 OOXML(sharedStrings + sheet1,支持字符串/内联数字/日期样式单元格),`build(rows, opts) → binary`;兼作 E2E 夹具生成器
- Create `backend/apps/synie_core/lib/synie_core/acc/bank_import/parser.ex`:`parse(template, binary) → {:ok, rows} | {:error, msg}`;rows 元素 `%{row_no, occurred_at, income, expense, balance, counterparty_name, counterparty_account, summary, note, error}`;格式枚举 slug → 正则解析表;列字母→索引;千分位剥离 Decimal;金额双列 0/空视未填恰一项>0、负数行错;单列按符号拆、0 行错;超长字段行错;全空行跳过;0 行/>5000 行 `{:error, …}`
- Modify `backend/config/config.exs`:`bank_import_utc_offset_minutes` 默认 480
- Test `backend/apps/synie_core/test/synie_core/acc/bank_import_parser_test.exs`:单列/双列时间 × 各格式取样、原生日期单元格优先、time_col 缺省 00:00、UTC 偏移换算、金额三模式与错误矩阵、字段超长、摘要缺列留空、空行跳过、0 行与超限

## Task 2:导入记录 + 导入行资源 + 迁移 + 测试

- Create `backend/apps/synie_core/lib/synie_core/acc/bank_import.ex`:字段/聚合照 spec;同文件校验模块 `TemplateMatchesAccount`、`NoDuplicateFile`(同账户 sha256 去重)、`ReadableFile`(actor 可见 + 扩展名提示);change `ParseOnCreate`(before_action 解析置状态,after_action 插行)、`SetCreatedBy`;`update :import`(预检 parsed + 锁复检 + after_action 逐行 `Ash.create!` 流水带 actor、回填行 transaction_id、置 imported/imported_at/imported_by;0 行或有 error 行拒绝);destroy 仅 parsed/failed(预检+锁复检);权限借前缀全动作 as: "import";审计 fragment
- Create `backend/apps/synie_core/lib/synie_core/acc/bank_import_item.ex`:字段照 spec;guard change `SyncImport`(照 SyncJournal:父 parsed、锁父、create 冗余 company_id);update 校验 occurred_at 必填 + SingleSidedAmount 复用、通过清 error;destroy 同 guard;read 默认 row_no 升序;`reference :import, on_delete: :delete`;审计 fragment
- Modify `backend/apps/synie_core/lib/synie_core/acc/bank_transaction.ex`:permission_actions 加 import
- `mix ash_postgres.generate_migrations` + `mix ecto.migrate`
- Test `backend/apps/synie_core/test/synie_core/acc/bank_import_test.exs`:create 即解析 parsed/failed 两态与行落库;去重拒绝;模板-账户不匹配/跨公司/停用账户拒绝;行修复清 error、imported 后改删拒绝;import 前置(错误行/0 行)、成功建流水+回填+状态、无 transaction:create 权限 actor 整体回滚、双导入锁竞态;imported 不可删、级联删行;CompanyScope fail-closed

## Task 3:GraphQL/GridMeta/sysFiles/标签注册

- Modify `backend/apps/synie_core/lib/synie_core.ex`:queries `acc_bank_imports`/`acc_bank_import_items`/`sys_files`(offset 分页);mutations create/import/destroy BankImport、update/destroy BankImportItem
- Modify `backend/apps/synie_core/lib/synie_core/files/file.ex`:`display_field :filename`、read 加 offset 分页
- Modify `backend/apps/synie_web/lib/synie_web/grid_meta.ex`:`accBankImports`/`accBankImportItems`/`sysFiles`
- Modify `web/app/components/synie-record-drawer/registry.ts`:三资源标签;`web/app/routes/_app/system/logs.tsx`:两表中文标签(permission-labels 零改动,import 标签已有)
- Test:schema 冒烟(既有 schema 测试跑绿即可)

## Task 4:前端组件三小扩

- Modify `web/app/components/synie-data-grid/use-grid-actions.tsx`:工具栏序 导入|新增|导出
- Modify `web/app/components/synie-data-grid/SynieDataGrid.tsx`:`importMenu?: {key,label,onAction(ctx)}[]`,提供时导入按钮渲染 Dropdown(仍 can('import') 门控)
- Modify `web/app/components/synie-record-drawer/SynieRecordDrawer.tsx`:`submitLabel?: string` 默认「保存」;`footerActions?: (mode,row) => ReactNode` view 态 footer 注入
- Modify 对应 checks(`grid-checks.ts`/record-drawer checks 如受影响),`bun run checks` 过

## Task 5:流水页导入交互(新增导入/记录抽屉/历史抽屉)

- Create `web/app/components/bank-import/BankImportCreateDrawer.tsx`:RecordDrawer create(w-720),companyId→bankAccountId(RemoteSelect labelField alias)→templateId(RemoteSelect accBankImportTemplates labelField name 按账户过滤),extraContent 文件选择器(HeroUI 控件经 MCP 选型,仅 .xlsx);onSubmit `uploadFile`→create mutation(取 id/status/error/itemCount/errorCount)→分状态 toast→切记录抽屉
- Create `web/app/components/bank-import/BankImportRecordDrawer.tsx`:RecordDrawer view(w-880,rowId 自查,无 onEdit);failed 横幅;行区 DataGrid accBankImportItems fixedFilter+rowNo 升序+error 红字,parsed 态 rowActions 编辑(二级 RecordDrawer,update 即存)/删除(确认框);footerActions parsed 态「导入(N 行)」(errorCount>0/0 行禁用)→确认框→importAccBankImport→刷新三处
- Create `web/app/components/bank-import/BankImportHistoryDrawer.tsx`:Sheet + DataGrid accBankImports(status 胶囊/itemCount/errorCount),onView 开记录抽屉,rowActions 删除(imported 预检提示)
- Modify `web/app/routes/_app/finance/bank-transactions.tsx`:DataGrid 传 `importMenu` [导入历史, 新增导入],挂三抽屉与刷新联动

## Task 6:测试收尾 + E2E 走查

- `mix format` + `mix test` 全绿;`bun run checks` 全绿
- E2E(Playwright,worktree 端口避 4000/3000,前后端绑 0.0.0.0):建模板→新增导入(夹具 xlsx)→解析结果→改错行→删行→导入→流水表格出现→历史只读;失败文件路径(错列配置→failed 横幅);权限矩阵勾 import 可见性顺带看
- 收尾:spec 跟进项核对,PR
