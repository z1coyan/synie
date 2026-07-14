# 承兑汇票(应收承兑)模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地应收承兑:`acc_bill` 票面档案(全局唯一,建档随接收)+ `acc_bill_transaction` 单表五类型交易(接收/转让/兑付/贴现/调拨,审核自动凭证)+ `acc_bill_holding` 段级持有库存(按票全链重放引擎),三页面(交易/持有/台账)。

**Architecture:** 交易是 GL 的一个 voucher(照 VatInvoice 模板:三层动作「构建期 validate → before_action FOR UPDATE 复检 → after_action 调 GL」),审核额外调 `BillLedger.replay!`——以票据为单位锁行、按 (occurred_on, audited_at) 重放全部已审核交易、逐笔校验子票段合法性并整建 holdings;作废走同一引擎(移除后重放,不合法即拒),倒填日期与「后续动过不可作废」天然成立。子票以分为单位(`子票止 = 子票起 + 金额×100 − 1`)。

**Tech Stack:** Elixir 1.20 / Ash 3.29 + AshPostgres 2.10 + AshGraphql;React 19 + TanStack Start/Router + HeroUI v3 + `@heroui-pro/react`。

**Spec:** `docs/superpowers/specs/2026-07-14-acceptance-bill-design.md`

## Global Constraints

- 所有 mix 命令先 `export PATH="/home/zyan/.elixir-install/installs/elixir/1.20.2-otp-28/bin:/home/zyan/.elixir-install/installs/otp/28.4/bin:$PATH"`,工作目录 `backend/`。
- 迁移:改资源 DSL 后 `mix ash_postgres.generate_migrations <name>` 生成(勿手写迁移),`mix ecto.migrate` 与 `MIX_ENV=test mix ecto.migrate` 执行(`mix ash.migrate` 本机失效)。Postgres 在 5440(synie-pg 容器),dev/test config 已指向。
- 注释/文案/报错一律中文;commit message 中文,末尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`;`mix format` 只格式化本次改动文件。
- 权限:资源声明 `permission_prefix/0`+`permission_actions/0`,三段 policies 照既有资源(如 `acc/bank_transaction.ex`);`HasPermission` 把 `:destroy` 映射为 `"delete"`。
- 审计:可写资源挂 `fragments: [SynieCore.Audit.Fragment]`;每个 update/destroy 动作 `require_atomic? false`;显式 destroy 需 `primary? true`。**BillHolding 不接审计**(引擎整删整建是噪音)。
- GraphQL:list 查询一律 `paginate_with: :offset`。
- `authorize?: false` 仅限受信内部路径(GL/BillLedger、changes/validations 内部取数、测试夹具)。
- 前端:HeroUI v3(点号子组件、`onPress`),非幂等请求 Toast 反馈;新资源同步补 `permission-labels.ts`、`logs.tsx`、`registry.ts`、`menu.ts`。
- 新可挂附件资源必须在 `SynieCore.Files.OwnerRegistry` 登记 owner_type → 模块。
- 金额展示复用 `web/app/lib/amount.ts` 的 `formatAmount`。

---

### Task 1: Bill 票据主档资源(枚举/CRUD/锁字段/upsert 建档)+ 注册 + 迁移

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/acc/bill.ex`(含文件头 `BillKind` 枚举与 `BillFaceLock` 校验小模块,照 `vat_invoice.ex` 文件组织)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(queries/mutations/resources 三处)
- Modify: `backend/apps/synie_web/lib/synie_web/grid_meta.ex`(`@resources` 加 `"accBills"`)
- Modify: `backend/apps/synie_core/lib/synie_core/files/owner_registry.ex`(`"acc_bill" => SynieCore.Acc.Bill`)
- Create(codegen): `backend/apps/synie_core/priv/repo/migrations/*_add_acc_bill.exs`
- Test: `backend/apps/synie_core/test/synie_core/acc/bill_test.exs`

**Interfaces:**
- Produces: `SynieCore.Acc.Bill`,graphql type `:acc_bill`,list query `:acc_bills`,mutations `update_acc_bill`/`destroy_acc_bill`(**无 create mutation**——建档走 Task 2 接收交易的内部 `:register`);identity `:unique_bill_no`(`[:bill_no]`);内部 create 动作 `:register`(upsert 挂接不覆盖);`permission_prefix "acc.bill"`,`permission_actions ~w(read update delete)`;display_field 默认 `bill_no`(GridMeta 反射首个 string 属性,实现时确认,否则显式声明)。**本任务读策略暂为 super_admin + HasPermission(read)**,「有过交易的公司可见」filter 在 Task 2 交易资源就绪后补(bill 尚无 transactions 关联,先行注释 TODO 标注)。
- Consumes: 无(纯新增)。

- [ ] **Step 1: 写失败测试**

```elixir
defmodule SynieCore.Acc.BillTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.Bill

  # 夹具:actor(permissions: ["acc.bill:*"]);register 走 authorize?: false(内部动作)

  test "register 建档:票号/种类/到期日/金额必填,其余票面可空"
  test "register 重复票号 upsert 挂接不覆盖:二次提交不同票面,读回仍是首录票面"
  test "bill_no 全局唯一(identity)"
  test "update 票面修正:承兑人名称可改;bill_no 不在 accept 内改不动"
  test "face_amount 非正数被拒"
  test "destroy:无交易的票可删"   # 有交易的拒删在 Task 2 补测(需交易资源)
end
```

- [ ] **Step 2: 跑测试确认失败**(`mix test test/synie_core/acc/bill_test.exs`,模块不存在)

- [ ] **Step 3: 实现资源**

文件头小模块:

```elixir
defmodule SynieCore.Acc.BillKind do
  @moduledoc "承兑票据种类。"
  use Ash.Type.Enum,
    values: [
      bank_acceptance: "银行承兑汇票",
      commercial_acceptance: "商业承兑汇票",
      finance_company_acceptance: "财务公司承兑汇票"
    ]

  def graphql_type(_), do: :acc_bill_kind
end

defmodule SynieCore.Acc.BillFaceLock do
  @moduledoc "票据存在任何交易(含草稿)后,到期日/票据包金额/能否转让锁死(库存引擎与日期校验依赖)。"
  use Ash.Resource.Validation

  @locked [:due_date, :face_amount, :transferable]

  @impl true
  def validate(changeset, _opts, _context) do
    changing? = Enum.any?(@locked, &Ash.Changeset.changing_attribute?(changeset, &1))

    has_tx? =
      changing? &&
        SynieCore.Acc.BillTransaction
        |> Ash.Query.filter(bill_id == ^changeset.data.id)
        |> Ash.exists?(authorize?: false)

    if has_tx? do
      {:error, message: "该票据已有交易,到期日/票据包金额/能否转让不可修改"}
    else
      :ok
    end
  end
end
```

注意:`BillFaceLock` 引用了 Task 2 才创建的 `BillTransaction`——**本任务先写成模块存在性防御**:`Code.ensure_loaded?(SynieCore.Acc.BillTransaction)` 为 false 时直接 `:ok`(Task 2 落地后自动生效,并在 Task 2 补测锁字段用例);模块顶部注释说明。

主资源要点(结构照 `vat_invoice.ex`;差异如下):

```elixir
use Ash.Resource,
  domain: SynieCore,
  data_layer: AshPostgres.DataLayer,
  extensions: [AshGraphql.Resource],
  authorizers: [Ash.Policy.Authorizer],
  fragments: [SynieCore.Audit.Fragment]

postgres do
  table "acc_bill"
  repo SynieCore.Repo

  custom_indexes do
    index [:due_date]
  end
end

identities do
  identity :unique_bill_no, [:bill_no], message: "该票据号码已建档"
end

graphql do
  type :acc_bill
end

def permission_prefix, do: "acc.bill"
def permission_actions, do: ~w(read update delete)
```

