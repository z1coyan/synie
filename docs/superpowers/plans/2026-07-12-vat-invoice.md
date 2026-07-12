# 增值税发票模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地增值税发票台账:`acc_vat_invoice` 单表(明细 json 内嵌)+ 草稿/已审核/作废/红冲状态机,审核按三科目自动过账,作废取消凭证,红冲开出红字凭证并把原凭证标「已红冲」;含 GL 红字扩展、前端组件本地 meta 扩展与发票页。

**Architecture:** 发票是 GL 的一个 voucher(照 GlJournal 模板:手写状态枚举 + 三层动作「构建期 validate → before_action FOR UPDATE 复检 → after_action 调 GL」)。红冲做成 GL 通用能力 `GL.reverse!`(原分录组标 `is_reversed`、生成 `is_reversal` 红字组),需放宽「恰一边>0」为「恰一边≠0」(默认路径行为不变)。明细为 `{:array,:map}` json(照 Numbering.Rule.segments),前端 SynieEditableTable/SynieRecordDrawer 扩「本地 meta」模式承接。

**Tech Stack:** Elixir 1.20 / Ash 3.29 + AshPostgres 2.10 + AshGraphql;React 19 + TanStack Start/Router + HeroUI v3 + `@heroui-pro/react`。

**Spec:** `docs/superpowers/specs/2026-07-12-vat-invoice-design.md`

## Global Constraints

- 所有 mix 命令先 `export PATH="/home/zyan/.elixir-install/installs/elixir/1.20.2-otp-28/bin:/home/zyan/.elixir-install/installs/otp/28.4/bin:$PATH"`,工作目录 `backend/`。
- 迁移:改资源 DSL 后 `mix ash_postgres.generate_migrations <name>` 生成(勿手写迁移/直接改表),用 `mix ecto.migrate` 与 `MIX_ENV=test mix ecto.migrate` 执行(`mix ash.migrate` 本机失效,勿用)。Postgres 在本机 5440(synie-pg 容器),dev/test config 已指向。
- 注释/文案/报错一律中文;commit message 中文,末尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`;`mix format` 只格式化本次改动文件(全库 format 会引入无关 diff)。
- 权限:资源声明 `permission_prefix/0`+`permission_actions/0`,三段 policies 照 `apps/synie_core/test/support/test_domain.ex`(Test.Doc);`HasPermission` 把 `:destroy` 映射为 `"delete"`,其余即动作名。
- 审计:可写资源挂 `fragments: [SynieCore.Audit.Fragment]`;每个 update/destroy 动作 `require_atomic? false`;显式 destroy 需 `primary? true`。
- GraphQL:list 查询一律 `paginate_with: :offset`;`{:array,:map}` 属性声明 `attribute_types 字段: :json_string`(读写均为「JSON 串数组」,前端逐行 parse/stringify,照 `routes/_app/system/numbering.tsx:54-74`,注意读写不对称坑)。
- `authorize?: false` 仅限受信内部路径(GL 模块、changes/validations 内部取数、测试夹具)。
- 前端:HeroUI v3(点号子组件、`onPress`),非幂等请求 Toast 反馈;新资源同步补 `permission-labels.ts`、`logs.tsx`、`registry.ts`、`menu.ts`。
- 新可挂附件资源必须在 `SynieCore.Files.OwnerRegistry` 登记 owner_type(graphql type 名)→模块。

---

### Task 1: PartyType 增「内部公司」+ PartyExists 提升为共享校验

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/acc/party_type.ex`
- Create: `backend/apps/synie_core/lib/synie_core/acc/party_exists.ex`
- Modify: `backend/apps/synie_core/lib/synie_core/acc/gl_journal_line.ex`(删内嵌 PartyExists 模块,引用改共享模块)
- Test: `backend/apps/synie_core/test/synie_core/acc/party_type_test.exs`(新建)

**Interfaces:**
- Produces: `PartyType` 枚举含 `:company`(内部公司);`PartyType.party_resources/0` 返回 `%{supplier: Purchase.Supplier, customer: Sales.Customer, company: Base.Company}`;共享校验 `SynieCore.Acc.PartyExists`(读 changeset 的 `:party_type`/`:party_id`,同空同有 + 按类型查主数据存在)。Task 3 的发票资源直接挂它。

- [ ] **Step 1: 写失败测试**

```elixir
defmodule SynieCore.Acc.PartyTypeTest do
  use ExUnit.Case, async: true

  alias SynieCore.Acc.PartyType

  test "对手类型含供应商/客户/内部公司三类" do
    assert Enum.sort(PartyType.values()) == Enum.sort([:supplier, :customer, :company])
  end

  test "party_resources 内部公司映射到公司主数据" do
    assert PartyType.party_resources()[:company] == SynieCore.Base.Company
  end
end
```

- [ ] **Step 2: 跑测试确认失败**(`mix test test/synie_core/acc/party_type_test.exs`,期望 values 断言失败)

- [ ] **Step 3: 实现**

`party_type.ex`:

```elixir
defmodule SynieCore.Acc.PartyType do
  @moduledoc "往来对手类型:供应商/客户/内部公司。凭证行、总账分录与发票共用。"

  use Ash.Type.Enum, values: [supplier: "供应商", customer: "客户", company: "内部公司"]

  def graphql_type(_), do: :acc_party_type

  @doc "类型 → 主数据资源映射(存在性校验与 GridMeta 多态 fk 反射共用)"
  def party_resources do
    %{
      supplier: SynieCore.Purchase.Supplier,
      customer: SynieCore.Sales.Customer,
      company: SynieCore.Base.Company
    }
  end
end
```

`party_exists.ex`:把 `gl_journal_line.ex:115-143` 的 `SynieCore.Acc.GlJournalLine.PartyExists` 原样迁出为 `SynieCore.Acc.PartyExists`(moduledoc 注明「凭证行与发票共用」),`gl_journal_line.ex` 里删除内嵌模块、动作里 `validate {SynieCore.Acc.PartyExists, []}`。逻辑零改动——`Map.fetch!(PartyType.party_resources(), party_type)` 已按 map 分发,加 `:company` 自动生效。

- [ ] **Step 4: 全量跑 acc 测试**(`mix test test/synie_core/acc`,期望全绿;PartyType 存储为字符串,无迁移)
- [ ] **Step 5: Commit**(`feat: 对手类型支持内部公司,PartyExists 提升为共享校验`)

---

