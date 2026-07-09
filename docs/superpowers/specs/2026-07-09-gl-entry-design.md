# GL Entry 总账主干设计

日期:2026-07-09

## 定位

- GL Entry(总账分录)是全系统唯一的财务事实表:所有业务单据(会计凭证、银行流水、承兑汇票、销售发货、采购入库……)在审核时于同一事务内派生一组配平分录;财务报表(总账/明细账/试算平衡/资产负债/利润)只查这张表,不查业务单据。
- 分录只追加、不可改:用户没有任何直接写入口;作废单据 = 该单据分录标记 `is_cancelled`,查询默认过滤。跨期更正走业务层红字凭证,对 GL 层是普通分录。
- 库存将来照同一模式做独立的库存分录主干(Stock Ledger),不合并进本表。
- 手工会计凭证(`acc_gl_journal`)是第一个 voucher,地位与其他单据平等,随本轮一起交付以验收整条链路。

## 数据模型

新域 `SynieCore.Acc`(表前缀 `acc_`、权限域 `acc`;`Accounts` 已被用户账号占用故不用)。三张表:

### acc_gl_entry(总账分录,只读派生)

| 字段 | 说明 |
|---|---|
| `id` | uuid 主键 |
| `seq` | bigint identity,稳定排序/余额链 |
| `company_id` | → bas_company,非空 |
| `account_id` | → bas_account,非空 |
| `currency_id` | → bas_currency,可空;过账时从凭证行复制 |
| `posting_date` | date,非空,取自来源单据的过账日期 |
| `debit` / `credit` | decimal,非空默认 0;DB CHECK:非负且恰一边 > 0 |
| `party_type` | 枚举(供应商/客户),可空 |
| `party_id` | uuid,可空;多态引用无真外键,DB CHECK 与 `party_type` 同空同有 |
| `voucher_type` | string,非空,权限码风格(如 `acc.gl_journal`) |
| `voucher_id` | uuid,非空;多态引用无真外键 |
| `voucher_no` | string,非空,冗余存单据编号供展示 |
| `is_cancelled` | boolean 默认 false |
| `remarks` | 行摘要,可空 |
| `inserted_at` | 创建时间 |

索引:`(company_id, account_id, posting_date)`、`(voucher_type, voucher_id)`。

资源形态:

- 只开 `read`(offset 分页,照现有样板);create 与标记 cancelled 仅内部代码路径(`authorize?: false`),GraphQL 不暴露任何写。
- 权限码 `acc.gl_entry:read`;policy 照样板 + CompanyScope fail-closed。
- 不挂审计 Fragment:分录本身就是来源单据的审计产物,来源单据已接审计。

### acc_gl_journal(手工会计凭证,头)

| 字段 | 说明 |
|---|---|
| `id` | uuid 主键 |
| `company_id` | → bas_company,非空 |
| `voucher_no` | 编号,非空,手工输入,公司内唯一(identity);自动编号留跟进 |
| `date` | 单据日期,非空 |
| `posting_date` | 过账日期,非空;分录取此日期 |
| `remarks` | 凭证备注,可空 |
| `status` | 枚举:草稿 draft / 已审核 audited / 已取消 cancelled,默认 draft |
| `created_by_id` | → sys_user,编写人,创建时自动取 actor |
| `submitted_by_id` / `submitted_at` | → sys_user,提交人/提交时间,审核时自动记 |
| 时间戳 | inserted_at / updated_at |

- 权限码 `acc.gl_journal`,actions:`create read update delete audit cancel`(审核、取消是用户视角独立能力,单列权限点)。
- 接审计 Fragment;前端两处中文标签同步(permission-labels.ts、logs.tsx)。

### acc_gl_journal_line(凭证子条目)

| 字段 | 说明 |
|---|---|
| `id` | uuid 主键 |
| `journal_id` | → acc_gl_journal,非空;删草稿凭证级联删行 |
| `company_id` | 冗余 = 凭证公司,非空;为复用 CompanyScope/CompanyAccessible 的 fail-closed 体系 |
| `idx` | 行号,integer |
| `account_id` | → bas_account,非空 |
| `currency_id` | 币种 = 科目币种,保存行时从科目复制,不可手改 |
| `debit` / `credit` | 借/贷金额,CHECK 同 gl_entry |
| `party_type` / `party_id` | 对手类型(供应商/客户)与对手 id,多态,可空、同空同有 |
| `remarks` | 行备注,可空 |

- 不设独立权限码:policy 用 `{HasPermission, as: ...}` 复用 `acc.gl_journal` 的码。
- create/update/destroy 均校验父凭证必须处于草稿态。
- 接审计 Fragment。

`party_type` 枚举(`SynieCore.Acc.PartyType`:supplier 供应商 / customer 客户)由行与分录共用;供应商/客户主数据资源尚不存在,`party_id` 先为裸 uuid,主数据落地后接 RemoteSelect 与校验。**该列必须第一天存在**:应收/应付科目入账缺 party 是回填数据之痛,不是加列之痛。

## 过账机制

`SynieCore.Acc.GL` 纯模块(非资源),所有 voucher 共用:

- `post!(voucher, entries)`:事务内校验后批量插入分录。校验(纵深防御,未来其他单据也走这里):借贷配平、行数 ≥ 2、每行恰一边 > 0、科目属同公司且 active 且非汇总科目、party 成对。
- `cancel!(voucher_type, voucher_id)`:将该单据全部分录标记 `is_cancelled`。

业务单据在自己的审核/取消动作里调用;暂不抽 behaviour,接入两三个单据后模式稳定再提。

## 凭证生命周期

```
draft ──audit──▶ audited ──cancel──▶ cancelled(终态)
```

- 草稿:头、行可改可删。
- `audit`(草稿→已审核):校验同 `GL.post!` 清单;记 submitted_by/at;同事务内每行生成一条分录(currency/party/remarks 随行带过去,posting_date 取头)。
- `cancel`(已审核→已取消):调 `GL.cancel!`;终态,不可复审,更正开新凭证。
- 已审核/已取消:头行的 update/destroy 一律校验挡死。

## 本轮范围

后端交付:三张表资源 + 过账模块 + GraphQL(照现有分页/权限/审计规范)+ 测试。

## 范围外(跟进项)

- 凭证自动编号(计数表月内连号,`记-YYYYMM-NNNN`);当前手编唯一
- 期间关账(锁 posting_date)
- 公司本位币字段与多币种(汇率、原币/本位币双金额列);当前金额一律视为本位币,币种字段仅标识
- 报表:试算平衡、科目余额表、明细账页面
- 凭证打印视图(按 voucher 分组渲染分录即可,无需物理凭证中间层)
- 供应商/客户主数据及 party 真实引用校验
- 前端凭证录入页与分录查询页