attributes(全部 `public? true`,中文 description):`bill_no`(string≤64,非空)、`bill_kind`(BillKind,非空)、`issue_date`(date,可空)、`due_date`(date,非空)、`face_amount`(decimal,非空,constraints `min: 0` 之外再加 validate `compare(:face_amount, greater_than: 0)`)、出票人/收款人/承兑人各四件套 `drawer_name`/`drawer_account`/`drawer_bank_name`/`drawer_bank_no`、`payee_*`、`acceptor_*`(string,可空)、`transferable`(boolean,非空默认 true)、`acceptance_date`(date,可空)、`remarks`(string,可空)、时间戳。

actions:

```elixir
read :read do
  primary? true
  pagination offset?: true, countable: true, required?: false,
             default_limit: 20, max_page_size: 200
end

# 内部建档:仅接收交易的 change 调用(authorize?: false),不暴露 GraphQL create
create :register do
  accept [
    :bill_no, :bill_kind, :issue_date, :due_date, :face_amount,
    :drawer_name, :drawer_account, :drawer_bank_name, :drawer_bank_no,
    :payee_name, :payee_account, :payee_bank_name, :payee_bank_no,
    :acceptor_name, :acceptor_account, :acceptor_bank_name, :acceptor_bank_no,
    :transferable, :acceptance_date, :remarks
  ]

  upsert? true
  upsert_identity :unique_bill_no
  # 挂接不覆盖:并发/二次录入同票号时返回既有档案,票面以先录为准(修正走台账页 update)
  upsert_fields []
end

update :update do
  accept [同 :register 去掉 :bill_no]
  require_atomic? false
  validate {SynieCore.Acc.BillFaceLock, []}
end

destroy :destroy do
  primary? true
  require_atomic? false
  # 有交易时 Task 2 的外键(on_delete 默认 restrict)兜底拒删;此处再给中文校验(照 BillFaceLock 的存在性防御写法)
end
```

policies 三段照 `bank_transaction.ex`,但 read 段暂无公司过滤(无 company_id 列),只 super_admin bypass + `HasPermission "acc.bill:read"`,附 `# TODO(Task 2): 补「有过交易的公司可见」exists filter` 注释。

- [ ] **Step 4: 注册**:`synie_core.ex` queries 加 `list SynieCore.Acc.Bill, :acc_bills, :read, paginate_with: :offset`,mutations 加 `update SynieCore.Acc.Bill, :update_acc_bill, :update` 与 `destroy SynieCore.Acc.Bill, :destroy_acc_bill, :destroy`,resources 登记;`grid_meta.ex` `@resources` 加 `"accBills" => SynieCore.Acc.Bill`;`owner_registry.ex` 加 `"acc_bill" => SynieCore.Acc.Bill`。

- [ ] **Step 5: 生成并执行迁移**(`mix ash_postgres.generate_migrations add_acc_bill` + 两库 migrate;检查 bill_no 唯一索引)

- [ ] **Step 6: 跑测试**(本文件全绿,再全量 `mix test`)
- [ ] **Step 7: Commit**(`feat: 承兑票据主档资源与注册`)

---