### Task 2: GL 红字扩展——CHECK 放宽 + allow_negative + 红冲标记 + GL.reverse!

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/acc/gl_entry.ex`(CHECK、`is_reversed`/`is_reversal` 属性、create accept、`mark_reversed` 动作)
- Modify: `backend/apps/synie_core/lib/synie_core/acc/gl.ex`(`validate_entries/3`、`post!/3`、`reverse!/3`)
- Create(codegen): `backend/apps/synie_core/priv/repo/migrations/*_gl_entry_red_reversal.exs`
- Test: `backend/apps/synie_core/test/synie_core/acc/gl_test.exs`(若无则新建;夹具照 `gl_entry_test.exs`)

**Interfaces:**
- Consumes: GlEntry `:create`/`:mark_cancelled` 内部动作。
- Produces: `GL.post!(voucher, entries, opts \\ [])`(`opts[:allow_negative]` 默认 false,false 时行为与现 `post!/2` 完全一致);`GL.reverse!(voucher_type, voucher_id, posting_date)`(生成红字组+原组标记,无可红冲分录时 raise);GlEntry 新增 `is_reversed`/`is_reversal` boolean(默认 false,public)。Task 4 的发票 reverse 依赖 `GL.reverse!`。

- [ ] **Step 1: 写失败测试**(追加到 gl 测试;夹具复用 `AuthzFixtures.company!` 与科目创建,照 `gl_entry_test.exs` 的 `base_attrs`)

```elixir
describe "红字扩展" do
  test "默认 post! 拒绝负数金额", %{company: co, account: a1, account2: a2} do
    entries = [
      %{account_id: a1.id, debit: Decimal.new("-100"), credit: Decimal.new(0)},
      %{account_id: a2.id, debit: Decimal.new(0), credit: Decimal.new("-100")}
    ]

    assert_raise ArgumentError, ~r/恰一边大于零/, fn ->
      GL.post!(voucher(co), entries)
    end
  end

  test "allow_negative 放行恰一边非零的负数行", %{company: co, account: a1, account2: a2} do
    entries = [
      %{account_id: a1.id, debit: Decimal.new("-100"), credit: Decimal.new(0)},
      %{account_id: a2.id, debit: Decimal.new(0), credit: Decimal.new("-100")}
    ]

    assert :ok == GL.post!(voucher(co), entries, allow_negative: true)
  end

  test "reverse! 生成取负红字组并把原组标已红冲", %{company: co, account: a1, account2: a2} do
    entries = [
      %{account_id: a1.id, debit: Decimal.new("100"), credit: Decimal.new(0)},
      %{account_id: a2.id, debit: Decimal.new(0), credit: Decimal.new("100")}
    ]

    v = voucher(co)
    :ok = GL.post!(v, entries)
    :ok = GL.reverse!(v.voucher_type, v.voucher_id, ~D[2026-07-31])

    all = read_entries(v)
    originals = Enum.filter(all, &(not &1.is_reversal))
    reds = Enum.filter(all, & &1.is_reversal)

    assert length(reds) == 2
    assert Enum.all?(originals, & &1.is_reversed)
    assert Enum.all?(reds, &(&1.posting_date == ~D[2026-07-31]))
    assert Enum.all?(reds, &String.starts_with?(&1.remarks || "", "红冲"))
    # 借贷合计归零
    assert Decimal.equal?(sum(all, :debit), Decimal.new(0))
  end

  test "reverse! 无可红冲分录时报错", %{company: _co} do
    assert_raise ArgumentError, ~r/没有可红冲的分录/, fn ->
      GL.reverse!("acc.gl_journal", Ash.UUID.generate(), ~D[2026-07-31])
    end
  end

  test "重复 reverse! 被拒(原组已标记,不再命中)", %{company: co, account: a1, account2: a2} do
    v = voucher(co)
    :ok = GL.post!(v, [
      %{account_id: a1.id, debit: Decimal.new("100"), credit: Decimal.new(0)},
      %{account_id: a2.id, debit: Decimal.new(0), credit: Decimal.new("100")}
    ])
    :ok = GL.reverse!(v.voucher_type, v.voucher_id, ~D[2026-07-31])

    assert_raise ArgumentError, ~r/没有可红冲的分录/, fn ->
      GL.reverse!(v.voucher_type, v.voucher_id, ~D[2026-07-31])
    end
  end
end
```

- [ ] **Step 2: 跑测试确认失败**(post!/3 未定义 → UndefinedFunctionError)

- [ ] **Step 3: 实现 gl_entry.ex**

```elixir
# check_constraints 内替换:
check_constraint :debit, "single_sided_amount",
  check: "(debit = 0) <> (credit = 0)",
  message: "借贷金额必须恰一边非零"

# attributes 内追加(is_cancelled 旁):
attribute :is_reversed, :boolean do
  allow_nil? false
  default false
  public? true
  description "已被红冲(原凭证状态)"
end

attribute :is_reversal, :boolean do
  allow_nil? false
  default false
  public? true
  description "红字冲销行"
end

# create accept 追加 :is_reversal;actions 内追加:
update :mark_reversed do
  accept []
  change set_attribute(:is_reversed, true)
end
```

- [ ] **Step 4: 实现 gl.ex**

```elixir
def validate_entries(company_id, entries, opts \\ []) do
  with :ok <- check_count(entries),
       :ok <- check_sides(entries, Keyword.get(opts, :allow_negative, false)),
       :ok <- check_balance(entries),
       :ok <- check_party(entries) do
    check_accounts(company_id, entries)
  end
end

def post!(voucher, entries, opts \\ []) do
  case validate_entries(voucher.company_id, entries, opts) do
    :ok -> :ok
    {:error, msg} -> raise ArgumentError, "过账校验失败:#{msg}"
  end
  # rows 组装同现状,Map.take 键集改 @entry_keys ++ [:is_reversal]
  ...
end

@doc "红冲:原有效分录组取负生成红字组(is_reversal),原组标记 is_reversed(已红冲)。"
def reverse!(voucher_type, voucher_id, posting_date) do
  originals =
    GlEntry
    |> Ash.Query.filter(
      voucher_type == ^voucher_type and voucher_id == ^voucher_id and
        is_cancelled == false and is_reversed == false and is_reversal == false
    )
    |> Ash.read!(authorize?: false)

  if originals == [], do: raise(ArgumentError, "该单据没有可红冲的分录")

  [first | _] = originals

  red_entries =
    Enum.map(originals, fn e ->
      %{
        account_id: e.account_id,
        currency_id: e.currency_id,
        debit: Decimal.negate(e.debit),
        credit: Decimal.negate(e.credit),
        party_type: e.party_type,
        party_id: e.party_id,
        is_reversal: true,
        remarks: if(e.remarks, do: "红冲:#{e.remarks}", else: "红冲")
      }
    end)

  :ok =
    post!(
      %{
        voucher_type: voucher_type,
        voucher_id: voucher_id,
        voucher_no: first.voucher_no,
        company_id: first.company_id,
        posting_date: posting_date
      },
      red_entries,
      allow_negative: true
    )

  %Ash.BulkResult{status: :success} =
    GlEntry
    |> Ash.Query.filter(id in ^Enum.map(originals, & &1.id))
    |> Ash.bulk_update(:mark_reversed, %{},
      strategy: :atomic,
      authorize?: false,
      return_errors?: true
    )

  :ok
end

defp check_sides(entries, allow_negative?) do
  ok? =
    Enum.all?(entries, fn entry ->
      debit = dec(entry[:debit])
      credit = dec(entry[:credit])
      single_sided = (Decimal.compare(debit, 0) != :eq) != (Decimal.compare(credit, 0) != :eq)

      if allow_negative? do
        single_sided
      else
        single_sided and Decimal.compare(debit, 0) != :lt and
          Decimal.compare(credit, 0) != :lt
      end
    end)

  if ok? do
    :ok
  else
    {:error,
     if(allow_negative?, do: "每行借贷必须恰一边非零", else: "每行借贷必须恰一边大于零")}
  end
end
```

调用方同步:`gl_journal.ex` 三处 `GL.validate_entries/2`、`GL.post!/2` 调用不加 opts 即维持原行为,无需改动(可选参数向后兼容)。

- [ ] **Step 5: 生成并执行迁移**

```bash
mix ash_postgres.generate_migrations gl_entry_red_reversal
mix ecto.migrate && MIX_ENV=test mix ecto.migrate
```

检查生成的迁移:应含删旧建新 `single_sided_amount` 约束 + `is_reversed`/`is_reversal` 两列(default false, not null)。

- [ ] **Step 6: 跑测试**(`mix test test/synie_core/acc`,全绿;凭证既有测试不受影响)
- [ ] **Step 7: Commit**(`feat: GL 支持红字分录与通用红冲 reverse!`)

---

### Task 3: VatInvoice 资源骨架(枚举/CRUD/权限/审计/编号)+ 系统注册 + 迁移

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/acc/vat_invoice.ex`(含文件头 `InvoiceStatus`/`InvoiceKind`/`InvoiceDirection`/`InvoiceDraft` 小模块,照 `gl_journal.ex` 文件组织)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(queries/mutations/resources 三处)
- Modify: `backend/apps/synie_web/lib/synie_web/grid_meta.ex`(`@resources` 加 `"accVatInvoices"`)
- Modify: `backend/apps/synie_core/lib/synie_core/files/owner_registry.ex`(`"acc_vat_invoice" => SynieCore.Acc.VatInvoice`)
- Create(codegen): `backend/apps/synie_core/priv/repo/migrations/*_add_acc_vat_invoice.exs`
- Test: `backend/apps/synie_core/test/synie_core/acc/vat_invoice_test.exs`

**Interfaces:**
- Consumes: Task 1 的 `PartyType`/`PartyExists`;`SynieCore.Numbering.AutoNumber`;Authz 三件(HasPermission/CompanyScope/CompanyAccessible)。
- Produces: `SynieCore.Acc.VatInvoice`,graphql type `:acc_vat_invoice`,list query `:acc_vat_invoices`,mutations `create/update/destroy_acc_vat_invoice`;`permission_prefix "acc.vat_invoice"`;`lock_invoice/1`(FOR UPDATE 重读,照 `gl_journal.ex` 的 `lock_journal`)。Task 4 在同文件补 audit/void/reverse。

- [ ] **Step 1: 确认 PG ≥ 15**(唯一索引用 NULLS NOT DISTINCT)

```bash
docker exec synie-pg psql -U postgres -tc "show server_version"
```

期望 ≥ 15;若更低,invoice_code 改「非空默认空串」规约并去掉 nulls_distinct(同步改 spec 注记)。

- [ ] **Step 2: 写失败测试**(要点用例;夹具照 `gl_entry_test.exs` 模式)

```elixir
defmodule SynieCore.Acc.VatInvoiceTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.VatInvoice

  # 夹具:company!()、客户 customer!()、actor(permissions: ["acc.vat_invoice:*"], company_ids: [co.id])

  test "创建草稿:状态默认 draft,创建人取 actor"
  test "对手存在性:party_type=company 时 party_id 必须是公司"        # PartyExists 覆盖内部公司
  test "同公司同发票代码+号码重复被唯一索引拒绝"
  test "invoice_no 为空的草稿不占唯一坑(可多张)"
  test "仅草稿可改可删:手工把 status 置 audited 后 update/destroy 报错"
  test "读取按公司范围过滤 fail-closed"
  test "items 接受 map 数组并原样读回"
end
```

- [ ] **Step 3: 跑测试确认失败**(模块不存在)

- [ ] **Step 4: 实现资源**

文件头小模块:

```elixir
defmodule SynieCore.Acc.InvoiceStatus do
  @moduledoc "发票状态:草稿/已审核/已作废/已红冲。"
  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废", reversed: "已红冲"]
  def graphql_type(_), do: :acc_invoice_status
end

defmodule SynieCore.Acc.InvoiceDirection do
  @moduledoc "开票方向:开入(进项)/开出(销项)。"
  use Ash.Type.Enum, values: [inbound: "开入", outbound: "开出"]
  def graphql_type(_), do: :acc_invoice_direction
end

defmodule SynieCore.Acc.InvoiceKind do
  @moduledoc "发票种类。"
  use Ash.Type.Enum,
    values: [
      special: "增值税专用发票",
      normal: "增值税普通发票",
      electronic_special: "电子专用发票",
      electronic_normal: "电子普通发票",
      digital_special: "数电专票",
      digital_normal: "数电普票"
    ]

  def graphql_type(_), do: :acc_invoice_kind
end

defmodule SynieCore.Acc.InvoiceDraft do
  @moduledoc "校验发票处于草稿态(修改/删除的前提)。"
  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft,
      do: :ok,
      else: {:error, message: "仅草稿发票可修改或删除"}
  end
end
```

主资源要点(结构逐段照 `gl_journal.ex`,此处只列与凭证不同的部分):

```elixir
use Ash.Resource,
  domain: SynieCore,
  data_layer: AshPostgres.DataLayer,
  extensions: [AshGraphql.Resource],
  authorizers: [Ash.Policy.Authorizer],
  fragments: [SynieCore.Audit.Fragment]

postgres do
  table "acc_vat_invoice"
  repo SynieCore.Repo

  custom_indexes do
    # 防重录:代码可空(数电票),NULLS NOT DISTINCT 让空代码也参与判重;草稿无号不占坑
    index [:company_id, :invoice_code, :invoice_no],
      unique: true,
      nulls_distinct: false,
      where: "invoice_no IS NOT NULL",
      name: "acc_vat_invoice_no_uniq",
      message: "该公司下相同发票代码+号码已登记"

    index [:company_id, :doc_no],
      unique: true,
      where: "doc_no IS NOT NULL",
      name: "acc_vat_invoice_doc_no_uniq",
      message: "单据编号已存在"

    index [:company_id, :status]
    index [:company_id, :invoice_date]
  end
end

graphql do
  type :acc_vat_invoice
  attribute_types items: :json_string
end

def permission_prefix, do: "acc.vat_invoice"
def permission_actions, do: ~w(create read update delete audit void reverse)

# grid_actions 在 Task 4 补(动作 mutation 就绪后);poly_refs 现在就声明
def poly_refs do
  %{party_id: %{discriminator: :party_type, variants: SynieCore.Acc.PartyType.party_resources()}}
end
```

attributes(全部 `public? true`,description 用中文):`doc_no`(string≤32,可空)、`direction`(InvoiceDirection,非空)、`invoice_date`(date,可空)、`posting_date`(date,可空)、`party_type`(PartyType,非空)/`party_id`(uuid,非空)、`invoice_kind`(InvoiceKind,非空)、`invoice_code`(string≤20,可空)、`invoice_no`(string≤32,可空)、`seller_name`/`seller_tax_no`/`seller_address_phone`/`seller_bank_account`/`buyer_name`/`buyer_tax_no`/`buyer_address_phone`/`buyer_bank_account`(string,可空)、`items`(`{:array, :map}`,非空默认 `[]`)、`net_total`/`tax_total`/`gross_total`(decimal,可空)、`issuer`/`reviewer`/`payee`(string,可空)、`remarks`(string,可空)、`red_invoice_no`(string,可空)、`status`(InvoiceStatus,非空默认 `:draft`,`writable? false`)、`audited_at`(utc_datetime_usec,可空,`writable? false`)、时间戳。

relationships:`belongs_to :company, SynieCore.Base.Company`(非空)、`belongs_to :party_account/:amount_account/:tax_account, SynieCore.Base.Account`(可空)、`belongs_to :created_by/:audited_by, SynieCore.Accounts.User`(可空,`writable? false` 属性照 gl_journal 的 created_by 写法)。

actions(CRUD;audit/void/reverse 在 Task 4):

```elixir
read :read do
  primary? true
  pagination offset?: true, countable: true, required?: false,
             default_limit: 20, max_page_size: 200
end

create :create do
  accept [
    :company_id, :doc_no, :direction, :invoice_date, :party_type, :party_id,
    :invoice_kind, :invoice_code, :invoice_no,
    :seller_name, :seller_tax_no, :seller_address_phone, :seller_bank_account,
    :buyer_name, :buyer_tax_no, :buyer_address_phone, :buyer_bank_account,
    :items, :net_total, :tax_total, :gross_total,
    :issuer, :reviewer, :payee, :remarks,
    :party_account_id, :amount_account_id, :tax_account_id
  ]

  validate {SynieCore.Authz.Validations.CompanyAccessible, []}
  validate {SynieCore.Acc.PartyExists, []}

  change {SynieCore.Numbering.AutoNumber, attribute: :doc_no}
  # created_by 取 actor,照 gl_journal.ex create 的 change fn
end

update :update do
  accept [同 create 去掉 :company_id]
  require_atomic? false
  validate {SynieCore.Acc.InvoiceDraft, []}
  validate {SynieCore.Acc.PartyExists, []}
  # before_action FOR UPDATE 复检草稿,照 gl_journal.ex update
end

destroy :destroy do
  primary? true
  require_atomic? false
  validate {SynieCore.Acc.InvoiceDraft, []}
  # before_action FOR UPDATE 复检草稿,照 gl_journal.ex destroy
end
```

`lock_invoice/1` 照 `gl_journal.ex` 的 `lock_journal/1` 原样改名。

- [ ] **Step 5: 注册**:`synie_core.ex` graphql queries 块加 `list SynieCore.Acc.VatInvoice, :acc_vat_invoices, :read, paginate_with: :offset`,mutations 块加 create/update/destroy 三条,resources 块加 `resource SynieCore.Acc.VatInvoice`;`grid_meta.ex` `@resources` 加 `"accVatInvoices" => SynieCore.Acc.VatInvoice`;`owner_registry.ex` 加 `"acc_vat_invoice" => SynieCore.Acc.VatInvoice`。

- [ ] **Step 6: 生成并执行迁移**(`mix ash_postgres.generate_migrations add_acc_vat_invoice` + 两库 migrate;检查唯一索引带 `NULLS NOT DISTINCT` 与 `WHERE`)

- [ ] **Step 7: 跑测试**(`mix test test/synie_core/acc/vat_invoice_test.exs` 全绿,再全量 `mix test`)
- [ ] **Step 8: Commit**(`feat: 增值税发票资源骨架与注册`)

---

### Task 4: 发票 audit/void/reverse 三动作 + 凭证派生 + GL 集成

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/acc/vat_invoice.ex`(三动作、`gl_entries/1`、`audit_blockers/1`、`grid_actions/0`)
- Modify: `backend/apps/synie_core/lib/synie_core/acc/gl.ex`(`voucher_resources/0` 注册发票)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(mutations 块加 audit/void/reverse 三条 update mutation)
- Test: `backend/apps/synie_core/test/synie_core/acc/vat_invoice_test.exs`(追加)

**Interfaces:**
- Consumes: Task 2 的 `GL.post!/3`、`GL.cancel!/2`、`GL.reverse!/3`;Task 3 的资源骨架与 `lock_invoice/1`。
- Produces: mutations `audit_acc_vat_invoice`(input: postingDate)、`void_acc_vat_invoice`(无 input 字段)、`reverse_acc_vat_invoice`(input: postingDate 必填 argument + redInvoiceNo);`voucher_type "acc.vat_invoice"`;`gl_entries/1` 返回 GL entries map 列表。前端 Task 7 按这些 mutation 名接线。

- [ ] **Step 1: 写失败测试**(追加用例)

```elixir
describe "审核过账" do
  test "开出发票审核生成 借往来(带对手)/贷价款/贷税额 三行且配平"
  test "开入发票审核生成 借价款/借税额/贷往来(带对手) 三行"
  test "税额为 0 只生成两行,税额科目可空"
  test "审核必填项缺失被拒:无发票号码/无开票日期/勾稽不平(net+tax≠gross)/税额>0 但无税额科目"
  test "审核后 update/destroy 被拒"
  test "voucher_no 优先 doc_no,无则用 invoice_no"
end

describe "作废与红冲" do
  test "void:原分录组标记 is_cancelled,发票 voided"
  test "reverse:红字组生成、原组标 is_reversed,发票 reversed,red_invoice_no 存档"
  test "void 后不能 reverse,reverse 后不能 void(仅 audited 可操作)"
  test "草稿不能 void/reverse"
end
```

关键断言示例(红冲):

```elixir
{:ok, inv} = audit!(inv, ~D[2026-07-15])

inv =
  inv
  |> Ash.Changeset.for_update(:reverse, %{red_invoice_no: "RED001"},
    actor: actor, arguments: %{posting_date: ~D[2026-07-31]}
  )
  |> Ash.update!()

assert inv.status == :reversed
assert inv.red_invoice_no == "RED001"

entries = entries_for("acc.vat_invoice", inv.id)
assert Enum.count(entries, & &1.is_reversal) == Enum.count(entries, & &1.is_reversed)
assert Decimal.equal?(Enum.reduce(entries, Decimal.new(0), &Decimal.add(&1.debit, &2)), Decimal.new(0))
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `gl_entries/1` 与 `audit_blockers/1`**

```elixir
@doc "按三科目与方向派生分录组;红冲取负由 GL.reverse! 负责,不在此处理。"
def gl_entries(%__MODULE__{} = inv) do
  currencies =
    SynieCore.Base.Account
    |> Ash.Query.filter(id in ^Enum.reject([inv.party_account_id, inv.amount_account_id, inv.tax_account_id], &is_nil/1))
    |> Ash.read!(authorize?: false)
    |> Map.new(&{&1.id, &1.currency_id})

  zero = Decimal.new(0)

  entry = fn account_id, debit, credit, party? ->
    %{
      account_id: account_id,
      currency_id: currencies[account_id],
      debit: debit,
      credit: credit,
      party_type: if(party?, do: inv.party_type),
      party_id: if(party?, do: inv.party_id),
      remarks: nil
    }
  end

  tax? = inv.tax_total != nil and Decimal.compare(inv.tax_total, 0) == :gt

  case inv.direction do
    :outbound ->
      [entry.(inv.party_account_id, inv.gross_total, zero, true),
       entry.(inv.amount_account_id, zero, inv.net_total, false)] ++
        if(tax?, do: [entry.(inv.tax_account_id, zero, inv.tax_total, false)], else: [])

    :inbound ->
      [entry.(inv.amount_account_id, inv.net_total, zero, false)] ++
        if(tax?, do: [entry.(inv.tax_account_id, inv.tax_total, zero, false)], else: []) ++
        [entry.(inv.party_account_id, zero, inv.gross_total, true)]
  end
end

@doc "审核前的齐全性检查,返回缺失/错误清单(空 = 可审核)。"
def audit_blockers(inv) do
  zero = Decimal.new(0)

  [
    {is_nil(inv.invoice_no), "审核前必须填写发票号码"},
    {is_nil(inv.invoice_date), "审核前必须填写开票日期"},
    {is_nil(inv.net_total) or is_nil(inv.tax_total) or is_nil(inv.gross_total),
     "审核前必须填写未税金额、税额与价税合计"},
    {not is_nil(inv.gross_total) and Decimal.compare(inv.gross_total, zero) != :gt,
     "价税合计必须大于零"},
    {not is_nil(inv.tax_total) and Decimal.compare(inv.tax_total, zero) == :lt, "税额不能为负"},
    {not (is_nil(inv.net_total) or is_nil(inv.tax_total) or is_nil(inv.gross_total)) and
       not Decimal.equal?(Decimal.add(inv.net_total, inv.tax_total), inv.gross_total),
     "未税金额+税额必须等于价税合计"},
    {is_nil(inv.party_account_id), "审核前必须选择往来科目"},
    {is_nil(inv.amount_account_id), "审核前必须选择价款科目"},
    {not is_nil(inv.tax_total) and Decimal.compare(inv.tax_total, zero) == :gt and
       is_nil(inv.tax_account_id), "税额大于零时必须选择税额科目"}
  ]
  |> Enum.filter(&elem(&1, 0))
  |> Enum.map(&elem(&1, 1))
end
```

- [ ] **Step 4: 实现三动作**(三层结构照 `gl_journal.ex` 的 audit/cancel;差异点如下)

```elixir
update :audit do
  accept [:posting_date]
  require_atomic? false

  validate fn changeset, _ ->
    if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿发票可审核"}
  end

  validate fn changeset, _ ->
    if Ash.Changeset.get_attribute(changeset, :posting_date),
      do: :ok,
      else: {:error, field: :posting_date, message: "审核过账前必须填写过账日期"}
  end

  validate fn changeset, _ ->
    case __MODULE__.audit_blockers(changeset.data) do
      [] ->
        case SynieCore.Acc.GL.validate_entries(
               changeset.data.company_id,
               __MODULE__.gl_entries(changeset.data)
             ) do
          :ok -> :ok
          {:error, msg} -> {:error, message: msg}
        end

      msgs ->
        {:error, message: Enum.join(msgs, ";")}
    end
  end

  change fn changeset, context ->
    changeset
    |> Ash.Changeset.force_change_attribute(:status, :audited)
    |> Ash.Changeset.force_change_attribute(:audited_at, DateTime.utc_now())
    # audited_by 取 actor,照 gl_journal submitted_by 写法
    |> Ash.Changeset.before_action(fn cs ->
      # FOR UPDATE 复检:草稿 + blockers + validate_entries(照 gl_journal audit)
    end)
    |> Ash.Changeset.after_action(fn _cs, inv ->
      SynieCore.Acc.GL.post!(
        %{
          voucher_type: "acc.vat_invoice",
          voucher_id: inv.id,
          voucher_no: inv.doc_no || inv.invoice_no,
          company_id: inv.company_id,
          posting_date: inv.posting_date
        },
        __MODULE__.gl_entries(inv)
      )

      {:ok, inv}
    end)
  end
end

update :void do
  accept []
  require_atomic? false

  validate fn changeset, _ ->
    if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核发票可作废"}
  end

  change fn changeset, _ ->
    changeset
    |> Ash.Changeset.force_change_attribute(:status, :voided)
    |> Ash.Changeset.before_action(fn cs ->
      # FOR UPDATE 复检 audited,照 gl_journal cancel
    end)
    |> Ash.Changeset.after_action(fn _cs, inv ->
      SynieCore.Acc.GL.cancel!("acc.vat_invoice", inv.id)
      {:ok, inv}
    end)
  end
end

update :reverse do
  accept [:red_invoice_no]
  argument :posting_date, :date, allow_nil?: false
  require_atomic? false

  validate fn changeset, _ ->
    if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核发票可红冲"}
  end

  change fn changeset, _ ->
    posting_date = Ash.Changeset.get_argument(changeset, :posting_date)

    changeset
    |> Ash.Changeset.force_change_attribute(:status, :reversed)
    |> Ash.Changeset.before_action(fn cs ->
      # FOR UPDATE 复检 audited
    end)
    |> Ash.Changeset.after_action(fn _cs, inv ->
      SynieCore.Acc.GL.reverse!("acc.vat_invoice", inv.id, posting_date)
      {:ok, inv}
    end)
  end
end
```

`grid_actions/0`:

```elixir
def grid_actions do
  [
    %{key: "audit", label: "审核", scope: "row", mutation: "auditAccVatInvoice", is_danger: false},
    %{key: "void", label: "作废", scope: "row", mutation: "voidAccVatInvoice", is_danger: true},
    %{key: "reverse", label: "红冲", scope: "row", mutation: "reverseAccVatInvoice", is_danger: true}
  ]
end
```

`gl.ex` 注册:

```elixir
def voucher_resources do
  %{
    "acc.gl_journal" => {SynieCore.Acc.GlJournal, "凭证"},
    "acc.vat_invoice" => {SynieCore.Acc.VatInvoice, "增值税发票"}
  }
end
```

`synie_core.ex` mutations 块追加:

```elixir
update SynieCore.Acc.VatInvoice, :audit_acc_vat_invoice, :audit
update SynieCore.Acc.VatInvoice, :void_acc_vat_invoice, :void
update SynieCore.Acc.VatInvoice, :reverse_acc_vat_invoice, :reverse
```

- [ ] **Step 5: 跑测试**(先本文件再全量 `mix test`,全绿)
- [ ] **Step 6: Commit**(`feat: 发票审核过账/作废/红冲,红冲开出红字凭证并标记原凭证`)

---

### Task 5: 前端组件扩展——本地 meta 模式 + extraContent patchValues

**Files:**
- Modify: `web/app/components/synie-data-grid/types.ts`(导出 `LocalGridMeta`)
- Modify: `web/app/components/synie-record-drawer/SynieRecordDrawer.tsx`
- Modify: `web/app/components/synie-editable-table/SynieEditableTable.tsx`

**Interfaces:**
- Produces: 两组件新增可选 prop `meta?: LocalGridMeta`(`{ columns: GridColumnMeta[] }`):提供时不发 GridMeta 查询,列/字段全取本地定义;`SynieRecordDrawer.extraContent` 第四参 `patchValues(patch)`(把补丁并入表单草稿,view 态为 no-op)。Task 7 发票页依赖两者。

- [ ] **Step 1: types.ts 加类型**

```ts
/** 本地 meta:不经后端 GridMeta 反射的显式列定义(内嵌 json 子表等场景) */
export interface LocalGridMeta {
  columns: GridColumnMeta[]
}
```

- [ ] **Step 2: SynieRecordDrawer 改造**

```ts
// props 增:
/** 本地列/字段定义,提供时跳过 GridMeta 查询(resource 仅作缓存 key/标题用途) */
meta?: LocalGridMeta
/** extraContent 第 4 参:向表单草稿并入补丁(view 态为 no-op) */
extraContent?: (mode, row, values, patchValues: (patch: Record<string, unknown>) => void) => ReactNode

