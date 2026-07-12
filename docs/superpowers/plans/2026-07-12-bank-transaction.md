# 银行流水模块实施计划

> Spec:`docs/superpowers/specs/2026-07-12-bank-transaction-design.md`。按任务顺序 TDD、频繁提交;导入执行与凭证关联均不在本轮。

**目标:** 银行流水台账(手工 CRUD + 附件)与流水导入模板管理(单独页面、单独权限),为后续导入执行铺路。

**关键技术决策(探索已定):**

- 金额互斥「恰一项非空且 > 0」(不允许负数,冲正/转出退款按实际资金方向录):校验模块 + DB CHECK 双保险,照 `gl_entry.ex` `check_constraints` 先例(`(income IS NULL) <> (expense IS NULL)` + 非空项 > 0)。
- 账户校验照 `BankAccount.LedgerAccount` 模式单独校验模块:同公司恒校验;「账户停用拒绝」仅 create(update 允许改错录归属/备注)。
- 模板时间配置二选一(单列 datetime vs 双列 date+time)、金额配置二选一(income/expense 双列 vs amount_col 带符号单列,互斥)各用校验模块集中判;列号 `constraints match: ~r/^[A-Za-z]{1,2}$/` + change 归一大写。
- 三个格式字段用枚举(新建 DatetimeFormat/DateFormat/TimeFormat enum 模块:value 语义 slug 如 `ymd_dash_hms`,description 存格式串本体,初始值照 spec 清单)——GridMeta enum_options 反射自动渲染下拉与筛选,前端零自定义控件;text 存储,扩值无迁移。
- RecordDrawer datetime 编辑粒度扩展:编辑态换带时间粒度的日期时间控件(HeroUI v3 选型实施时经 heroui-pro MCP 确认,DateField granularity 方向);`fields.ts` 的 datetime 值不再截取日期位,保留完整 ISO(存 UTC、显 本地)。date 类型行为不变。
- SynieDataGrid 加可选 `defaultSort?: { column, direction }` prop,仅作初始 sort state,不影响既有页面。
- `OwnerRegistry` 本轮登记 `acc_bank_transaction`,**顺带补漏 `acc_bank_account`**(#8 主干既有 bug:银行账户附件上传报未知宿主)。

## Task 1:后端银行流水资源 + 迁移 + 测试

- Create `backend/apps/synie_core/lib/synie_core/acc/bank_transaction.ex`:字段照 spec(company/bank_account 必填 belongs_to,occurred_at utc_datetime 必填,income/expense/balance decimal 可空,counterparty_name(128)/counterparty_account(64)/summary(255)/note(255) 可空);`display_field :summary`;权限码 `acc.bank_transaction` create/read/update/delete;三段 policies + CompanyScope;create 挂 `CompanyAccessible`;审计 fragment,update/destroy `require_atomic? false`,destroy `primary? true`;update 不收 company_id;`check_constraints` 金额互斥;索引 `(company_id, bank_account_id, occurred_at)`
- 同文件内校验模块(照 `BankAccount.LedgerAccount` 结构):`SingleSidedAmount`(恰一项非空且 > 0)、`OwnBankAccount`(同公司恒校验;create 另校验账户 active)
- Modify `backend/apps/synie_core/lib/synie_core/files/owner_registry.ex`:登记 `acc_bank_transaction`、补漏 `acc_bank_account`
- `mix ash_postgres.generate_migrations` + `mix ecto.migrate`
- Test `backend/apps/synie_core/test/synie_core/acc/bank_transaction_test.exs`:金额双空/双填/零值/负数均拒绝;跨公司账户拒绝;停用账户 create 拒绝、update 放行;CompanyScope fail-closed;附件挂接 `acc_bank_transaction` 与 `acc_bank_account` 走通(OwnerRegistry 回归)

## Task 2:后端导入模板资源 + 迁移 + 测试

- Create `backend/apps/synie_core/lib/synie_core/acc/bank_import_template.ex`:字段照 spec(name(64) 必填同公司唯一 identity;start_row 必填 min 1 默认 2;十一个列号字段(含 amount_col)string(2) match 校验 + change 归一大写;三个格式枚举字段);权限码 `acc.bank_import_template` 四动作;policies/审计/CompanyAccessible/update 不收 company_id 同 Task 1
- Create 格式枚举模块(DatetimeFormat/DateFormat/TimeFormat,归 `SynieCore.Acc.BankImportTemplate` 命名空间,初始值照 spec 清单)
- 同文件内校验模块:`TimeColumns`(单列/双列二选一,混填/缺格式拒绝)、`AmountColumns`(双列 income/expense 至少其一 或 单列 amount_col,两模式互斥)、账户同公司复用 `OwnBankAccount`(模板无需 active 校验,传 opts 或拆分支)
- `mix ash_postgres.generate_migrations` + `mix ecto.migrate`
- Test `backend/apps/synie_core/test/synie_core/acc/bank_import_template_test.exs`:时间模式矩阵(单列缺格式/双列缺日期格式/混填/仅 time_col 无 format 拒绝,合法两模式放行);金额模式矩阵(全空拒/amount_col 与收支列同填拒/两种合法模式放行);列号 `aa`→`AA` 归一、`A1` 拒绝;同公司重名拒绝跨公司放行;跨公司账户拒绝

## Task 3:GraphQL/GridMeta/标签注册

- Modify `backend/apps/synie_core/lib/synie_core.ex`:queries `acc_bank_transactions`/`acc_bank_import_templates`(offset 分页)+ 各 create/update/destroy mutation,resources 登记
- Modify `backend/apps/synie_web/lib/synie_web/grid_meta.ex`:`accBankTransactions`/`accBankImportTemplates`
- Modify `web/app/components/synie-permission-sheet/permission-labels.ts`:`acc.bank_transaction` 银行流水、`acc.bank_import_template` 流水导入模板
- Modify `web/app/routes/_app/system/logs.tsx`:`acc_bank_transaction`/`acc_bank_import_template` 表标签

## Task 4:组件扩展(datetime 编辑粒度 + defaultSort)

- Modify `web/app/components/synie-record-drawer/SynieRecordDrawer.tsx` + `fields.ts`:datetime 编辑态换带时间粒度控件(MCP 确认选型),值转换保留完整 ISO;date 类型不动
- Modify `web/app/components/synie-data-grid/SynieDataGrid.tsx`:`defaultSort` prop 作初始 sort state
- Modify `web/app/components/synie-record-drawer/record-drawer-checks.ts` + `synie-data-grid/grid-checks.ts`:datetime 断言改全值、defaultSort 用例;`bun run checks` 过

## Task 5:银行流水页

- Create `web/app/routes/_app/finance/bank-transactions.tsx`(照 `bank-accounts.tsx`):DataGrid 列白名单 companyId/bankAccountId/occurredAt/summary/income/expense/balance/counterpartyName,`defaultSort` occurredAt DESC;RecordDrawer fields 照 spec(companyId 首字段 createOnly effects 清账户;bankAccountId RemoteSelect 同公司+active 过滤;income/expense cols 6 互斥轻联动;counterparty 两字段 cols 6);SynieAttachmentPanel 挂 extraContent(ownerType `acc_bank_transaction`)
- Modify `web/app/components/synie-record-drawer/registry.ts`:`accBankTransactions` 银行流水
- Modify `web/app/lib/menu.ts`:「资金」组补「银行流水」

## Task 6:导入模板页 + E2E 走查

- Create `web/app/routes/_app/finance/bank-import-templates.tsx`:DataGrid 列白名单 companyId/name/bankAccountId/startRow/datetimeCol/dateCol/amountCol;RecordDrawer fields 照 spec(列号/格式两两并排 cols 6,格式枚举自动下拉;placeholder 写清列号字母、时间二选一、amount_col 正=收入负=支出且与收/支列互斥)
- Modify `registry.ts`(`accBankImportTemplates` 流水导入模板)、`menu.ts`(「流水导入模板」)
- E2E 走查(Playwright,照既有模块惯例):建模板(两种时间模式与校验报错)、录流水(公司→账户联动、金额互斥、附件上传下载)、编辑回填(rowId 自查)、银行账户页附件回归(补漏验证)、非 super_admin 权限矩阵勾选后可见;移动端 lg 断点过一眼
- 收尾:`mix format` + `mix test`、`bun run checks` 全绿