### Task 2: BillTransaction 交易资源骨架(五类型 CRUD/类型-字段矩阵/建档挂接)+ Bill 读策略收口 + 迁移

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/acc/bill_transaction.ex`(含文件头 `BillTransactionType`/`BillTransactionStatus` 枚举、`BillTransactionDraft` 校验、`BillTransactionRules` 类型-字段矩阵校验小模块)
- Modify: `backend/apps/synie_core/lib/synie_core/acc/bill.ex`(has_many :transactions + read 策略补 exists filter + destroy 拒删有交易票)
- Modify: `backend/apps/synie_core/lib/synie_core/acc/own_bank_account.ex`(加 `attribute:` 选项,默认 `:bank_account_id`,调拨转入账户复用)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(queries/mutations/resources)
- Modify: `backend/apps/synie_web/lib/synie_web/grid_meta.ex`(`@resources` 加 `"accBillTransactions"`)
- Modify: `backend/apps/synie_core/lib/synie_core/files/owner_registry.ex`(`"acc_bill_transaction" => SynieCore.Acc.BillTransaction`)
- Create(codegen): `backend/apps/synie_core/priv/repo/migrations/*_add_acc_bill_transaction.exs`
- Test: `backend/apps/synie_core/test/synie_core/acc/bill_transaction_test.exs`(+ `bill_test.exs` 补锁字段/拒删/读过滤用例)

**Interfaces:**
- Consumes: Task 1 的 `Bill`(`:register` upsert、`BillFaceLock` 自动生效);`SynieCore.Acc.PartyType`/`PartyExists`;`SynieCore.Numbering.AutoNumber`;`SynieCore.Acc.OwnBankAccount`;Authz 三件。
- Produces: `SynieCore.Acc.BillTransaction`,graphql type `:acc_bill_transaction`,query `:acc_bill_transactions`,mutations `create/update/destroy_acc_bill_transaction`;`permission_prefix "acc.bill_transaction"`;create 的 `bill_attrs :map` 参数契约(**snake_case 字符串键**,键集 = Bill `:register` accept 列表);`poly_refs/0` 声明 `party_id`;`lock_transaction/1`(FOR UPDATE 重读,照 `gl_journal.ex` 的 `lock_journal`)。attributes 命名(Task 3/4/6 依赖):`transaction_type`/`occurred_on`/`sub_start`/`sub_end`/`amount`/`discount_org`/`discount_rate`/`interest`/`net_amount`/`to_bank_account_id`/`bill_account_id`/`settle_account_id`/`interest_account_id`/`posting_date`/`status`/`audited_at`。

- [ ] **Step 1: 写失败测试**(夹具:company! + 银行账户×2 + 客户/供应商 + actor `["acc.bill_transaction:*", "acc.bill:*"]`)

```elixir
test "接收带 bill_attrs 建档并挂接;再录同票号第二段自动挂既有票"
test "接收缺 bill_id 又缺 bill_attrs 被拒;bill_attrs 缺票号/种类/到期日/金额被拒(中文报错)"
test "勾稽:sub_end−sub_start+1 ≠ amount×100 被拒;段越出 [1, face×100] 被拒;amount ≤ 0 被拒"
test "类型-字段矩阵:接收/转让必填对手,兑付/贴现/调拨对手必须为空"
test "类型-字段矩阵:贴现必填 discount_org/rate/interest/net_amount 且 amount=interest+net;非贴现四字段必须为空"
test "类型-字段矩阵:调拨必填 to_bank_account_id(同公司/启用/≠转出账户);非调拨必须为空"
test "银行账户:同公司校验;停用账户 create 被拒"
test "transaction_type 建后不可改(update 不收);仅草稿可改可删"
test "读取按公司范围过滤 fail-closed"
test "票据读过滤:A 公司录过交易后 A 可见该票,无交易公司的 actor 不可见"   # bill_test.exs
test "有交易的票据 destroy 被拒;有交易后改 due_date/face_amount/transferable 被拒"  # bill_test.exs
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现枚举与校验小模块**(bill_transaction.ex 文件头)

```elixir
defmodule SynieCore.Acc.BillTransactionType do
  @moduledoc "承兑交易类型。"
  use Ash.Type.Enum,
    values: [
      receive: "接收",
      endorse: "转让",
      settle: "兑付",
      discount: "贴现",
      reallocate: "调拨"
    ]

  def graphql_type(_), do: :acc_bill_transaction_type
end

defmodule SynieCore.Acc.BillTransactionStatus do
  @moduledoc "承兑交易状态:草稿/已审核/已作废。"
  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]
  def graphql_type(_), do: :acc_bill_transaction_status
end

defmodule SynieCore.Acc.BillTransactionDraft do
  @moduledoc "校验交易处于草稿态(修改/删除的前提)。"
  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft,
      do: :ok,
      else: {:error, message: "仅草稿交易可修改或删除"}
  end
end

defmodule SynieCore.Acc.BillTransactionRules do
  @moduledoc """
  类型-字段矩阵与段勾稽:
  - receive/endorse 必填对手;settle/discount/reallocate 对手必须为空
  - discount 必填贴现四件(org/rate/interest/net)且 amount = interest + net;其余类型四件必须为空
  - reallocate 必填 to_bank_account_id(同公司/启用/≠转出);其余类型必须为空
  - 段勾稽:sub_end − sub_start + 1 = amount × 100;1 ≤ sub_start ≤ sub_end ≤ face_amount × 100
  """
  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    # 取值统一 Ash.Changeset.get_attribute(兼容 create/update)
    # 依次跑 party_rule / discount_rule / reallocate_rule / segment_rule,首错即返
    # segment_rule 读 bill:bill_id 为空(接收走 bill_attrs)时跳过范围校验——
    #   建档 change 在 before_action 补 bill_id 后,本校验的 before_action 复检版再跑一次(见 create)
  end

  # party_rule: type in [:receive, :endorse] → party_type/party_id 都非空,否则「接收/转让必须选择交易对手」;
  #             其余 type → 都为空,否则「该交易类型不填交易对手」
  # discount_rule: :discount → 四件非空、rate ≥ 0、interest ≥ 0、net > 0、
  #                Decimal.equal?(amount, Decimal.add(interest, net)) 否则「贴现金额必须等于利息+实收金额」;
  #                其余 type → 四件全空
  # reallocate_rule: :reallocate → to_bank_account_id 非空且 ≠ bank_account_id(「转入账户不能与转出账户相同」),
  #                  同公司/启用复用 OwnBankAccount attribute: :to_bank_account_id;其余 type → 必须为空
  # segment_rule: sub_start ≥ 1、sub_end ≥ sub_start、amount > 0、
  #               Decimal.equal?(Decimal.mult(amount, 100), Decimal.new(sub_end - sub_start + 1))
  #               否则「子票止必须等于 子票起+金额×100−1」;
  #               bill_id 非空时 Ash.get Bill(authorize?: false)校验 sub_end ≤ face_amount×100
end
```

- [ ] **Step 4: 实现主资源**

结构照 `vat_invoice.ex`(policies/audit fragment/pagination 全同),差异点:

```elixir
postgres do
  table "acc_bill_transaction"
  repo SynieCore.Repo

  custom_indexes do
    index [:company_id, :doc_no], unique: true, where: "doc_no IS NOT NULL",
      name: "acc_bill_transaction_doc_no_uniq", message: "单据编号已存在"
    index [:bill_id, :status]     # BillLedger 重放取数
    index [:company_id, :status]
    index [:company_id, :bank_account_id, :occurred_on]
  end

  # sub_start/sub_end 承载 face×100(10亿票 → 10^11),必须 bigint
  migration_types sub_start: :bigint, sub_end: :bigint
end

def permission_prefix, do: "acc.bill_transaction"
def permission_actions, do: ~w(create read update delete audit void)

def poly_refs do
  %{party_id: %{discriminator: :party_type, variants: SynieCore.Acc.PartyType.party_resources()}}
end
```

attributes:`doc_no`(string≤32,可空)、`transaction_type`(BillTransactionType,非空)、`occurred_on`(date,非空)、`sub_start`/`sub_end`(integer,非空,constraints `min: 1`)、`amount`(decimal,非空)、`party_type`(PartyType,可空)/`party_id`(uuid,可空)、`discount_org`(string≤64,可空)、`discount_rate`/`interest`/`net_amount`(decimal,可空)、`posting_date`(date,可空)、`status`(BillTransactionStatus,非空默认 `:draft`,`writable? false`)、`audited_at`(utc_datetime_usec,`writable? false`)、`remarks`(string,可空)、时间戳。

relationships:`belongs_to :company`(非空)、`belongs_to :bank_account, SynieCore.Acc.BankAccount`(非空)、`belongs_to :to_bank_account, SynieCore.Acc.BankAccount`(可空)、`belongs_to :bill, SynieCore.Acc.Bill`(非空)、`belongs_to :bill_account/:settle_account/:interest_account, SynieCore.Base.Account`(可空)、`belongs_to :created_by/:audited_by`(照 vat_invoice)。

actions(audit/void 在 Task 4):

```elixir
create :create do
  accept [
    :company_id, :doc_no, :transaction_type, :bank_account_id, :to_bank_account_id,
    :bill_id, :occurred_on, :sub_start, :sub_end, :amount,
    :party_type, :party_id,
    :discount_org, :discount_rate, :interest, :net_amount,
    :bill_account_id, :settle_account_id, :interest_account_id, :remarks
  ]

  # 接收建档:票号不存在时前端传票面参数(snake_case 字符串键 map,键集=Bill :register accept)
  argument :bill_attrs, :map, allow_nil?: true

  validate {SynieCore.Authz.Validations.CompanyAccessible, []}
  validate {SynieCore.Acc.OwnBankAccount, check_active: true}
  validate {SynieCore.Acc.PartyExists, []}
  validate {SynieCore.Acc.BillTransactionRules, []}

  validate fn changeset, _ ->
    # 接收必须有票:bill_id 或 bill_attrs 至少其一;非接收必须 bill_id
    ...
  end

  change {SynieCore.Numbering.AutoNumber, attribute: :doc_no}
  # created_by 取 actor,照 vat_invoice

  change fn changeset, _ ->
    Ash.Changeset.before_action(changeset, fn cs ->
      # bill_attrs 建档:Bill :register upsert(authorize?: false,String.to_existing_atom 键白名单过滤)
      # → force_change :bill_id;随后复跑 BillTransactionRules.segment_rule 的 face 范围校验
      # (bill_attrs 路径 build 期拿不到 face_amount)
      case Ash.Changeset.get_argument(cs, :bill_attrs) do
        nil -> cs
        attrs -> register_bill(cs, attrs)
      end
    end)
  end
end

update :update do
  accept [create 的 accept 去掉 :company_id、:transaction_type]
  require_atomic? false
  validate {SynieCore.Acc.BillTransactionDraft, []}
  validate {SynieCore.Acc.OwnBankAccount, []}          # update 不查启用,允许改错录归属
  validate {SynieCore.Acc.PartyExists, []}
  validate {SynieCore.Acc.BillTransactionRules, []}
  # before_action FOR UPDATE 复检草稿,照 vat_invoice update
end

destroy :destroy do
  primary? true
  require_atomic? false
  validate {SynieCore.Acc.BillTransactionDraft, []}
  # before_action FOR UPDATE 复检草稿
end
```

`register_bill/2` 私有函数:`attrs` 只认 snake_case 字符串键(`Map.take(attrs, ~w(bill_no bill_kind issue_date due_date face_amount ... remarks))` 全键列表写死),`Ash.Changeset.for_create(Bill, :register, taken, authorize?: false) |> Ash.create()`;错误(如必填缺失)转成本 changeset 的 `:bill_attrs` 字段错误中文透出。**若 AshGraphql 对 `:map` 参数的 Json scalar 前端序列化有障碍(实施时用 GraphiQL 先验),回退方案:参数改 `:bill_json, :string`,change 内 `Jason.decode!` —— 契约不变,Task 6 前端同步 stringify。**

Bill 收口(bill.ex):`relationships` 加 `has_many :transactions, SynieCore.Acc.BillTransaction`;read 策略补 filter check「actor 可及公司有过该票交易」——照 `SynieCore.Authz.Checks.CompanyScope` 内部取可及公司集的写法,改造为 `exists(transactions, company_id in ^可及公司集)` 的 filter(super_admin bypass 保留);destroy 加存在交易拒删校验(「该票据已有交易,不可删除」)。

- [ ] **Step 5: 注册**(synie_core.ex 三处 + grid_meta + owner_registry,照 Task 1 Step 4 样式;mutations:create/update/destroy 三条)

- [ ] **Step 6: 生成并执行迁移**(`mix ash_postgres.generate_migrations add_acc_bill_transaction`;检查 sub_start/sub_end 为 bigint、bill_id 外键 restrict、doc_no partial unique)

- [ ] **Step 7: 跑测试**(两文件全绿,再全量 `mix test`)
- [ ] **Step 8: Commit**(`feat: 承兑交易资源骨架——五类型 CRUD 与类型字段矩阵`)

---

### Task 3: BillHolding 持有资源 + BillLedger 重放引擎

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/acc/bill_holding.ex`
- Create: `backend/apps/synie_core/lib/synie_core/acc/bill_ledger.ex`
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(query `:acc_bill_holdings`,**无 mutation**;resources 登记)
- Modify: `backend/apps/synie_web/lib/synie_web/grid_meta.ex`(`@resources` 加 `"accBillHoldings"`)
- Create(codegen): `backend/apps/synie_core/priv/repo/migrations/*_add_acc_bill_holding.exs`
- Test: `backend/apps/synie_core/test/synie_core/acc/bill_ledger_test.exs`

**Interfaces:**
- Consumes: Task 1/2 的 Bill、BillTransaction(测试用 `Ash.Seed.seed!` 直造 audited 交易,不依赖 Task 4 的 audit 动作)。
- Produces: `SynieCore.Acc.BillHolding`(graphql `:acc_bill_holding`,query `:acc_bill_holdings`,只读;字段 `company_id`/`bank_account_id`/`bill_id`/`bill_no`/`sub_start`/`sub_end`/`amount`/`due_date`/`acquired_on`/`source_transaction_id` + calculation `label`);`SynieCore.Acc.BillLedger.replay!(bill_id) :: :ok | raise ArgumentError`(调用方事务内使用;Task 4 的 audit/void after_action 调)。

- [ ] **Step 1: 写失败测试**(夹具:company!×2、每公司两个银行账户、票据 face 100 元即 10000 子票;`seed_tx/1` 辅助函数用 `Ash.Seed.seed!(BillTransaction, %{..., status: :audited, audited_at: DateTime.utc_now()})` 直造已审核交易)

```elixir
test "接收产生持有段,字段齐全(含 bill_no/due_date 冗余与 amount)"
test "接收段与既有持有重叠被拒(同公司);跨公司同段重叠同样被拒"
test "转让消耗整段:持有清空"
test "部分消耗拆段:余段保留原取得日期与来源交易"
test "横跨两个相邻持有段的消耗成功;中间有空洞被拒(报单号与缺口)"
test "消耗他人账户/他公司的段被拒"
test "倒填日期:先审 7-10 接收,再审 7-01 转让同段 → replay 报「该段当时未持有」"
test "同日接收+转让按 audited_at 定序通过"
test "调拨:转出账户段迁到转入账户,取得日期=调拨发生日"
test "作废模拟:seed 三笔(收→转→收),把中间转让改回 draft 后 replay,持有恢复"
test "replay 整建幂等:连续两次 replay 结果一致"
test "label 拼串含票号/段/金额"
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 BillHolding 资源**

```elixir
# 无手工动作:create/destroy 仅 BillLedger 内部(authorize?: false)调用,不出 GraphQL mutation
postgres do
  table "acc_bill_holding"
  repo SynieCore.Repo

  custom_indexes do
    index [:bill_id]
    index [:company_id, :bank_account_id]
    index [:company_id, :due_date]
  end

  migration_types sub_start: :bigint, sub_end: :bigint
end

def permission_prefix, do: "acc.bill_holding"
def permission_actions, do: ~w(read)

# 不挂审计 fragment(引擎整删整建是噪音,交易本身是审计线索)

actions do
  read :read do
    primary? true
    pagination offset?: true, countable: true, required?: false,
               default_limit: 20, max_page_size: 200
  end

  create :rebuild do
    accept [:company_id, :bank_account_id, :bill_id, :bill_no, :sub_start, :sub_end,
            :amount, :due_date, :acquired_on, :source_transaction_id]
  end

  destroy :destroy, primary?: true
end

calculations do
  # RemoteSelect 选段控件的 labelField(直连 RemoteSelect 必传 labelField,见既有坑)
  calculate :label, :string, SynieCore.Acc.BillHoldingLabel, public?: true
end
```

`BillHoldingLabel`(同文件小模块,`use Ash.Resource.Calculation`,select 全部所需列):`"#{bill_no} #{sub_start}-#{sub_end} ¥#{amount} 到期#{due_date}"`。

policies:read 段照 `bank_transaction.ex`(super_admin bypass + HasPermission + CompanyScope fail-closed);create(:rebuild)/destroy **不开放对外授权路径**(照 GlEntry 内部动作先例:策略上无人可过,BillLedger 内部一律 `authorize?: false` 调用)。

- [ ] **Step 4: 实现 BillLedger**

```elixir
defmodule SynieCore.Acc.BillLedger do
  @moduledoc """
  承兑持有库存引擎:以票据为单位,把该票全部已审核交易按(发生日期, 审核时间)重放,
  逐笔校验子票段合法性并整建 acc_bill_holding。

  不自带事务与锁竞态防护:调用方(交易 audit/void 动作)须在事务内先经 FOR UPDATE
  锁交易行,本模块再锁票据行,同票所有审核/作废串行化。
  """

  require Ash.Query

  alias SynieCore.Acc.{Bill, BillHolding, BillTransaction}

  @consume_types [:endorse, :settle, :discount, :reallocate]

  @doc "重放该票全链并重建持有段;任何一笔不合法 raise ArgumentError(中文,带单号),事务回滚。"
  def replay!(bill_id) do
    bill = lock_bill!(bill_id)

    txs =
      BillTransaction
      |> Ash.Query.filter(bill_id == ^bill_id and status == :audited)
      |> Ash.Query.sort([:occurred_on, :audited_at])
      |> Ash.read!(authorize?: false)

    segs = Enum.reduce(txs, [], &apply_tx(&2, &1))
    rebuild!(bill, segs)
    :ok
  end

  # ── 折叠 ──────────────────────────────────────────────
  # seg = %{company_id, bank_account_id, sub_start, sub_end, acquired_on, source_id}

  defp apply_tx(segs, %{transaction_type: :receive} = tx) do
    conflict = Enum.find(segs, &ranges_overlap?(&1, tx))

    if conflict do
      raise ArgumentError,
            "承兑库存校验失败:交易 #{label(tx)} 接收段 #{tx.sub_start}-#{tx.sub_end} 与现有持有段 " <>
              "#{conflict.sub_start}-#{conflict.sub_end} 重叠(同一子票段不可能被两方同时持有)"
    end

    [new_seg(tx, tx.bank_account_id) | segs]
  end

  defp apply_tx(segs, %{transaction_type: type} = tx) when type in @consume_types do
    {touched, rest} =
      Enum.split_with(segs, fn s ->
        s.company_id == tx.company_id and s.bank_account_id == tx.bank_account_id and
          ranges_overlap?(s, tx)
      end)

    assert_covered!(touched, tx)

    remainders =
      Enum.flat_map(touched, fn s ->
        left = if s.sub_start < tx.sub_start, do: [%{s | sub_end: tx.sub_start - 1}], else: []
        right = if s.sub_end > tx.sub_end, do: [%{s | sub_start: tx.sub_end + 1}], else: []
        left ++ right
      end)

    added = if type == :reallocate, do: [new_seg(tx, tx.to_bank_account_id)], else: []
    added ++ remainders ++ rest
  end

  defp new_seg(tx, account_id) do
    %{
      company_id: tx.company_id,
      bank_account_id: account_id,
      sub_start: tx.sub_start,
      sub_end: tx.sub_end,
      acquired_on: tx.occurred_on,
      source_id: tx.id
    }
  end

  defp ranges_overlap?(a, b), do: a.sub_start <= b.sub_end and b.sub_start <= a.sub_end

  # touched 的并集必须无缝覆盖 [tx.sub_start, tx.sub_end]
  defp assert_covered!(touched, tx) do
    cursor =
      touched
      |> Enum.sort_by(& &1.sub_start)
      |> Enum.reduce(tx.sub_start, fn s, cursor ->
        if s.sub_start > cursor do
          raise ArgumentError,
                "承兑库存校验失败:交易 #{label(tx)} 的子票段 #{cursor}-#{s.sub_start - 1} " <>
                  "在该公司该账户于 #{tx.occurred_on} 并未持有"
        end

        max(cursor, s.sub_end + 1)
      end)

    if cursor <= tx.sub_end do
      raise ArgumentError,
            "承兑库存校验失败:交易 #{label(tx)} 的子票段 #{cursor}-#{tx.sub_end} " <>
              "在该公司该账户于 #{tx.occurred_on} 并未持有"
    end
  end

  # 报错里的交易标识:有单号用单号,否则「发生日期+类型中文」
  defp label(tx) do
    tx.doc_no ||
      "#{tx.occurred_on} #{SynieCore.Acc.BillTransactionType.description(tx.transaction_type)}"
    # description/1 若枚举模块未生成该函数,实施时改用 values 关键字取中文(照枚举定义)
  end

  # ── 重建 ──────────────────────────────────────────────
  defp rebuild!(bill, segs) do
    BillHolding
    |> Ash.Query.filter(bill_id == ^bill.id)
    |> Ash.bulk_destroy!(:destroy, %{}, authorize?: false, return_errors?: true)

    rows =
      Enum.map(segs, fn s ->
        %{
          company_id: s.company_id,
          bank_account_id: s.bank_account_id,
          bill_id: bill.id,
          bill_no: bill.bill_no,
          sub_start: s.sub_start,
          sub_end: s.sub_end,
          amount: Decimal.div(Decimal.new(s.sub_end - s.sub_start + 1), 100),
          due_date: bill.due_date,
          acquired_on: s.acquired_on,
          source_transaction_id: s.source_id
        }
      end)

    %Ash.BulkResult{status: :success} =
      Ash.bulk_create(rows, BillHolding, :rebuild, authorize?: false, return_errors?: true)
  end

  defp lock_bill!(bill_id) do
    # FOR UPDATE 锁票据行,照 gl_journal.ex 的 lock_journal 写法(Ash.Query.lock)
  end
end
```

- [ ] **Step 5: 生成并执行迁移**(检查 bigint 与索引)
- [ ] **Step 6: 跑测试**(引擎文件全绿,再全量)
- [ ] **Step 7: Commit**(`feat: 持有承兑资源与按票全链重放库存引擎`)

---

### Task 4: 交易 audit/void 动作 + 凭证派生 + 日期硬校验 + GL 注册

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/acc/bill_transaction.ex`(audit/void、`gl_entries/1`、`audit_blockers/1`、`grid_actions/0`)
- Modify: `backend/apps/synie_core/lib/synie_core/acc/gl.ex`(`voucher_resources/0` 加 `"acc.bill_transaction" => {SynieCore.Acc.BillTransaction, "承兑交易"}`)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(mutations 加 audit/void)
- Test: `backend/apps/synie_core/test/synie_core/acc/bill_transaction_test.exs`(追加)

**Interfaces:**
- Consumes: `GL.post!/2`、`GL.cancel!/2`、`GL.validate_entries/2`;Task 3 `BillLedger.replay!/1`;Task 2 骨架与 `lock_transaction/1`。
- Produces: mutations `audit_acc_bill_transaction`(input: postingDate,调拨不填)、`void_acc_bill_transaction`(无 input);voucher_type `"acc.bill_transaction"`。Task 6 前端按此接线。

- [ ] **Step 1: 写失败测试**

```elixir
describe "审核过账与库存" do
  test "接收审核:借票据科目/贷结算科目(带对手)两行配平;持有段生成"
  test "转让审核:借结算(带对手)/贷票据;原持有段消耗"
  test "兑付审核:借结算(银行存款)/贷票据;无对手行"
  test "贴现审核:借结算 net + 借利息 interest / 贷票据 amount 三行;利息为 0 只两行"
  test "调拨审核:零分录,posting_date 不填;持有段迁移账户"
  test "voucher_no 优先 doc_no,无则票号"
  test "审核必填:非调拨缺 posting_date 被拒;缺票据/结算科目被拒;贴现缺利息科目被拒"
  test "日期硬校验:兑付早于到期日拒;接收/转让/贴现晚于到期日拒;调拨不限"
  test "不得转让票:转让/贴现拒,兑付/调拨放行"
  test "转让未持有段:audit 报「并未持有」且事务回滚(状态仍 draft、无分录)"
  test "审核后 update/destroy 被拒"
end

describe "作废" do
  test "作废接收(段未动):分录标 is_cancelled,持有段消失,状态 voided"
  test "作废接收(段已被转让消耗):被拒,报错含后续单号线索;状态回滚仍 audited"
  test "作废调拨:无分录可取消也不报错,持有回到转出账户"
  test "草稿不能作废;作废后不能再审"
end
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `gl_entries/1` 与 `audit_blockers/1`**

```elixir
@doc "按类型派生分录组;调拨返回 []。currency 取科目,照 vat_invoice.gl_entries 的 currencies map。"
def gl_entries(%__MODULE__{transaction_type: :reallocate}), do: []

def gl_entries(%__MODULE__{} = tx) do
  currencies = ...  # 照 vat_invoice:一次读回三科目的 currency_id

  zero = Decimal.new(0)
  entry = fn account_id, debit, credit, party? ->
    %{account_id: account_id, currency_id: currencies[account_id],
      debit: debit, credit: credit,
      party_type: if(party?, do: tx.party_type), party_id: if(party?, do: tx.party_id),
      remarks: nil}
  end

  case tx.transaction_type do
    :receive ->
      [entry.(tx.bill_account_id, tx.amount, zero, false),
       entry.(tx.settle_account_id, zero, tx.amount, true)]

    :endorse ->
      [entry.(tx.settle_account_id, tx.amount, zero, true),
       entry.(tx.bill_account_id, zero, tx.amount, false)]

    :settle ->
      [entry.(tx.settle_account_id, tx.amount, zero, false),
       entry.(tx.bill_account_id, zero, tx.amount, false)]

    :discount ->
      interest? = Decimal.compare(tx.interest, 0) == :gt

      [entry.(tx.settle_account_id, tx.net_amount, zero, false)] ++
        if(interest?, do: [entry.(tx.interest_account_id, tx.interest, zero, false)], else: []) ++
        [entry.(tx.bill_account_id, zero, tx.amount, false)]
  end
end

@doc "审核前齐全性与日期/票面硬校验清单(空=可审核);bill 由调用方 load 后传入。"
def audit_blockers(tx, bill) do
  type = tx.transaction_type

  [
    {type != :reallocate and is_nil(tx.bill_account_id), "审核前必须选择票据科目"},
    {type != :reallocate and is_nil(tx.settle_account_id), "审核前必须选择结算科目"},
    {type == :discount and Decimal.compare(tx.interest, 0) == :gt and
       is_nil(tx.interest_account_id), "贴现利息大于零时必须选择利息科目"},
    {type == :settle and Date.compare(tx.occurred_on, bill.due_date) == :lt,
     "兑付发生日期不能早于票据到期日 #{bill.due_date}"},
    {type in [:receive, :endorse, :discount] and
       Date.compare(tx.occurred_on, bill.due_date) == :gt,
     "#{类型中文}发生日期不能晚于票据到期日 #{bill.due_date}(到期后只能托收)"},
    {type in [:endorse, :discount] and not bill.transferable,
     "该票据「不得转让」,禁止转让与贴现"}
  ]
  |> Enum.filter(&elem(&1, 0))
  |> Enum.map(&elem(&1, 1))
end
```

- [ ] **Step 4: 实现两动作**(三层结构照 `vat_invoice.ex` audit/void;差异点)

```elixir
update :audit do
  accept [:posting_date]
  require_atomic? false

  validate fn changeset, _ -> 仅草稿可审核 end

  validate fn changeset, _ ->
    # 非调拨必填 posting_date;调拨忽略(不生凭证)
  end

  validate fn changeset, _ ->
    bill = Ash.get!(SynieCore.Acc.Bill, changeset.data.bill_id, authorize?: false)

    case __MODULE__.audit_blockers(changeset.data, bill) do
      [] ->
        if changeset.data.transaction_type == :reallocate do
          :ok
        else
          case SynieCore.Acc.GL.validate_entries(
                 changeset.data.company_id, __MODULE__.gl_entries(changeset.data)) do
            :ok -> :ok
            {:error, msg} -> {:error, message: msg}
          end
        end

      msgs -> {:error, message: Enum.join(msgs, ";")}
    end
  end

  change fn changeset, context ->
    changeset
    |> Ash.Changeset.force_change_attribute(:status, :audited)
    |> Ash.Changeset.force_change_attribute(:audited_at, DateTime.utc_now())
    # audited_by 取 actor
    |> Ash.Changeset.before_action(fn cs ->
      # FOR UPDATE 复检:lock_transaction + 仍草稿 + blockers(照 vat_invoice audit before_action)
    end)
    |> Ash.Changeset.after_action(fn _cs, tx ->
      bill = Ash.get!(SynieCore.Acc.Bill, tx.bill_id, authorize?: false)

      if tx.transaction_type != :reallocate do
        SynieCore.Acc.GL.post!(
          %{voucher_type: "acc.bill_transaction", voucher_id: tx.id,
            voucher_no: tx.doc_no || bill.bill_no,
            company_id: tx.company_id, posting_date: tx.posting_date},
          __MODULE__.gl_entries(tx)
        )
      end

      # 库存全链重验(锁票据行);不合法 raise → 整个审核事务回滚
      SynieCore.Acc.BillLedger.replay!(tx.bill_id)
      {:ok, tx}
    end)
  end
end

update :void do
  accept []
  require_atomic? false

  validate fn changeset, _ -> 仅已审核可作废 end

  change fn changeset, _ ->
    changeset
    |> Ash.Changeset.force_change_attribute(:status, :voided)
    |> Ash.Changeset.before_action(fn cs -> FOR UPDATE 复检 audited end)
    |> Ash.Changeset.after_action(fn _cs, tx ->
      if tx.transaction_type != :reallocate do
        SynieCore.Acc.GL.cancel!("acc.bill_transaction", tx.id)
      end

      # 移除本笔后重放:后续交易若消耗过本笔产生的段,这里 raise → 作废回滚
      SynieCore.Acc.BillLedger.replay!(tx.bill_id)
      {:ok, tx}
    end)
  end
end
```

`grid_actions/0`:

```elixir
def grid_actions do
  [
    %{key: "audit", label: "审核", scope: "row", mutation: "auditAccBillTransaction", is_danger: false},
    %{key: "void", label: "作废", scope: "row", mutation: "voidAccBillTransaction", is_danger: true}
  ]
end
```

`synie_core.ex` mutations 追加 audit/void 两条;`gl.ex` `voucher_resources` 注册。

- [ ] **Step 5: 跑测试**(本文件全绿,再全量 `mix test`)
- [ ] **Step 6: Commit**(`feat: 承兑交易审核过账/作废——自动凭证与库存重放联动`)

---

### Task 5: 前端组件小扩展——FieldInputProps.patchValues + DataGrid 本页合计

**Files:**
- Modify: `web/app/components/synie-record-drawer/fields.ts`(`FieldInputProps` 加 `patchValues`)
- Modify: `web/app/components/synie-record-drawer/SynieRecordDrawer.tsx`(input 渲染处传入)
- Modify: `web/app/components/synie-data-grid/SynieDataGrid.tsx`(`pageSummary` prop)
- Modify: `web/app/components/synie-record-drawer/record-drawer-checks.ts`(若有 FieldInputProps 相关断言则同步)

**Interfaces:**
- Produces: ① `FieldInputProps` 增 `patchValues: (patch: Record<string, unknown>) => void`(自定义 input 可回写兄弟字段——选持有段带出票据/段/金额、贴现联动计算都靠它;drawer 内已有同名函数,view 态 no-op,直接传入);② `SynieDataGridProps` 增 `pageSummary?: (rows: Row[]) => ReactNode`(表格与分页之间渲染一行本页汇总,不传无变化)。Task 6/7 消费。
- Consumes: 现有 `patchValues`(`SynieRecordDrawer.tsx:183`)。

- [ ] **Step 1: fields.ts**

```ts
export interface FieldInputProps {
  value: unknown
  onChange: (v: unknown) => void
  isDisabled: boolean
  /** 当前表单完整草稿值,供联动控件读取兄弟字段 */
  values: Record<string, unknown>
  /** 向表单草稿并入补丁(view 态 no-op):选段带出多字段、跨字段联动计算用 */
  patchValues: (patch: Record<string, unknown>) => void
}
```

- [ ] **Step 2: SynieRecordDrawer.tsx** 自定义 input 调用处(搜 `f.input`)补传 `patchValues`(函数已在组件内定义,`SynieRecordDrawer.tsx:183`)。

- [ ] **Step 3: SynieDataGrid.tsx**

```ts
/** 本页汇总行:表格下方、分页上方渲染(如金额本页合计);rows 为当前页数据 */
pageSummary?: (rows: Row[]) => ReactNode
```

渲染位置:表格组件之后、分页条之前,`{props.pageSummary && <div className="px-4 py-2 text-sm text-muted">{props.pageSummary(rows)}</div>}`(容器样式对齐现有工具条)。

- [ ] **Step 4: 类型检查与既有检查脚本**

```bash
cd web && bun x tsc -p tsconfig.json --noEmit && bun test app/components
```

既有调用点不传新 prop 行为不变;`record-drawer-checks.ts` 如断言 input 参数形状则更新。

- [ ] **Step 5: Commit**(`feat: 表单自定义控件可回写草稿补丁,DataGrid 支持本页汇总行`)

---

### Task 6: 承兑交易页(五类型录入/审核/作废)+ 注册与标签

**Files:**
- Create: `web/app/lib/banks.ts`(预置银行清单常量)
- Create: `web/app/routes/_app/finance/bill-transactions.tsx`
- Modify: `web/app/components/synie-record-drawer/registry.ts`(`accBillTransactions`、`accBills`、`accBillHoldings` 三资源登记)
- Modify: `web/app/lib/menu.ts`(财务「资金」组加 承兑交易/持有承兑/承兑票据 三项)
- Modify: `web/app/components/synie-permission-sheet/permission-labels.ts`(`acc.bill` 承兑票据 / `acc.bill_transaction` 承兑交易 / `acc.bill_holding` 持有承兑)
- Modify: `web/app/routes/_app/system/logs.tsx`(表标签补 acc_bill/acc_bill_transaction)

**Interfaces:**
- Consumes: Task 2/4 mutations(`createAccBillTransaction`(含 `billAttrs`)/`updateAccBillTransaction`/`auditAccBillTransaction`/`voidAccBillTransaction`)与 GridMeta 反射(partyId 多态 fk、audit/void extendedActions);Task 3 `accBillHoldings`(labelField `label`);Task 5 `patchValues`;`formatAmount`。
- Produces: `BANKS: string[]`(Task 6 内部);页面路由 `/finance/bill-transactions`。

- [ ] **Step 1: banks.ts**

```ts
/** 贴现机构预置清单(可自由输入,不限于此) */
export const BANKS = [
  '中国工商银行', '中国农业银行', '中国银行', '中国建设银行', '交通银行', '中国邮政储蓄银行',
  '招商银行', '浦发银行', '中信银行', '中国光大银行', '华夏银行', '中国民生银行',
  '广发银行', '兴业银行', '平安银行', '浙商银行', '渤海银行', '恒丰银行',
  '宁波银行', '北京银行', '上海银行', '江苏银行', '杭州银行', '南京银行',
  '徽商银行', '齐鲁银行', '青岛银行', '苏州银行', '长沙银行', '成都银行',
]
```

- [ ] **Step 2: 页面骨架**(整体照 `invoices.tsx`:DataGrid + RecordDrawer + 审核弹窗;差异点如下)

表格与状态:

```ts
const GRID_COLUMNS = ['docNo', 'companyId', 'transactionType', 'billId', 'amount',
  'occurredOn', 'partyId', 'discountOrg', 'status', 'auditedById']