// 组件内:
const remoteMeta = useGridMeta(resource, !props.meta)          // 本地模式不发请求
const columns = props.meta?.columns ?? remoteMeta.data?.columns ?? []
const metaPending = !props.meta && remoteMeta.isPending
// byId 自查(rowId 路径)维持走 remoteMeta,追加 enabled 条件 !props.meta
// resolveFields(columns, ...) 与所有 meta.data?.columns 引用统一改经 columns
const patchValues = (patch: Record<string, unknown>) => {
  if (renderMode === 'view') return
  setValues((v) => ({ ...v, ...patch }))
}
// extraContent 调用处补第 4 参
```

- [ ] **Step 3: SynieEditableTable 改造**

```ts
// props 增 meta?: LocalGridMeta
const remote = useGridMeta(resource, !props.meta)
const metaColumns = props.meta?.columns ?? remote.data?.columns ?? []
// isPending/isError 分支仅在 !props.meta 时生效;内层 SynieRecordDrawer 透传 meta={props.meta}
```

- [ ] **Step 4: 类型检查 + 回归**

```bash
cd web && bun x tsc -p tsconfig.json --noEmit
```

期望零错误;`journals.tsx`/`customers.tsx` 等既有调用点不传新 prop,行为不变(extraContent 新参在旧调用点未使用,类型兼容)。

- [ ] **Step 5: Commit**(`feat: RecordDrawer/EditableTable 支持本地 meta 与草稿补丁回写`)

---

### Task 6: 金额格式化与人民币大写工具

**Files:**
- Create: `web/app/lib/amount.ts`
- Test: `web/app/lib/amount.test.ts`(bun 内置 test runner)

**Interfaces:**
- Produces: `formatAmount(value: unknown): string`(千分位+两位小数,空值回 `''`,非数值原样)、`amountInWords(value: unknown): string`(人民币中文大写:元角分,负数冠「负」,零角有分补「零」,整数尾「整」)。Task 7 页面消费。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'bun:test'
import { amountInWords, formatAmount } from './amount'

describe('formatAmount', () => {
  test('千分位两位小数', () => expect(formatAmount(1234567.8)).toBe('1,234,567.80'))
  test('空值', () => expect(formatAmount(null)).toBe(''))
})

describe('amountInWords', () => {
  test('零', () => expect(amountInWords(0)).toBe('零元整'))
  test('整数', () => expect(amountInWords(10)).toBe('壹拾元整'))
  test('角分', () => expect(amountInWords(1234.56)).toBe('壹仟贰佰叁拾肆元伍角陆分'))
  test('只有分补零', () => expect(amountInWords(105.05)).toBe('壹佰零伍元零伍分'))
  test('纯分', () => expect(amountInWords(0.05)).toBe('伍分'))
  test('跨组补零', () => expect(amountInWords(100200)).toBe('壹拾万零贰佰元整'))
  test('中段整组为零', () => expect(amountInWords(100000200)).toBe('壹亿零贰佰元整'))
  test('亿', () => expect(amountInWords(100000000)).toBe('壹亿元整'))
  test('负数', () => expect(amountInWords(-3.2)).toBe('负叁元贰角'))
})
```

