# 自动编号模块实施计划

> Spec:`docs/superpowers/specs/2026-07-10-numbering-design.md`。本计划由同一会话直接执行(后台自主任务),按任务顺序 TDD、频繁提交。

**目标:** 可配置的单据自动编号(规则 + 计数器 + 取号 API),凭证首接,页面可管理规则与当前序号。

**关键技术决策(探索已定):**

- Ash 必填校验 `require_values` 在 `for_create` 构建期、action changes 之后执行 —— 自动编号必须在 change 主体(构建期)生成,不能放 `before_action`;校验/权限失败会跳号,可接受。
- 计数器递增用 `Repo.insert_all`(schemaless)+ `on_conflict: [inc: [value: 1]]` + `returning`,PG upsert 原子并发安全;不过 Ash 不审计(取号不留痕,改值走 Ash update 有审计)。
- 计数器照 `GlJournalLine` 模式:`permission_prefix "sys.numbering_rule"` + `permission_actions []`,复用规则权限码,不进权限目录。
- `SynieEditableTable` 加 `canCreate`/`canDelete` 两个可选 props(默认 true)支持"只改不增删"的子表。

## Task 1:后端 Numbering 域(规则/计数器资源 + next API)+ 测试

- Create `backend/apps/synie_core/lib/synie_core/numbering/rule.ex`(含 `SynieCore.Numbering.ResetPeriod` enum:never 不重置/yearly 按年/monthly 按月/daily 按日;规则资源:code unique/name/format/seq_padding 默认 4/reset_period 默认 monthly/per_company 默认 true/enabled 默认 true;`validate match(:format, ~r/\{seq\}/)`;权限码 `sys.numbering_rule` create read update delete;接审计)
- Create `backend/apps/synie_core/lib/synie_core/numbering/counter.ex`(rule_id + scope_key + value,unique identity;只有 read 与 update(仅 value);`references reference :rule, on_delete: :delete`;接审计)
- Create `backend/apps/synie_core/lib/synie_core/numbering.ex`:`next/2`、`next!/2`;scope_key = `公司编码|周期`(不按公司为 `-`);format token `{company}` `{YYYY}` `{YY}` `{MM}` `{DD}` `{seq}`;company_id → `Base.Company.code` 内部反查;无启用规则 → `{:error, :no_rule}`
- Modify `backend/apps/synie_core/lib/synie_core.ex`:queries `sys_numbering_rules`/`sys_numbering_counters`,mutations rule create/update/destroy + counter update,resources 登记
- `mix ash_postgres.generate_migrations` + `mix ecto.migrate`
- Test `backend/apps/synie_core/test/synie_core/numbering_test.exs`:格式化连号/按月重置/跨公司独立/缺公司报错/无规则报错/并发唯一(sandbox shared 模式,验 upsert 逻辑)

## Task 2:AutoNumber change + 凭证接入 + 测试

- Create `backend/apps/synie_core/lib/synie_core/numbering/auto_number.ex`:opts `rule`/`attribute`/`date_attribute`/`company_attribute`;目标属性已有值跳过;date 缺失静默跳过(交给 required 校验);`{:error, :no_rule}` → 友好错误"未配置启用的编号规则…"
- Modify `gl_journal.ex` create action 挂 change(rule `acc.gl_journal`);moduledoc 更新
- Test 补 `gl_journal_test.exs`:留空自动取号 / 手填保留 / 无规则留空报错

## Task 3:GridMeta 白名单 + 前端标签

- Modify `backend/apps/synie_web/lib/synie_web/grid_meta.ex`:`sysNumberingRules`/`sysNumberingCounters`
- Modify `web/app/components/synie-permission-sheet/permission-labels.ts`:`sys.numbering_rule: 编号规则`
- Modify `web/app/routes/_app/system/logs.tsx`:`sys_numbering_rule`/`sys_numbering_counter` 标签

## Task 4:前端规则页 + EditableTable 扩展 + 凭证页字段

- Modify `web/app/components/synie-editable-table/SynieEditableTable.tsx`:`canCreate`/`canDelete` props
- Create `web/app/routes/_app/system/numbering.tsx`:DataGrid + RecordDrawer(code createOnly;format placeholder 示例;seqPadding/resetPeriod/perCompany/enabled 默认值);抽屉 extraContent 挂计数器 EditableTable(只改 value,scope_key 只读,父提交时 diff update,照 journals.tsx persistLines 模式)
- Modify `web/app/lib/menu.ts`:系统管理加"配置"组 → 编号规则
- Modify `web/app/routes/_app/finance/journals.tsx`:voucherNo 非必填 + placeholder"留空自动编号"

## Task 5:验证与交付

- `mix test`(后端全量)、前端 `tsc`/build
- 起前后端 E2E:配置规则 → 新建凭证留空编号 → 验证生成号(playwright)
- 提交、推分支、开 draft PR