const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' } },
  amount: { render: (v: unknown) => formatAmount(v) },
} satisfies Record<string, ColumnOverride>
// defaultSort: { column: 'occurredOn', direction: 'desc' }(照 bank-transactions.tsx)
```

页面状态(抽屉关闭时全部重置):

```ts
const [pickedHolding, setPickedHolding] = useState<Row | null>(null)  // 选段整行(dueDate 供贴现算息)
const [billLookup, setBillLookup] = useState<Row | null>(null)        // 接收:按票号查到的既有票
const [billDraft, setBillDraft] = useState<Record<string, string>>({}) // 接收:新票票面草稿(snake 键)
```

类型显隐辅助与 fields 要点(`visible` 用现有能力):

```ts
const T = (...types: string[]) => (v: Record<string, unknown>) =>
  types.includes(String(v.transactionType))

fields={{
  transactionType: { required: true, order: -2, edit: 'createOnly',
    effects: () => ({ billId: null, subStart: null, subEnd: null, amount: null,
      partyType: null, partyId: null, discountOrg: null, discountRate: null,
      interest: null, netAmount: null, toBankAccountId: null }) },  // 切类型全清
  companyId: { required: true, order: -1, edit: 'createOnly',
    effects: () => ({ bankAccountId: null, toBankAccountId: null, billId: null,
      billAccountId: null, settleAccountId: null, interestAccountId: null }) },
  bankAccountId: { required: true, cols: 6,
    label: undefined /* 调拨态文案「转出账户」经 label 覆盖不可行,保持「银行账户」加 placeholder 说明 */,
    remote: { filter: bankAccountFilter /* companyId eq + active eq true,照 bank-transactions.tsx */ },
    effects: () => ({ billId: null, subStart: null, subEnd: null, amount: null }) },
  toBankAccountId: { cols: 6, visible: T('REALLOCATE'), required: false,  // 后端强校验,前端提交前自查
    remote: { filter: bankAccountFilter } },
  occurredOn: { required: true, cols: 6 },
  billId: {
    cols: 6,
    // 接收:隐藏(票据由票面区建档/查档);其余类型:持有段选择器
    visible: (v) => v.transactionType != null && v.transactionType !== 'RECEIVE',
    input: ({ isDisabled, values, patchValues }) => (
      <RemoteSelect
        resource="accBillHoldings"
        labelField="label"
        fields={['billId', 'subStart', 'subEnd', 'amount', 'dueDate']}
        filter={holdingFilter(values)}   // {companyId: {eq}, bankAccountId: {eq}}
        label="持有段"
        placeholder="从当前持有中选择票据段…"
        value={pickedHolding?.id ?? null}
        isDisabled={isDisabled || !values.companyId || !values.bankAccountId}
        onChange={(_id, row) => {
          setPickedHolding(row)
          patchValues(row
            ? { billId: row.billId, subStart: row.subStart, subEnd: row.subEnd, amount: row.amount }
            : { billId: null, subStart: null, subEnd: null, amount: null })
        }}
      />
    ) },
  subStart: { cols: 4, required: true,
    input: numberInput('子票起', (v, values, patch) => patch(recalcSeg({ ...values, subStart: v }))) },
  amount: { cols: 4, required: true,
    input: numberInput('交易金额', (v, values, patch) => patch(recalcSeg({ ...values, amount: v }))) },
  subEnd: { cols: 4, edit: 'readOnly' },   // 恒由 subStart+amount 推得
  partyType: { cols: 6, visible: T('RECEIVE', 'ENDORSE'), effects: () => ({ partyId: null }) },
  partyId: { cols: 6, visible: (v) => T('RECEIVE', 'ENDORSE')(v) && v.partyType != null,
    input: 多态对手,照 invoices.tsx partyId 原样 },
  discountOrg: { cols: 6, visible: T('DISCOUNT'),
    input: ({ value, onChange, isDisabled }) => (
      <ComboBox /* HeroUI v3 允许自由输入的组合框;实施时经 MCP get_component_docs 确认组件名与 anatomy,
                   BANKS 作选项,allowsCustomValue */ />
    ) },
  discountRate: { cols: 4, visible: T('DISCOUNT'),
    input: numberInput('贴现利率(%)', (v, values, patch) => patch(recalcDiscount(values, { discountRate: v }))) },
  interest: { cols: 4, visible: T('DISCOUNT'),
    input: numberInput('贴现利息', (v, values, patch) => patch(recalcDiscount(values, { interest: v }, true))) },
  netAmount: { cols: 4, visible: T('DISCOUNT'), edit: 'readOnly' },  // 恒 = 金额 − 利息
  billAccountId: { cols: 4, visible: (v) => v.transactionType !== 'REALLOCATE', label: '票据科目',
    remote: { filter: accountFilter } },   // 同公司/启用/非汇总,照 invoices.tsx
  settleAccountId: { cols: 4, visible: (v) => v.transactionType !== 'REALLOCATE', label: '结算科目',
    remote: { filter: accountFilter } },
  interestAccountId: { cols: 4, visible: T('DISCOUNT'), label: '利息科目',
    remote: { filter: accountFilter } },
}}
```

联动计算函数(页面顶部):

```ts
/** 子票止 = 子票起 + 金额×100 − 1(分为最小单位);任一端缺失回 null */
function recalcSeg(v: Record<string, unknown>): Record<string, unknown> {
  const start = Number(v.subStart)
  const amount = Number(v.amount)
  const ok = Number.isFinite(start) && start >= 1 && Number.isFinite(amount) && amount > 0
  return { subStart: v.subStart, amount: v.amount,
    subEnd: ok ? start + Math.round(amount * 100) - 1 : null }
}