- [ ] **Step 2: 跑测试确认失败**(`cd web && bun test app/lib/amount.test.ts`)

- [ ] **Step 3: 实现**

```ts
/** 金额千分位两位小数;空值回空串,非数值原样字符串化 */
export function formatAmount(value: unknown): string {
  if (value == null || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const DIGITS = '零壹贰叁肆伍陆柒捌玖'
const UNITS = ['', '拾', '佰', '仟']
const GROUPS = ['', '万', '亿', '万亿']

function segmentInWords(seg: number): string {
  let out = ''
  let pendingZero = false
  for (let u = 3; u >= 0; u--) {
    const d = Math.floor(seg / 10 ** u) % 10
    if (d === 0) {
      if (out) pendingZero = true
      continue
    }
    if (pendingZero) {
      out += '零'
      pendingZero = false
    }
    out += DIGITS[d] + UNITS[u]
  }
  return out
}

function integerInWords(n: number): string {
  const segs: number[] = []
  while (n > 0) {
    segs.push(n % 10000)
    n = Math.floor(n / 10000)
  }
  let out = ''
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    if (seg === 0) {
      if (out && !out.startsWith('零')) out = '零' + out
      continue
    }
    if (out && segs[i - 1]! > 0 && segs[i - 1]! < 1000 && !out.startsWith('零')) out = '零' + out
    out = segmentInWords(seg) + GROUPS[i] + out
  }
  return out
}

/** 人民币中文大写:元角分,负数冠「负」,无角有分补「零」,无角无分尾「整」 */
export function amountInWords(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  if (n < 0) return `负${amountInWords(-n)}`
  const cents = Math.round(n * 100)
  if (cents === 0) return '零元整'
  const yuan = Math.floor(cents / 100)
  const jiao = Math.floor(cents / 10) % 10
  const fen = cents % 10

  let out = yuan > 0 ? `${integerInWords(yuan)}元` : ''
  if (jiao === 0 && fen === 0) return `${out}整`
  if (jiao > 0) out += `${DIGITS[jiao]}角`
  else if (yuan > 0 && fen > 0) out += '零'
  if (fen > 0) out += `${DIGITS[fen]}分`
  return out
}
```

