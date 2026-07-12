# 银行账户模块设计

日期:2026-07-12。为未来银行流水模块铺垫的主数据。

## 资源

`SynieCore.Acc.BankAccount`,表 `acc_bank_account`,权限前缀 `acc.bank_account`(create/read/update/delete)。
归财务域:绑定会计科目,后续银行流水、对账都长在它之上。

## 字段

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| company | belongs_to 公司 | 必填;建后不可改(update 不收 company_id) |
| alias | string(64) | 账户别名,必填,**同公司内唯一**(先例:科目编码按公司唯一);作 display_field |
| bank_name | string(128) | 所属银行,必填 |
| branch_name | string(128) | 开户支行,选填 |
| holder_name | string(128) | 户名,必填,通常=公司名 |
| account_no | string(64) | 银行账号,必填,同公司内唯一 |
| currency | belongs_to 货币 | 必填(流水按币种记账) |
| account | belongs_to 科目 | 绑定科目,选填(建账初期科目可能未建);填了必须:同公司、非汇总、启用、币种与账户一致(科目未指定币种则不校验) |
| active | boolean | 启用,默认 true(停用不删,历史流水保引用) |
| note | string(255) | 备注,选填 |

明确不做(YAGNI,留流水/付款模块再加):联行号 CNAPS、SWIFT、默认账户标记、期初余额。

## 权限与审计

照 `Base.Account` 样板:super_admin bypass + HasPermission 全动作 + CompanyScope fail-closed 读;
create 挂 `CompanyAccessible`;审计 fragment,update/destroy `require_atomic? false`。

## 接入

- GraphQL:list `acc_bank_accounts` + create/update/destroy 三 mutation(offset 分页约定)。
- GridMeta 白名单注册 `accBankAccounts`;`display_field/0` 返回 `:alias`。
- 前端:`/finance/bank-accounts`,财务模块新「资金」菜单组;SynieDataGrid + SynieRecordDrawer
  + SynieAttachmentPanel(开户资料);companyId 首字段 createOnly(凭证页先例),
  绑定科目候选随表单公司联动过滤(`input` 回调 + RemoteSelect,公司变更 effects 清空科目)。
- 中文标签:permission-labels.ts、logs.tsx 同步补 `acc.bank_account` / `acc_bank_account`。

## 测试

别名/账号同公司唯一(跨公司可重复);绑定科目四项校验;公司数据权限 fail-closed 读。
E2E 已走查:新增(公司联动过滤科目候选)、编辑(rowId 自查回填全字段)、审计自动落 create/update。

## 跟进项

- 审计 `record_label` 只认 `name` 属性(Track 硬编码),银行账户(alias)与凭证(voucher_no)日志里都无标签;可改 Track 复用 `display_field/0` 约定,单独一轮做。
- 银行流水模块落地时再考虑:期初余额、联行号 CNAPS/SWIFT、默认收付账户标记。
- 非 super_admin 角色需在权限矩阵勾选「银行账户」才能看到新页面(权限码 `acc.bank_account:*`)。