/** 贴现利息 = 金额×利率%×(到期日−发生日)/360,银行实扣可手改(手改后只重算实收) */
function recalcDiscount(values: Record<string, unknown>, patch: Record<string, unknown>,
    manualInterest = false): Record<string, unknown> {
  const v = { ...values, ...patch }
  const amount = Number(v.amount)
  if (!Number.isFinite(amount)) return patch
  let interest = Number(v.interest)
  if (!manualInterest) {
    const due = pickedHolding?.dueDate ? new Date(String(pickedHolding.dueDate)) : null
    const on = v.occurredOn ? new Date(String(v.occurredOn)) : null
    const rate = Number(v.discountRate)
    if (due && on && Number.isFinite(rate)) {
      const days = Math.max(0, Math.round((due.getTime() - on.getTime()) / 86400000))
      interest = Math.round(amount * (rate / 100) * (days / 360) * 100) / 100
    }
  }
  return Number.isFinite(interest)
    ? { ...patch, interest, netAmount: Math.round((amount - interest) * 100) / 100 }
    : patch
}
```

`numberInput(label, onChangeWithPatch)` 小工厂:HeroUI NumberField/TextField 包装,onChange 时同时 `onChange(v)` 并调回调拿 `values`/`patchValues`(签名 `(v, values, patchValues) => void`)。

接收票面区(extraContent,仅 `transactionType === 'RECEIVE'` 且 create 态渲染;edit/view 态该区只读展示 billId fk 速览链接即可):

```tsx
// 票号查档:失焦(或「查档」按钮)后 graphql 查 accBills(filter: {billNo: {eq}}, first: 1)
//   命中 → setBillLookup(bill) + patchValues({ billId: bill.id }),票面只读摘要展示(种类/到期日/金额/承兑人)
//   未命中 → setBillLookup(null) + patchValues({ billId: null }),展开票面表单(billDraft 页面状态,snake 键):
//     bill_no(自动带查档输入值)、bill_kind(下拉:三种类)、issue_date、due_date*、face_amount*、
//     出票人/收款人/承兑人 4×3(TextField,两列排)、transferable(开关,默认开)、acceptance_date、remarks
//   * 必填星标;提交前自查 bill_no/bill_kind/due_date/face_amount 非空
// 段金额快捷:「整票带出」按钮 → patchValues({ subStart: 1, amount: face, subEnd: face*100 })
```

附件面板照 invoices.tsx(ownerType `acc_bill_transaction`)。

提交:

```ts
onSubmit={async (values, mode) => {
  const input: Record<string, unknown> = { ...values }
  if (values.transactionType === 'RECEIVE' && !values.billId) {
    input.billAttrs = billDraft            // snake_case 键 map(若后端走 bill_json 回退方案则 JSON.stringify)
  }
  // create/update 错误处理与 Toast 照 invoices.tsx
}}
```

行动作:`actionHandlers={{ audit: (rows) => openAudit(rows[0]) }}`;audit 弹窗照 invoices.tsx(默认日期 `postingDate ?? occurredOn`),**调拨行走确认框直调**(不弹日期):`row.transactionType === 'REALLOCATE'` 时 confirm「调拨审核仅变动持有库存,不生成凭证,确认?」→ `auditAccBillTransaction(id, {})`。`void` 不接管(extendedAction 默认 danger 确认框)。

- [ ] **Step 3: 四处注册**(registry.ts 三资源 label:承兑交易/承兑票据/持有承兑;menu.ts 资金组三项;permission-labels.ts 三前缀;logs.tsx 两表标签)

- [ ] **Step 4: 类型检查**(`bun x tsc -p tsconfig.json --noEmit` 零错误)
- [ ] **Step 5: Commit**(`feat: 承兑交易页——五类型录入/联动计算/审核作废`)

---

### Task 7: 持有承兑页 + 承兑票据台账页

**Files:**
- Create: `web/app/routes/_app/finance/bill-holdings.tsx`
- Create: `web/app/routes/_app/finance/bills.tsx`

**Interfaces:**
- Consumes: Task 3 `accBillHoldings` query;Task 1 `accBills`/`updateAccBill`;Task 5 `pageSummary`;`formatAmount`。

- [ ] **Step 1: bill-holdings.tsx**(只读页:无 onCreate/onEdit,仅 onView 开 view 态抽屉)

```ts
const GRID_COLUMNS = ['companyId', 'bankAccountId', 'billId', 'subStart', 'subEnd',
  'amount', 'dueDate', 'acquiredOn', 'sourceTransactionId']