- [ ] **Step 4: 跑测试通过**(全绿;若个别大写断言与实现出入,以中文大写规范为准修实现,不改断言语义)
- [ ] **Step 5: Commit**(`feat: 金额格式化与人民币大写工具`)

---

### Task 7: 发票页面 + 注册与标签

**Files:**
- Create: `web/app/routes/_app/finance/invoices.tsx`
- Modify: `web/app/components/synie-record-drawer/registry.ts`(`accVatInvoices` 登记)
- Modify: `web/app/lib/menu.ts`(财务模块加「发票管理」组:`{ label: '增值税发票', path: '/finance/invoices' }`)
- Modify: `web/app/components/synie-permission-sheet/permission-labels.ts`(资源 `'acc.vat_invoice': '增值税发票'`;动作标签映射补 `void: '作废'`、`reverse: '红冲'`,audit 已有)
- Modify: `web/app/routes/_app/system/logs.tsx`(动作标签补 `void: '作废'`、`reverse: '红冲'`;资源标签映射补发票)
- Modify: `web/app/routes/_app/finance/entries.tsx`(列白名单追加 `isReversed`、`isReversal` 两布尔列)

**Interfaces:**
- Consumes: Task 4 的 mutations(`createAccVatInvoice`/`updateAccVatInvoice`/`auditAccVatInvoice`/`voidAccVatInvoice`/`reverseAccVatInvoice`)与 GridMeta 反射(含 `partyId` 多态 fk、`audit/void/reverse` extendedActions);Task 5 的 `meta`/`patchValues`;Task 6 的 `formatAmount`/`amountInWords`。

