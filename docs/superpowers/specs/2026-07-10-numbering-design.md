# 自动编号模块设计

日期:2026-07-10

## 定位

- 通用单据自动编号能力:各业务模块(凭证、后续销售/采购单据)按可配置规则取号,规则与当前序号在页面上可管理。
- 首个接入方:手工会计凭证 `acc_gl_journal`(其 spec 中"自动编号留跟进"即本轮)。凭证 `voucher_no` 留空时自动取号,手填仍可用。

## 数据模型

新域 `SynieCore.Numbering`(目录 `numbering/`,权限域 `sys`)。两张表:

### sys_numbering_rule(编号规则)

| 字段 | 说明 |
|---|---|
| `id` | uuid 主键 |
| `code` | 规则标识,非空,全局唯一(identity);约定用资源权限码风格,如 `acc.gl_journal` |
| `name` | 规则名称,非空,如"记账凭证" |
| `format` | 格式模板,非空;token:`{company}`(公司编码)、`{YYYY}` `{YY}` `{MM}` `{DD}`(取号日期)、`{seq}`(序号,按 `seq_padding` 补零)。如 `J{company}-{YYYY}{MM}-{seq}` → `JA-202607-0001` |
| `seq_padding` | 序号位数,integer,默认 4 |
| `reset_period` | 重置周期枚举:never / yearly / monthly / daily,默认 monthly |
| `per_company` | 是否按公司独立计数,boolean,默认 true |
| `enabled` | 启用,boolean,默认 true |
| 时间戳 | inserted_at / updated_at |

- 权限码 `sys.numbering_rule`,actions:`create read update delete`。
- 不带 `company_id`(规则是全局配置,`{company}`/`per_company` 只影响取号),不挂 CompanyScope。
- 接审计 Fragment;前端两处中文标签同步。

### sys_numbering_counter(编号计数器)

| 字段 | 说明 |
|---|---|
| `id` | uuid 主键 |
| `rule_id` | → sys_numbering_rule,非空,删规则级联删计数器 |
| `scope_key` | 计数范围键,非空;`公司编码\|周期`(如 `A\|202607`;不按公司为 `-\|202607`,never 周期为空) |
| `value` | 当前序号(已用到的最大值),bigint 默认 0 |
| 时间戳 | inserted_at / updated_at |

- unique identity `(rule_id, scope_key)`。
- 不设独立权限码:policy 用 `{HasPermission, as: ...}` 复用 `sys.numbering_rule` 的码(照 `acc_gl_journal_line` 模式)。
- 只开 `read` / `update`(页面改当前值);行由取号自动创建,GraphQL 不暴露 create/destroy。
- 接审计 Fragment(改当前值需留痕)。

## 取号 API

`SynieCore.Numbering` 纯模块:

- `next(code, opts)` → `{:ok, no} | {:error, reason}`;`next!/2` 包装。opts:`company_code`(per_company 或模板含 `{company}` 时必传)、`date`(默认当天)。
- 步骤:查启用规则 → 算 scope_key → **Postgres upsert 原子递增**(`insert_all` + `on_conflict: [inc: [value: 1]]` + `returning`,并发安全无锁)→ 模板 token 替换。
- 计数器递增走 Repo 内部路径不过权限(同审计写入);读改计数器走 Ash 资源过权限。
- 无启用规则 → `{:error, :no_rule}`,调用方决定是否要求手填。

## 凭证接入

- 通用 change `SynieCore.Numbering.AutoNumber`(opts:rule code、目标属性、公司/日期来源属性):create 时目标属性为空则取号填充,非空跳过;无规则时报错提示"未配置编号规则,请填写编号或先配置规则"。
- `acc_gl_journal` create 挂上(rule code `acc.gl_journal`,公司编码经 company 关联取,日期取 `date`)。
- 校验失败/事务回滚会跳号,序号允许有洞(业界常态,不做回收)。
- 前端凭证页 `voucherNo` 字段改非必填,placeholder 提示"留空自动编号"。

## 前端页面

`/system/numbering` 编号规则页,照 `system/roles.tsx` 样板:

- `SynieDataGrid resource="sysNumberingRules"` + `SynieRecordDrawer`(code 仅创建时可填;resetPeriod 枚举中文;perCompany/enabled 开关)。
- 抽屉 extraContent 挂 `SynieEditableTable resource="sysNumberingCounters"`(按 rule 过滤),二级抽屉仅可改 `value`(scope_key 只读)。
- 菜单 `menu.ts` 系统管理组加"编号规则";`permission-labels.ts` 与 `logs.tsx` 补标签。

## 本轮范围

后端两资源 + Numbering 模块 + AutoNumber change + 凭证接入 + GraphQL + 测试(格式化/重置周期/并发唯一/凭证自动编号);前端规则页 + 凭证页字段调整。

## 范围外(跟进项)

- 更多 token(如 `{user}`、自定义周数)与规则校验器(模板非法 token 提示)
- 序号空洞回收/预占
- 其他单据接入(销售、采购)——挂同一 change 即可