// defaultSort: { column: 'dueDate', direction: 'asc' }(临期在前)
// overrides: amount formatAmount;billId/sourceTransactionId fk 链接为 GridMeta 反射默认
// pageSummary: (rows) => `本页合计:¥${formatAmount(rows.reduce((s, r) => s + Number(r.amount ?? 0), 0))}
//   / ${rows.length} 段`(全量合计留跟进,文案明示「本页」)
```

- [ ] **Step 2: bills.tsx**(台账:onView + onEdit 票面修正,无 onCreate——建档随接收)

```ts
const GRID_COLUMNS = ['billNo', 'billKind', 'faceAmount', 'issueDate', 'dueDate',
  'acceptorName', 'transferable']
// overrides: faceAmount formatAmount
// RecordDrawer fields:billNo edit:'readOnly';dueDate/faceAmount/transferable 可编辑
//   (有交易时后端 BillFaceLock 拒并透出中文报错);四件套两列排(cols 6)
// extraContent:SynieAttachmentPanel ownerType="acc_bill"(票面影像;create 态不存在,无需提示)
```

- [ ] **Step 3: 类型检查**(`bun x tsc --noEmit` 零错误)
- [ ] **Step 4: Commit**(`feat: 持有承兑与承兑票据台账页`)

---

### Task 8: 端到端验证(E2E)

**Files:** 无代码改动;发现问题回上游任务修。

- [ ] **Step 1: 起服务**(worktree 并行:后端 `PORT=4100 mix phx.server`,前端 `BACKEND_PORT=4100 bun dev --host` 绑 0.0.0.0,经 Tailscale 100.93.251.66 访问)

- [ ] **Step 2: Playwright 走查主链路**(admin/admin123)
  1. 权限矩阵勾选三资源验证 fail-closed 可见性;编号规则给 `acc.bill_transaction` 配规则验证自动取号。
  2. **接收**:新建接收,录新票号 → 票面表单展开,填 银承/到期日/票据包金额 100 万等 → 子票起 1+金额 100 万 → 子票止自动 1 亿;客户对手;科目 应收票据/应收账款 → 保存审核(填过账日期)→ 分录两行、贷方行带对手;持有页出现 1 段,本页合计正确。
  3. **部分转让**:选持有段整段带出 → 改金额 40 万(子票止自动重算)→ 供应商对手 → 审核 → 持有页拆成余段 60 万;分录借应付/贷应收票据。
  4. **贴现**:选余段部分 30 万,贴现机构下拉选「宁波银行」、利率 2.5 → 利息/实收自动算、手改利息验证实收重算 → 审核 → 三行分录。
  5. **兑付**:到期日前审核应被拒(中文报错);改发生日期≥到期日 → 通过。
  6. **调拨**:剩余段调到本公司另一账户 → 审核无日期弹窗、无分录,持有页账户列变化。
  7. **作废**:作废一笔已被后续消耗的接收 → 拒绝且报错含单号;作废最新一笔 → 持有恢复,分录 is_cancelled。
  8. **重叠与倒填**:另录一笔与持有重叠的接收审核 → 拒;倒填早于取得日期的转让 → 拒。
  9. 票据台账:票面修正(承兑人名称)成功;改到期日被拒(已有交易);附件上传。
  10. 同一票据第二段接收(票号查档命中,票面只读带出)。
- [ ] **Step 3: 后端全量回归**(`mix test` 全绿)+ `bun x tsc --noEmit`。
- [ ] **Step 4: Commit 收尾**(如有修补),汇总验证结论。