- [ ] **Step 1: 页面骨架**(整体照 `journals.tsx`:DataGrid + RecordDrawer + 审核弹窗;差异点如下,其余照抄该文件既有写法)

明细本地 meta 与金额列:

```ts
import type { LocalGridMeta } from '~/components/synie-data-grid/types'
import { amountInWords, formatAmount } from '~/lib/amount'
import { localRowId } from '~/components/synie-editable-table/editable'

// 销售清单行结构 = OCR 目标 schema;纯文本档案,不关联物料
const ITEM_META: LocalGridMeta = {
  columns: [
    { name: 'name', type: 'string', label: '物料名称', sortable: false, filterable: false },
    { name: 'model', type: 'string', label: '规格型号', sortable: false, filterable: false },
    { name: 'unit', type: 'string', label: '单位', sortable: false, filterable: false },
    { name: 'quantity', type: 'decimal', label: '数量', sortable: false, filterable: false },
    { name: 'price', type: 'decimal', label: '单价', sortable: false, filterable: false },
    { name: 'net_amount', type: 'decimal', label: '金额', sortable: false, filterable: false },
    { name: 'tax_rate', type: 'string', label: '税率', sortable: false, filterable: false },
    { name: 'tax_amount', type: 'decimal', label: '税额', sortable: false, filterable: false },
  ],
}

// items 走 json_string:读 = JSON 串数组逐行 parse + 挂本地 id;写 = 剥 id 逐行 stringify
function parseItems(raw: unknown): Row[] {
  if (!Array.isArray(raw)) return []
  return raw.map((s) => ({ id: localRowId(), ...(JSON.parse(String(s)) as object) }) as Row)
}

function serializeItems(items: Row[]): string[] {
  return items.map(({ id: _id, ...rest }) => JSON.stringify(rest))
}
```

表格列与状态胶囊:

```ts
const GRID_COLUMNS = ['companyId', 'docNo', 'direction', 'partyId', 'invoiceKind',
  'invoiceNo', 'invoiceDate', 'grossTotal', 'status', 'auditedById']

const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger', REVERSED: 'warning' } },
  grossTotal: { render: (v: unknown) => formatAmount(v) },
} satisfies Record<string, ColumnOverride>
```

抽屉 fields 要点(exclude:`status/auditedAt/auditedById/createdById/postingDate/redInvoiceNo/insertedAt/updatedAt`,后两者 view 态经字段 override 单独放开可后调):

```ts
fields={{
  companyId: { required: true, order: -1, edit: 'createOnly',
    // 换公司清科目(科目按公司隔离)
    effects: () => ({ partyAccountId: null, amountAccountId: null, taxAccountId: null }) },
  docNo: { placeholder: '留空自动编号' },
  direction: { required: true, cols: 6 },
  invoiceKind: { required: true, cols: 6 },
  partyType: { cols: 6, effects: () => ({ partyId: null }) },
  partyId: { cols: 6,
    visible: (v) => v.partyType != null,
    input: ({ value, onChange, isDisabled, values }) => {
      const cfg = { SUPPLIER: ['purSuppliers', '供应商'], CUSTOMER: ['salCustomers', '客户'],
        COMPANY: ['basCompanies', '内部公司'] }[String(values.partyType)] ?? ['salCustomers', '对手']
      return <RemoteSelect resource={cfg[0]} label={cfg[1]} placeholder={`选择${cfg[1]}…`}
        value={value == null ? null : String(value)} onChange={onChange} isDisabled={isDisabled} />
    } },
  invoiceCode: { cols: 6, placeholder: '数电票留空' },
  invoiceNo: { cols: 6, placeholder: '草稿可留空,审核前必填' },
  invoiceDate: { cols: 6 },
  netTotal: { cols: 4 }, taxTotal: { cols: 4 }, grossTotal: { cols: 4 },
  partyAccountId: { cols: 4, remote: { filter: accountFilter } },   // 同 journals 科目 filter:公司+非汇总+启用
  amountAccountId: { cols: 4, remote: { filter: accountFilter } },
  taxAccountId: { cols: 4, remote: { filter: accountFilter } },
  sellerName: { cols: 6 }, sellerTaxNo: { cols: 6 },
  sellerAddressPhone: { cols: 6 }, sellerBankAccount: { cols: 6 },
  buyerName: { cols: 6 }, buyerTaxNo: { cols: 6 },
  buyerAddressPhone: { cols: 6 }, buyerBankAccount: { cols: 6 },
  issuer: { cols: 4 }, reviewer: { cols: 4 }, payee: { cols: 4 },
}}
```

extraContent(大写/汇总/明细/附件;items 状态页面自持,开抽屉时 `parseItems(row?.items)` 初始化):

```tsx
extraContent={(mode, row, values, patchValues) => (
  <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted">价税合计(大写):</span>
      <span>{values.grossTotal != null && values.grossTotal !== '' ? amountInWords(values.grossTotal) : '—'}</span>
      {mode !== 'view' && (
        <Button size="sm" variant="secondary" onPress={() => {
          const sum = (k: string) => items.reduce((acc, r) => acc + (Number(r[k]) || 0), 0)
          const net = sum('net_amount'); const tax = sum('tax_amount')
          patchValues({ netTotal: net.toFixed(2), taxTotal: tax.toFixed(2), grossTotal: (net + tax).toFixed(2) })
        }}>
          从明细汇总带出
        </Button>
      )}
    </div>
    <SynieEditableTable
      resource="local:vatInvoiceItems"
      meta={ITEM_META}
      label="销售清单"
      items={items}
      onChange={setItems}
      readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT')}
    />
    <SynieAttachmentPanel ownerType="acc_vat_invoice" ownerId={row?.id ?? null} category="original" readonly={mode === 'view'} />
  </div>
)}
```

提交(items 随头一并写,无行 diff 持久化):

```ts
onSubmit={async (values, mode) => {
  const input = { ...values, items: serializeItems(items) }
  // create/update 走 createAccVatInvoice / updateAccVatInvoice,错误处理与 Toast 照 journals.tsx
  // create 成功后若已填 postingDate → openAudit(fromCreate) 顺手审核(照 journals)
}}
```

行动作:`actionHandlers={{ audit: (rows) => openAudit(rows[0]), reverse: (rows) => openReverse(rows[0]) }}`;`void` 不接管,走 extendedAction 默认「确认框 + id mutation」。审核弹窗照 `journals.tsx:366-434`(默认日期 `postingDate ?? invoiceDate`);红冲弹窗照审核弹窗改:DatePicker(红冲过账日期,必填)+ TextField(红字发票号码,选填),提交 `reverseAccVatInvoice(id, input: { postingDate, redInvoiceNo })`。

- [ ] **Step 2: 四处注册**:`registry.ts` 加 `accVatInvoices: { label: '增值税发票' }`;`menu.ts` 财务模块 groups 加 `{ label: '发票管理', items: [{ label: '增值税发票', path: '/finance/invoices' }] }`;`permission-labels.ts` 与 `logs.tsx` 补资源/动作标签(对照文件内 `acc.gl_journal`/audit 的既有写法)。

- [ ] **Step 3: entries.tsx 补红冲标记列**:列白名单在 `voucherId` 之后追加 `isReversed`、`isReversal`(布尔默认渲染是/否 Chip,无需 override)。

- [ ] **Step 4: 类型检查**(`bun x tsc -p tsconfig.json --noEmit` 零错误)
- [ ] **Step 5: Commit**(`feat: 增值税发票页——台账/审核/作废/红冲/附件/大写`)

---

### Task 8: 端到端验证(E2E)

**Files:** 无代码改动;发现问题回上游任务修。

- [ ] **Step 1: 起服务**(worktree 并行时用环境变量错开端口)

```bash
cd backend && PORT=4100 mix phx.server          # 后端
cd web && BACKEND_PORT=4100 bun dev --host      # 前端,绑 0.0.0.0
```

- [ ] **Step 2: Playwright 走查主链路**(admin/admin123 登录)
  1. 编号规则页给 `acc.vat_invoice` 配一条规则(如 `FP-{company.code}-{seq:4}`),新建发票留空 doc_no 验证自动取号。
  2. 新建**开出**发票:客户对手、三科目(应收/收入/销项税)、明细两行、「从明细汇总带出」金额、大写显示正确 → 保存。
  3. 审核(填过账日期)→ 总账分录页验证 3 行配平、往来行带对手、来源单据列是发票链接(点开速览)。
  4. 红冲(填红冲日期+红字发票号)→ 发票状态「已红冲」;分录页红字组 `is_reversal`=是、负数金额,原组 `is_reversed`=是。
  5. 另建一张**开入**发票(供应商对手,税额 0):审核后两行分录;作废 → 分录 `is_cancelled`=是,发票「已作废」。
  6. 内部公司对手变体可选且校验存在;已审核发票编辑/删除被拒且报错中文可读。
  7. 附件面板上传/下载原件(create 态应提示「保存后可上传」)。
  8. 移动端宽度(<1024px)抽屉与表格可用性 spot check。

- [ ] **Step 3: 后端全量回归**(`mix test` 全绿)+ 权限矩阵页确认「增值税发票」七动作中文显示。
- [ ] **Step 4: Commit 收尾**(如有修补),汇总验证结论。
