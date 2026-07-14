# 银行流水对账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 银行流水与会计凭证的 m-n 金额对账:严格方向/额度校验、流水列表醒目三态展示、对账抽屉(关联已有凭证 + 快速新增凭证自动审核关联 + 解除)。

**Architecture:** 新增 m-n 中间资源 `acc_bank_reconciliation`(流水 id + 凭证 id + 对账金额),流水上加三个持久化派生列(已对账/未对账/状态,由对账增删在锁内刷新——GridMeta 不反射计算列且聚合列不可筛,持久列是既定回退方案)。所有金额校验在事务内 `FOR UPDATE` 权威复检,锁序统一「先流水后凭证」。前端复用 SynieDataGrid/SynieRecordDrawer/RemoteDialogSelect 积木,新扩 rowTint(行高亮)、gqlEnum(枚举字面量)、RemoteDialogSelect gridFilter/gridColumns 三个小能力。

**Tech Stack:** Elixir/Ash 3 + AshPostgres + AshGraphql(backend umbrella `backend/`);React 19 + TanStack Start + @heroui(-pro)/react v3 + GraphQL(`web/`)。

**Spec:** `docs/superpowers/specs/2026-07-14-bank-reconciliation-design.md`(必读,尤其校验规则一节)。

## Global Constraints

- 工作目录 = 本 worktree 根(`git rev-parse --show-toplevel`,分支 `worktree-bank-reconciliation`)。下文相对路径均以它为根。禁止推 main。
- 后端命令前必须:`export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"`(mix 不在非交互 shell PATH)。
- Postgres 在 5440(synie-pg 容器),backend 的 dev/test config 已指向,无需传 PGPORT。
- 后端测试:`cd backend && mix test <文件>`;迁移生成 `mix ash_postgres.generate_migrations <名字>`,执行 `mix ecto.migrate`(在 backend 目录)。
- 每个后端任务提交前:`cd backend && mix format`;每个前端任务提交前:`cd web && bun run typecheck`。
- 前端依赖:worktree 的 `web/node_modules` 不存在时先 `ln -s /home/zyan/code/synie/web/node_modules web/node_modules`(主检出已装好含 HeroUI Pro 真实包;不要在 worktree 里跑 bun install,占位包/token 问题)。
- 项目第一语言中文:代码注释、错误信息、提交信息一律中文。提交信息结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 权限硬规则(backend/AGENTS.md):新动作若有独立权限码必须同步补前端 `permission-labels.ts` 与 `logs.tsx` 中文标签(本计划 Task 6 落实)。
- 受审计资源每个 update/destroy 动作必须 `require_atomic? false`;显式 destroy 要 `primary? true`。
- 对账不经 `GL.post!` 走账(流水不记账),不动 `GL.voucher_resources`;快速新增凭证例外——它创建的是正规 GlJournal,走凭证自身的 audit。

---

### Task 1: 后端——对账状态枚举 + 流水派生列

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/acc/reconcile_status.ex`
- Modify: `backend/apps/synie_core/lib/synie_core/acc/bank_transaction.ex`
- Modify: `backend/apps/synie_core/test/synie_core/acc/bank_transaction_test.exs`
- Create: 迁移(生成)`backend/apps/synie_core/priv/repo/migrations/*_bank_txn_reconcile_columns.exs`

**Interfaces:**
- Produces: `SynieCore.Acc.ReconcileStatus` 枚举(`:unreconciled/:partial/:reconciled`,graphql_type `:acc_reconcile_status`);`BankTransaction` 新增 public 只读属性 `reconciled_amount`/`unreconciled_amount`(decimal, 默认 0)与 `reconcile_status`(默认 `:unreconciled`)。后续任务依赖这三个属性名。

- [ ] **Step 1: 写失败测试**——在 `bank_transaction_test.exs` 末尾(最后一个 test 之后、`end` 之前)加:

```elixir
  describe "对账派生列" do
    test "创建收入流水:未对账金额=流水金额,状态未对账", %{company: co, bank_account: ba} do
      txn = txn!(valid_attrs(co, ba))

      assert Decimal.equal?(txn.reconciled_amount, 0)
      assert Decimal.equal?(txn.unreconciled_amount, Decimal.new("100.50"))
      assert txn.reconcile_status == :unreconciled
    end

    test "支出流水同样回填未对账金额", %{company: co, bank_account: ba} do
      txn = txn!(valid_attrs(co, ba, %{income: nil, expense: Decimal.new("88")}))

      assert Decimal.equal?(txn.unreconciled_amount, Decimal.new("88"))
    end
  end
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/acc/bank_transaction_test.exs`
Expected: FAIL(`reconciled_amount` 字段不存在)

- [ ] **Step 3: 新建枚举文件** `backend/apps/synie_core/lib/synie_core/acc/reconcile_status.ex`:

```elixir
defmodule SynieCore.Acc.ReconcileStatus do
  @moduledoc "银行流水对账状态:未对账/部分对账/已对账。持久化派生列,由对账记录增删在锁内刷新。"

  use Ash.Type.Enum, values: [unreconciled: "未对账", partial: "部分对账", reconciled: "已对账"]

  def graphql_type(_), do: :acc_reconcile_status
end
```

- [ ] **Step 4: 改 `bank_transaction.ex`**——三处:

(a)`attributes do` 内、`create_timestamp :inserted_at` 之前加:

```elixir
    attribute :reconciled_amount, :decimal do
      allow_nil? false
      default Decimal.new(0)
      writable? false
      public? true
      description "已对账金额"
    end

    attribute :unreconciled_amount, :decimal do
      allow_nil? false
      default Decimal.new(0)
      writable? false
      public? true
      description "未对账金额"
    end

    attribute :reconcile_status, SynieCore.Acc.ReconcileStatus do
      allow_nil? false
      default :unreconciled
      writable? false
      public? true
      description "对账状态"
    end
```

(b)`create :create` 动作里、三个 validate 之后加(导入转正也走此 create,自动覆盖):

```elixir
      # 派生列初始化:未对账金额 = 流水金额(金额缺失时交给 SingleSidedAmount 报错)
      change fn changeset, _context ->
        amount =
          Ash.Changeset.get_attribute(changeset, :income) ||
            Ash.Changeset.get_attribute(changeset, :expense)

        if amount do
          Ash.Changeset.force_change_attribute(changeset, :unreconciled_amount, amount)
        else
          changeset
        end
      end
```

(c)moduledoc 末行「凭证关联后续另做」改为「凭证对账见 `BankReconciliation`」。

- [ ] **Step 5: 生成并修迁移**

Run: `cd backend && mix ash_postgres.generate_migrations bank_txn_reconcile_columns`
生成的迁移 `up` 里 alter 块之后追加存量回填(新列默认 0,存量行未对账金额需等于流水金额):

```elixir
    execute("UPDATE acc_bank_transaction SET unreconciled_amount = COALESCE(income, expense)")
```

Run: `mix ecto.migrate`
Expected: 迁移成功

- [ ] **Step 6: 跑测试通过**

Run: `mix test apps/synie_core/test/synie_core/acc/bank_transaction_test.exs`
Expected: 全绿

- [ ] **Step 7: format + 提交**

```bash
cd backend && mix format && cd ..
git add -A && git commit -m "feat: 银行流水对账派生列(已对账/未对账/状态)"
```

---

### Task 2: 后端——对账资源 BankReconciliation + 严格校验 + 注册

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/acc/reconcile.ex`(共享助手)
- Create: `backend/apps/synie_core/lib/synie_core/acc/bank_reconciliation.ex`(资源 + 两个 change 模块)
- Modify: `backend/apps/synie_core/lib/synie_core/acc/bank_transaction.ex`(has_many + refresh 内部动作 + permission_actions 加 reconcile)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(domain 注册)
- Modify: `backend/apps/synie_web/lib/synie_web/grid_meta.ex`(白名单)
- Create: `backend/apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`
- Create: 迁移(生成)`*_bank_reconciliation.exs`

**Interfaces:**
- Consumes: Task 1 的三个派生列与 `ReconcileStatus`。
- Produces:
  - `SynieCore.Acc.Reconcile`:`txn_amount/1`、`side/1`(→`:debit|:credit`)、`lock_transaction/1`、`ledger_account_id/1`(→`{:ok, id} | {:error, msg}`)、`reconciled_total/2`、`journal_line_total/3`、`journal_used/4`、`refresh_transaction!/2`。
  - `SynieCore.Acc.BankReconciliation` 资源:actions `create`(accept `bank_transaction_id/journal_id/amount`)、`read`、`destroy`;identity `[:bank_transaction_id, :journal_id]`;graphql type `:acc_bank_reconciliation`;GraphQL `accBankReconciliations` 列表、`createAccBankReconciliation`/`destroyAccBankReconciliation`。
  - `BankTransaction` 权限码新增 `reconcile`;内部动作 `:refresh_reconcile`(authorize?: false 专用)。

- [ ] **Step 1: 写失败测试**——新建 `backend/apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`:

```elixir
defmodule SynieCore.Acc.BankReconciliationTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.{BankAccount, BankReconciliation, BankTransaction, GlJournal, GlJournalLine}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.{Account, Currency}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    bank_acct = account!(company, %{code: "1002", name: "银行存款", direction: :debit})
    sales = account!(company, %{code: "6001", name: "主营业务收入", direction: :credit})
    bank_account = bank_account!(company, bank_acct)
    %{company: company, bank_acct: bank_acct, sales: sales, bank_account: bank_account}
  end

  defp account!(company, attrs) do
    Account
    |> Ash.Changeset.for_create(:create, Map.merge(%{company_id: company.id}, attrs))
    |> Ash.create!(authorize?: false)
  end

  defp currency! do
    i = System.unique_integer([:positive])
    code = <<?A + rem(div(i, 676), 26), ?A + rem(div(i, 26), 26), ?A + rem(i, 26)>>

    Currency
    |> Ash.Changeset.for_create(:create, %{name: "测试币", iso_code: code})
    |> Ash.create!(authorize?: false)
  end

  # ledger_account 传 nil 即「未绑定科目」的账户
  defp bank_account!(company, ledger_account, attrs \\ %{}) do
    BankAccount
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          alias: "基本户#{System.unique_integer([:positive])}",
          bank_name: "招商银行",
          holder_name: "测试公司",
          account_no: "#{System.unique_integer([:positive])}",
          company_id: company.id,
          currency_id: currency!().id,
          account_id: ledger_account && ledger_account.id
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp txn!(company, bank_account, attrs) do
    BankTransaction
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          occurred_at: ~U[2026-07-01 10:30:00Z],
          company_id: company.id,
          bank_account_id: bank_account.id
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  # 已审核凭证:lines 形如 [{科目, 借, 贷}, ...](字符串金额)
  defp audited_journal!(company, lines) do
    journal = draft_journal!(company, lines)

    journal
    |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-14]})
    |> Ash.update!(authorize?: false)
  end

  defp draft_journal!(company, lines) do
    journal =
      GlJournal
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        voucher_no: "记-#{System.unique_integer([:positive])}",
        date: ~D[2026-07-14],
        posting_date: ~D[2026-07-14]
      })
      |> Ash.create!(authorize?: false)

    for {{account, debit, credit}, idx} <- Enum.with_index(lines, 1) do
      GlJournalLine
      |> Ash.Changeset.for_create(:create, %{
        journal_id: journal.id,
        idx: idx,
        account_id: account.id,
        debit: Decimal.new(debit),
        credit: Decimal.new(credit)
      })
      |> Ash.create!(authorize?: false)
    end

    journal
  end

  defp link!(txn, journal, amount, opts \\ [authorize?: false]) do
    BankReconciliation
    |> Ash.Changeset.for_create(
      :create,
      %{bank_transaction_id: txn.id, journal_id: journal.id, amount: Decimal.new(amount)},
      opts
    )
    |> Ash.create!()
  end

  defp reload_txn(txn), do: Ash.get!(BankTransaction, txn.id, authorize?: false)

  defp actor(company, permissions) do
    %Actor{
      user_id: Ash.UUID.generate(),
      permissions: MapSet.new(permissions),
      company_ids: [company.id]
    }
  end

  test "关联刷新派生列:部分对账→已对账", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("1000")})
    j1 = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
    j2 = audited_journal!(co, [{b, "600", "0"}, {s, "0", "600"}])

    link!(txn, j1, "400")
    loaded = reload_txn(txn)
    assert Decimal.equal?(loaded.reconciled_amount, Decimal.new("400"))
    assert Decimal.equal?(loaded.unreconciled_amount, Decimal.new("600"))
    assert loaded.reconcile_status == :partial

    link!(txn, j2, "600")
    assert reload_txn(txn).reconcile_status == :reconciled
  end

  test "解除对账后派生列回滚", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("1000")})
    j = audited_journal!(co, [{b, "1000", "0"}, {s, "0", "1000"}])

    link = link!(txn, j, "1000")
    assert reload_txn(txn).reconcile_status == :reconciled

    Ash.destroy!(link, authorize?: false)
    loaded = reload_txn(txn)
    assert Decimal.equal?(loaded.reconciled_amount, 0)
    assert loaded.reconcile_status == :unreconciled
  end

  test "草稿凭证不可对账", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("100")})
    draft = draft_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])

    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, draft, "100") end
    assert Exception.message(err) =~ "已审核"
  end

  test "跨公司凭证被拒", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    other = company!()
    other_b = account!(other, %{code: "1002", name: "银行存款", direction: :debit})
    other_s = account!(other, %{code: "6001", name: "收入", direction: :credit})
    txn = txn!(co, ba, %{income: Decimal.new("100")})
    _ = {b, s}
    j = audited_journal!(other, [{other_b, "100", "0"}, {other_s, "0", "100"}])

    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "100") end
    assert Exception.message(err) =~ "同一公司"
  end

  test "未绑定科目的账户不可对账", %{company: co, bank_acct: b, sales: s} do
    unbound = bank_account!(co, nil)
    txn = txn!(co, unbound, %{income: Decimal.new("100")})
    j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])

    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "100") end
    assert Exception.message(err) =~ "绑定"
  end

  test "方向不匹配被拒:支出流水要求银行科目贷方行", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{expense: Decimal.new("100")})
    j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])

    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "100") end
    assert Exception.message(err) =~ "方向"
  end

  test "超流水未对账金额被拒", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("1000")})
    j1 = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
    j2 = audited_journal!(co, [{b, "700", "0"}, {s, "0", "700"}])

    link!(txn, j1, "400")
    err = assert_raise Ash.Error.Invalid, fn -> link!(txn, j2, "700") end
    assert Exception.message(err) =~ "未对账金额"
  end

  test "超凭证侧额度被拒", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn1 = txn!(co, ba, %{income: Decimal.new("300")})
    txn2 = txn!(co, ba, %{income: Decimal.new("300")})
    j = audited_journal!(co, [{b, "500", "0"}, {s, "0", "500"}])

    link!(txn1, j, "300")
    err = assert_raise Ash.Error.Invalid, fn -> link!(txn2, j, "300") end
    assert Exception.message(err) =~ "凭证"
  end

  test "内部转账凭证:两个银行科目额度独立", %{company: co, bank_acct: b, sales: _s} do
    b2 = account!(co, %{code: "1002.2", name: "银行存款二", direction: :debit})
    ba2 = bank_account!(co, b2)
    ba1 = bank_account!(co, b)
    txn_in = txn!(co, ba1, %{income: Decimal.new("500")})
    txn_out = txn!(co, ba2, %{expense: Decimal.new("500")})
    j = audited_journal!(co, [{b, "500", "0"}, {b2, "0", "500"}])

    link!(txn_in, j, "500")
    link!(txn_out, j, "500")
    assert reload_txn(txn_in).reconcile_status == :reconciled
    assert reload_txn(txn_out).reconcile_status == :reconciled
  end

  test "同一对流水-凭证唯一", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("1000")})
    j = audited_journal!(co, [{b, "1000", "0"}, {s, "0", "1000"}])

    link!(txn, j, "300")
    assert_raise Ash.Error.Invalid, fn -> link!(txn, j, "200") end
  end

  test "权限:reconcile 码可建可删,仅 read 不可", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
    txn = txn!(co, ba, %{income: Decimal.new("100")})
    j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])

    writer = actor(co, ["acc.bank_transaction:read", "acc.bank_transaction:reconcile"])
    reader = actor(co, ["acc.bank_transaction:read"])

    link = link!(txn, j, "60", actor: writer)

    assert_raise Ash.Error.Forbidden, fn ->
      link!(txn, audited_journal!(co, [{b, "40", "0"}, {s, "0", "40"}]), "40", actor: reader)
    end

    assert_raise Ash.Error.Forbidden, fn -> Ash.destroy!(link, actor: reader) end
    assert :ok = Ash.destroy!(link, actor: writer)
  end
end
```

- [ ] **Step 2: 跑测试确认失败**(模块不存在)

Run: `cd backend && mix test apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`
Expected: 编译错误 `SynieCore.Acc.BankReconciliation is not available`

- [ ] **Step 3: 新建共享助手** `backend/apps/synie_core/lib/synie_core/acc/reconcile.ex`:

```elixir
defmodule SynieCore.Acc.Reconcile do
  @moduledoc """
  银行流水对账的共享判定/计算助手:方向、额度、锁、派生列刷新。

  额度按「凭证 × 银行科目 × 方向」维度计算:同一凭证借银行A/贷银行B(内部转账)时,
  A 的收入流水与 B 的支出流水各自消耗自己科目方向的行金额,互不挤占。
  所有 lock_* 仅在动作 before_action(事务内)调用才有锁定效果;
  锁序统一「先流水后凭证」,与凭证取消(只锁凭证、不锁流水)之间无环。
  """

  require Ash.Query

  alias SynieCore.Acc.{BankAccount, BankReconciliation, BankTransaction, GlJournalLine}

  @doc "流水金额(收入或支出,恰一项非空)。"
  def txn_amount(txn), do: txn.income || txn.expense

  @doc "流水对应的凭证行方向:收入 → 银行科目借方,支出 → 贷方。"
  def side(txn), do: if(txn.income, do: :debit, else: :credit)

  @doc "事务内 FOR UPDATE 锁流水行(串行化对账增删/流水改删)。"
  def lock_transaction(txn_id) do
    BankTransaction
    |> Ash.Query.filter(id == ^txn_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc "流水所属银行账户绑定的会计科目 id;未绑定即不可对账(严格模式)。"
  def ledger_account_id(txn) do
    case Ash.get(BankAccount, txn.bank_account_id, authorize?: false) do
      {:ok, %{account_id: nil}} -> {:error, "银行账户未绑定会计科目,请先在银行账户上绑定"}
      {:ok, %{account_id: account_id}} -> {:ok, account_id}
      {:error, _} -> {:error, "银行账户不存在"}
    end
  end

  @doc "流水已对账金额合计;opts[:except] 排除指定对账记录 id。"
  def reconciled_total(txn_id, opts \\ []) do
    BankReconciliation
    |> Ash.Query.filter(bank_transaction_id == ^txn_id)
    |> except(opts[:except])
    |> Ash.read!(authorize?: false)
    |> sum_amounts()
  end

  @doc "凭证在指定银行科目、指定方向上的分录行金额合计(对此方向流水的对账总上限)。"
  def journal_line_total(journal_id, ledger_account_id, side) do
    query =
      GlJournalLine
      |> Ash.Query.filter(journal_id == ^journal_id and account_id == ^ledger_account_id)

    query =
      case side do
        :debit -> Ash.Query.filter(query, debit > 0)
        :credit -> Ash.Query.filter(query, credit > 0)
      end

    query
    |> Ash.read!(authorize?: false)
    |> Enum.map(&if(side == :debit, do: &1.debit, else: &1.credit))
    |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
  end

  @doc """
  凭证已对账给「绑定同一科目、同方向」流水的金额合计;opts[:except] 排除指定记录。
  单凭证对账记录量小,直接加载后在内存筛跨表条件,不拼跨表查询。
  """
  def journal_used(journal_id, ledger_account_id, side, opts \\ []) do
    BankReconciliation
    |> Ash.Query.filter(journal_id == ^journal_id)
    |> except(opts[:except])
    |> Ash.Query.load(bank_transaction: [:bank_account])
    |> Ash.read!(authorize?: false)
    |> Enum.filter(fn rec ->
      rec.bank_transaction.bank_account.account_id == ledger_account_id and
        side(rec.bank_transaction) == side
    end)
    |> sum_amounts()
  end

  @doc """
  刷新流水派生列(已对账/未对账/状态)。仅在对账记录增删动作的 after_action
  (事务内、流水行已在 before_action 锁定)调用;actor 透传给审计日志。
  """
  def refresh_transaction!(txn_id, actor) do
    {:ok, txn} = lock_transaction(txn_id)
    total = reconciled_total(txn_id)
    amount = txn_amount(txn)

    status =
      cond do
        Decimal.compare(total, 0) == :eq -> :unreconciled
        Decimal.compare(total, amount) == :lt -> :partial
        true -> :reconciled
      end

    txn
    |> Ash.Changeset.for_update(
      :refresh_reconcile,
      %{
        reconciled_amount: total,
        unreconciled_amount: Decimal.sub(amount, total),
        reconcile_status: status
      },
      actor: actor,
      authorize?: false
    )
    |> Ash.update!()
  end

  defp except(query, nil), do: query
  defp except(query, id), do: Ash.Query.filter(query, id != ^id)

  defp sum_amounts(records) do
    records |> Enum.map(& &1.amount) |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
  end
end
```

- [ ] **Step 4: 新建资源文件** `backend/apps/synie_core/lib/synie_core/acc/bank_reconciliation.ex`(两个 change 模块 + 资源同文件,照 SingleSidedAmount 先例):

```elixir
defmodule SynieCore.Acc.BankReconciliation.ValidateReconcile do
  @moduledoc """
  对账关联创建:构建期回填 company_id(CompanyAccessible 声明顺序依赖)并确认流水存在;
  before_action(事务内)FOR UPDATE 依次锁流水、凭证后权威复检——凭证已审核、同公司、
  银行账户已绑科目、凭证含该科目方向行、双侧额度不超;after_action 刷新流水派生列。
  """

  use Ash.Resource.Change

  alias SynieCore.Acc.{GlJournal, Reconcile}

  @impl true
  def change(changeset, _opts, context) do
    txn_id = Ash.Changeset.get_attribute(changeset, :bank_transaction_id)

    changeset =
      case read_txn(txn_id) do
        {:ok, txn} when txn != nil ->
          Ash.Changeset.force_change_attribute(changeset, :company_id, txn.company_id)

        _ ->
          Ash.Changeset.add_error(changeset,
            field: :bank_transaction_id,
            message: "银行流水不存在"
          )
      end

    changeset
    |> Ash.Changeset.before_action(&authoritative_check/1)
    |> Ash.Changeset.after_action(fn _cs, record ->
      Reconcile.refresh_transaction!(record.bank_transaction_id, context.actor)
      {:ok, record}
    end)
  end

  defp read_txn(nil), do: {:ok, nil}
  defp read_txn(id), do: Ash.get(SynieCore.Acc.BankTransaction, id, authorize?: false)

  defp authoritative_check(cs) do
    txn_id = Ash.Changeset.get_attribute(cs, :bank_transaction_id)
    journal_id = Ash.Changeset.get_attribute(cs, :journal_id)
    amount = Ash.Changeset.get_attribute(cs, :amount)

    with {:ok, txn} when txn != nil <- Reconcile.lock_transaction(txn_id),
         {:ok, journal} when journal != nil <- GlJournal.lock_journal(journal_id),
         :ok <- run_checks(txn, journal, amount) do
      cs
    else
      {:error, field, message} -> Ash.Changeset.add_error(cs, field: field, message: message)
      _ -> Ash.Changeset.add_error(cs, message: "银行流水或凭证不存在")
    end
  end

  defp run_checks(txn, journal, amount) do
    with :ok <- check_amount(amount),
         :ok <- check_journal(txn, journal),
         {:ok, ledger_account_id} <- check_ledger(txn) do
      check_capacity(txn, journal, ledger_account_id, amount)
    end
  end

  defp check_amount(amount) do
    if amount && Decimal.compare(amount, 0) == :gt,
      do: :ok,
      else: {:error, :amount, "对账金额必须大于零"}
  end

  defp check_journal(txn, journal) do
    cond do
      journal.company_id != txn.company_id -> {:error, :journal_id, "凭证与流水必须属于同一公司"}
      journal.status != :audited -> {:error, :journal_id, "仅已审核凭证可用于对账"}
      true -> :ok
    end
  end

  defp check_ledger(txn) do
    case Reconcile.ledger_account_id(txn) do
      {:ok, id} -> {:ok, id}
      {:error, msg} -> {:error, :bank_transaction_id, msg}
    end
  end

  defp check_capacity(txn, journal, ledger_account_id, amount) do
    side = Reconcile.side(txn)
    line_total = Reconcile.journal_line_total(journal.id, ledger_account_id, side)
    txn_remaining = Decimal.sub(Reconcile.txn_amount(txn), Reconcile.reconciled_total(txn.id))

    journal_remaining =
      Decimal.sub(line_total, Reconcile.journal_used(journal.id, ledger_account_id, side))

    side_label = if(side == :debit, do: "借方", else: "贷方")

    cond do
      Decimal.compare(line_total, 0) == :eq ->
        {:error, :journal_id, "凭证不含该银行科目的#{side_label}分录行,方向不匹配"}

      Decimal.compare(amount, txn_remaining) == :gt ->
        {:error, :amount, "超过流水未对账金额(剩余 #{txn_remaining})"}

      Decimal.compare(amount, journal_remaining) == :gt ->
        {:error, :amount, "超过凭证可对账余额(该科目#{side_label}剩余 #{journal_remaining})"}

      true ->
        :ok
    end
  end
end

defmodule SynieCore.Acc.BankReconciliation.RefreshOnDestroy do
  @moduledoc "解除对账:事务内先锁流水(与并发对账/流水改删串行化),删除后刷新派生列。"

  use Ash.Resource.Change

  alias SynieCore.Acc.Reconcile

  @impl true
  def change(changeset, _opts, context) do
    changeset
    |> Ash.Changeset.before_action(fn cs ->
      case Reconcile.lock_transaction(cs.data.bank_transaction_id) do
        {:ok, txn} when txn != nil -> cs
        _ -> Ash.Changeset.add_error(cs, message: "银行流水不存在")
      end
    end)
    |> Ash.Changeset.after_action(fn _cs, record ->
      Reconcile.refresh_transaction!(record.bank_transaction_id, context.actor)
      {:ok, record}
    end)
  end
end

defmodule SynieCore.Acc.BankReconciliation do
  @moduledoc """
  银行流水对账记录,对应 `acc_bank_reconciliation` 表:流水 ↔ 已审核凭证的 m-n 金额勾稽。

  同一对流水-凭证仅一条记录(改金额=解除后重建,无 update 动作);
  company_id 冗余自流水复用公司数据权限;严格校验见 ValidateReconcile。
  纯关联资源无独立权限点:读跟随 acc.bank_transaction:read,增删跟随 :reconcile。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "acc_bank_reconciliation"
    repo SynieCore.Repo

    references do
      # 删除保护走动作校验(有对账的流水禁删、凭证禁取消),DB restrict 兜底防孤儿
      reference :bank_transaction, on_delete: :restrict
      reference :journal, on_delete: :restrict
    end

    check_constraints do
      check_constraint :amount, "positive_amount",
        check: "amount > 0",
        message: "对账金额必须大于零"
    end
  end

  graphql do
    type :acc_bank_reconciliation
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action(:read) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy action([:create, :destroy]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "reconcile"}
    end

    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  # 复用流水权限码;actions 为空不进权限目录(同 GlJournalLine 跟随 acc.gl_journal 的先例)
  def permission_prefix, do: "acc.bank_transaction"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    create :create do
      accept [:bank_transaction_id, :journal_id, :amount]

      # 顺序敏感:先回填 company_id,再做公司授权校验(同 GlJournalLine.SyncJournal 先例)
      change {SynieCore.Acc.BankReconciliation.ValidateReconcile, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Acc.BankReconciliation.RefreshOnDestroy, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :amount, :decimal do
      allow_nil? false
      public? true
      description "对账金额"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :bank_transaction, SynieCore.Acc.BankTransaction do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "银行流水"
    end

    belongs_to :journal, SynieCore.Acc.GlJournal do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "凭证"
    end
  end

  identities do
    identity :unique_txn_journal, [:bank_transaction_id, :journal_id]
  end
end
```

- [ ] **Step 5: 改 `bank_transaction.ex`**——三处:

(a)`permission_actions` 行改为(注释同步):

```elixir
  # import = 流水导入整链路(导入记录/导入行资源借同一码,见 BankImport)
  # reconcile = 对账整链路(对账记录资源借同一码,见 BankReconciliation)
  def permission_actions, do: ~w(create read update delete import reconcile)
```

(b)`relationships do` 内加:

```elixir
    has_many :reconciliations, SynieCore.Acc.BankReconciliation do
      destination_attribute :bank_transaction_id
      public? true
      description "对账记录"
    end
```

(c)`actions do` 内、`destroy :destroy` 之前加内部动作:

```elixir
    update :refresh_reconcile do
      # 内部动作:对账记录增删后刷新派生列(Reconcile.refresh_transaction!,authorize?: false 调用)
      accept []
      require_atomic? false

      argument :reconciled_amount, :decimal, allow_nil?: false
      argument :unreconciled_amount, :decimal, allow_nil?: false
      argument :reconcile_status, SynieCore.Acc.ReconcileStatus, allow_nil?: false

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(
          :reconciled_amount,
          Ash.Changeset.get_argument(changeset, :reconciled_amount)
        )
        |> Ash.Changeset.force_change_attribute(
          :unreconciled_amount,
          Ash.Changeset.get_argument(changeset, :unreconciled_amount)
        )
        |> Ash.Changeset.force_change_attribute(
          :reconcile_status,
          Ash.Changeset.get_argument(changeset, :reconcile_status)
        )
      end
    end
```

- [ ] **Step 6: domain 注册** `backend/apps/synie_core/lib/synie_core.ex`:
  - queries 块 `acc_vat_invoices` 行后加:`list SynieCore.Acc.BankReconciliation, :acc_bank_reconciliations, :read, paginate_with: :offset`
  - mutations 块 vat_invoice 组后加:

```elixir
      create SynieCore.Acc.BankReconciliation, :create_acc_bank_reconciliation, :create
      destroy SynieCore.Acc.BankReconciliation, :destroy_acc_bank_reconciliation, :destroy
```

  - resources 块 `resource SynieCore.Acc.VatInvoice` 后加:`resource SynieCore.Acc.BankReconciliation`

- [ ] **Step 7: GridMeta 白名单** `backend/apps/synie_web/lib/synie_web/grid_meta.ex` 的 `@resources` 加一行:

```elixir
    "accBankReconciliations" => SynieCore.Acc.BankReconciliation,
```

- [ ] **Step 8: 生成迁移并执行**

Run: `cd backend && mix ash_postgres.generate_migrations bank_reconciliation && mix ecto.migrate`
Expected: 新表 `acc_bank_reconciliation`(含唯一索引与 check 约束)创建成功

- [ ] **Step 9: 跑测试通过**

Run: `mix test apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`
Expected: 全绿(12 个测试)

- [ ] **Step 10: format + 全量回归 + 提交**

```bash
cd backend && mix format && mix test && cd ..
git add -A && git commit -m "feat: 银行流水对账记录资源(m-n 严格校验+派生列刷新)"
```

---

### Task 3: 后端——反向约束(凭证取消/流水改删的对账保护)

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/acc/gl_journal.ex`(cancel 动作)
- Modify: `backend/apps/synie_core/lib/synie_core/acc/bank_transaction.ex`(新 change 模块 + update/destroy 挂载)
- Modify: `backend/apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`(追加测试)

**Interfaces:**
- Consumes: Task 2 的 `Reconcile.lock_transaction/1`、`reconciled_total/2`、`BankReconciliation`。
- Produces: `SynieCore.Acc.BankTransaction.ReconcileGuard`(update/destroy 共用 change)。

- [ ] **Step 1: 写失败测试**——`bank_reconciliation_test.exs` 末尾加:

```elixir
  describe "反向约束" do
    test "已对账凭证不可取消,解除后可以", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("100")})
      j = audited_journal!(co, [{b, "100", "0"}, {s, "0", "100"}])
      link = link!(txn, j, "100")

      err =
        assert_raise Ash.Error.Invalid, fn ->
          j |> Ash.Changeset.for_update(:cancel, %{}) |> Ash.update!(authorize?: false)
        end

      assert Exception.message(err) =~ "解除对账"

      Ash.destroy!(link, authorize?: false)

      cancelled = j |> Ash.Changeset.for_update(:cancel, %{}) |> Ash.update!(authorize?: false)
      assert cancelled.status == :cancelled
    end

    test "已对账流水禁删、金额不得低于已对账、禁换边", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("1000")})
      j = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
      link!(txn, j, "400")
      txn = reload_txn(txn)

      assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(txn, authorize?: false) end

      err =
        assert_raise Ash.Error.Invalid, fn ->
          txn
          |> Ash.Changeset.for_update(:update, %{income: Decimal.new("300")})
          |> Ash.update!(authorize?: false)
        end

      assert Exception.message(err) =~ "已对账金额"

      assert_raise Ash.Error.Invalid, fn ->
        txn
        |> Ash.Changeset.for_update(:update, %{income: nil, expense: Decimal.new("1000")})
        |> Ash.update!(authorize?: false)
      end
    end

    test "上调金额后派生列同步刷新", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("400")})
      j = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
      link!(txn, j, "400")
      assert reload_txn(txn).reconcile_status == :reconciled

      updated =
        reload_txn(txn)
        |> Ash.Changeset.for_update(:update, %{income: Decimal.new("1000")})
        |> Ash.update!(authorize?: false)

      assert updated.reconcile_status == :partial
      assert Decimal.equal?(updated.unreconciled_amount, Decimal.new("600"))
    end

    test "无对账的流水删除/换边不受影响", %{company: co, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("100")})

      swapped =
        txn
        |> Ash.Changeset.for_update(:update, %{income: nil, expense: Decimal.new("80")})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(swapped.unreconciled_amount, Decimal.new("80"))
      assert :ok = Ash.destroy!(swapped, authorize?: false)
    end
  end
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`
Expected: 「反向约束」4 个测试 FAIL(取消/删除未被拒)

- [ ] **Step 3: 改 `gl_journal.ex` cancel**——把 cancel 动作 before_action 里 `{:ok, %{status: :audited}} -> cs` 分支改为:

```elixir
            {:ok, %{status: :audited}} ->
              # 有银行对账关联的凭证不可取消(对账以「已审核」为前提;先解除再取消)
              used? =
                SynieCore.Acc.BankReconciliation
                |> Ash.Query.filter(journal_id == ^cs.data.id)
                |> Ash.exists?(authorize?: false)

              if used? do
                Ash.Changeset.add_error(cs, message: "凭证已用于银行对账,请先解除对账")
              else
                cs
              end
```

(文件已有 `require Ash.Query`。)

- [ ] **Step 4: 加 ReconcileGuard**——`bank_transaction.ex` 文件顶部(SingleSidedAmount 模块之后、主模块之前)加:

```elixir
defmodule SynieCore.Acc.BankTransaction.ReconcileGuard do
  @moduledoc """
  已有对账关联的流水约束:禁止删除;修改时禁止收支换边、金额不得低于已对账金额;
  金额变化时同步刷新未对账金额与状态。before_action 事务内 FOR UPDATE 锁自身行,
  与对账增删(同样先锁流水)串行化。
  """

  use Ash.Resource.Change

  alias SynieCore.Acc.Reconcile

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      {:ok, txn} = Reconcile.lock_transaction(cs.data.id)
      total = Reconcile.reconciled_total(txn.id)
      has_links? = Decimal.compare(total, 0) == :gt

      if cs.action.name == :destroy do
        if has_links? do
          Ash.Changeset.add_error(cs, message: "流水已有对账记录,请先解除对账后再删除")
        else
          cs
        end
      else
        check_update(cs, txn, total, has_links?)
      end
    end)
  end

  defp check_update(cs, txn, total, has_links?) do
    income = Ash.Changeset.get_attribute(cs, :income)
    expense = Ash.Changeset.get_attribute(cs, :expense)
    amount = income || expense

    cond do
      has_links? and (txn.income != nil) != (income != nil) ->
        Ash.Changeset.add_error(cs, message: "流水已有对账记录,不允许收支换边")

      amount != nil and Decimal.compare(amount, total) == :lt ->
        Ash.Changeset.add_error(cs,
          field: (income && :income) || :expense,
          message: "金额不得低于已对账金额(已对账 #{total})"
        )

      amount != nil ->
        refresh_derived(cs, amount, total)

      true ->
        cs
    end
  end

  # 金额可能被修改:按锁内权威合计重算派生列(与对账增删的刷新同一套口径)
  defp refresh_derived(cs, amount, total) do
    status =
      cond do
        Decimal.compare(total, 0) == :eq -> :unreconciled
        Decimal.compare(total, amount) == :lt -> :partial
        true -> :reconciled
      end

    cs
    |> Ash.Changeset.force_change_attribute(:unreconciled_amount, Decimal.sub(amount, total))
    |> Ash.Changeset.force_change_attribute(:reconcile_status, status)
  end
end
```

- [ ] **Step 5: 挂载**——`bank_transaction.ex` 的 `update :update` 动作在两个 validate 之后加 `change {SynieCore.Acc.BankTransaction.ReconcileGuard, []}`;`destroy :destroy` 动作体内加同一行。

- [ ] **Step 6: 跑测试通过**

Run: `mix test apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs apps/synie_core/test/synie_core/acc/bank_transaction_test.exs apps/synie_core/test/synie_core/acc/gl_journal_test.exs`
Expected: 全绿

- [ ] **Step 7: format + 提交**

```bash
cd backend && mix format && cd ..
git add -A && git commit -m "feat: 对账反向约束——凭证取消/流水改删保护"
```

---

### Task 4: 后端——quick_create 组合动作 + remaining 剩余额度查询

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/acc/bank_reconciliation.ex`(QuickCreate change 模块 + 两个动作 + policy)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(注册 quickCreate mutation + remaining query)
- Modify: `backend/apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`(追加测试)

**Interfaces:**
- Consumes: Task 2 全部;GlJournal `:create/:audit`、GlJournalLine `:create`(带 actor 正常鉴权,缺权限整体回滚)。
- Produces: GraphQL `quickCreateAccBankReconciliation(input: {bankTransactionId, counterAccountId, amount, summary, postingDate})`;`accBankReconciliationRemaining(bankTransactionId: ID!, journalId: ID!): Decimal(串)`。

- [ ] **Step 1: 写失败测试**——`bank_reconciliation_test.exs` 末尾加(`alias` 行补 `GlEntry`:把顶部 alias 改为 `alias SynieCore.Acc.{BankAccount, BankReconciliation, BankTransaction, GlEntry, GlJournal, GlJournalLine}`):

```elixir
  describe "quick_create 快速凭证对账" do
    defp numbering_rule! do
      SynieCore.Numbering.Rule
      |> Ash.Changeset.for_create(
        :create,
        %{
          resource: "acc.gl_journal",
          name: "记账凭证",
          segments: [%{"type" => "text", "value" => "记"}, %{"type" => "seq", "padding" => 4}]
        },
        authorize?: false
      )
      |> Ash.create!()
    end

    defp quick!(txn, counter_account, amount, opts) do
      BankReconciliation
      |> Ash.Changeset.for_create(
        :quick_create,
        %{
          bank_transaction_id: txn.id,
          counter_account_id: counter_account.id,
          amount: Decimal.new(amount),
          summary: "货款",
          posting_date: ~D[2026-07-14]
        },
        opts
      )
      |> Ash.create!()
    end

    defp full_actor(co),
      do: actor(co, ["acc.bank_transaction:*", "acc.gl_journal:*"])

    test "成功:凭证自动创建+审核+过账+关联", %{company: co, sales: s, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{income: Decimal.new("1000")})

      rec = quick!(txn, s, "1000", actor: full_actor(co))

      journal = Ash.get!(GlJournal, rec.journal_id, authorize?: false)
      assert journal.status == :audited
      assert journal.remarks == "货款"

      entries =
        GlEntry
        |> Ash.Query.filter(voucher_id == ^journal.id)
        |> Ash.read!(authorize?: false)

      assert length(entries) == 2
      assert reload_txn(txn).reconcile_status == :reconciled
    end

    test "支出流水方向反转:银行科目在贷方", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{expense: Decimal.new("200")})

      rec = quick!(txn, s, "200", actor: full_actor(co))

      lines =
        GlJournalLine
        |> Ash.Query.filter(journal_id == ^rec.journal_id)
        |> Ash.read!(authorize?: false)

      bank_line = Enum.find(lines, &(&1.account_id == b.id))
      assert Decimal.compare(bank_line.credit, 0) == :gt
    end

    test "缺凭证权限整体回滚", %{company: co, sales: s, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{income: Decimal.new("100")})
      bank_only = actor(co, ["acc.bank_transaction:*"])

      try do
        quick!(txn, s, "100", actor: bank_only)
        flunk("应当因缺少凭证权限而失败")
      rescue
        e in [Ash.Error.Forbidden, Ash.Error.Invalid, Ash.Error.Unknown] -> {:ok, e}
      end

      assert [] = Ash.read!(GlJournal, authorize?: false)
      assert [] = Ash.read!(BankReconciliation, authorize?: false)
      assert reload_txn(txn).reconcile_status == :unreconciled
    end

    test "汇总科目做对方科目整体回滚", %{company: co, sales: _s, bank_account: ba} do
      numbering_rule!()
      group = account!(co, %{code: "9001", name: "汇总", direction: :credit, is_group: true})
      txn = txn!(co, ba, %{income: Decimal.new("100")})

      assert_raise Ash.Error.Invalid, fn ->
        quick!(txn, group, "100", actor: full_actor(co))
      end

      assert [] = Ash.read!(GlJournal, authorize?: false)
    end

    test "超流水未对账余额被拒", %{company: co, sales: s, bank_account: ba} do
      numbering_rule!()
      txn = txn!(co, ba, %{income: Decimal.new("100")})

      err =
        assert_raise Ash.Error.Invalid, fn ->
          quick!(txn, s, "200", actor: full_actor(co))
        end

      assert Exception.message(err) =~ "未对账金额"
    end
  end

  describe "remaining 剩余额度查询" do
    test "取流水/凭证双侧剩余的较小值", %{company: co, bank_acct: b, sales: s, bank_account: ba} do
      txn = txn!(co, ba, %{income: Decimal.new("1000")})
      j = audited_journal!(co, [{b, "400", "0"}, {s, "0", "400"}])
      reader = actor(co, ["acc.bank_transaction:*", "acc.gl_journal:read"])

      remaining =
        BankReconciliation
        |> Ash.ActionInput.for_action(:remaining, %{
          bank_transaction_id: txn.id,
          journal_id: j.id
        })
        |> Ash.run_action!(actor: reader)

      assert Decimal.equal?(remaining, Decimal.new("400"))

      link!(txn, j, "150")

      remaining2 =
        BankReconciliation
        |> Ash.ActionInput.for_action(:remaining, %{
          bank_transaction_id: txn.id,
          journal_id: j.id
        })
        |> Ash.run_action!(actor: reader)

      assert Decimal.equal?(remaining2, Decimal.new("250"))
    end
  end
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`
Expected: quick_create/remaining 相关 FAIL(动作不存在)

- [ ] **Step 3: 加 QuickCreate change 模块**——`bank_reconciliation.ex` 文件里 `RefreshOnDestroy` 模块之后加:

```elixir
defmodule SynieCore.Acc.BankReconciliation.QuickCreate do
  @moduledoc """
  快速新增凭证并对账:事务内锁流水 → 以 actor 权限创建凭证草稿(编号走 AutoNumber)
  与两行分录(银行科目方向行 + 对方科目行)→ 走凭证 audit 过账 → 回填 journal_id,
  由本 create 落对账记录,after_action 刷新流水派生列。任一步失败整体回滚。
  凭证侧动作带 actor 正常鉴权:缺 acc.gl_journal 的 create/audit 权限即失败回滚。
  凭证行由本模块按流水方向构造,方向天然匹配;金额上限(≤流水未对账余额)在锁内校验。
  """

  use Ash.Resource.Change

  alias SynieCore.Acc.{GlJournal, GlJournalLine, Reconcile}

  @impl true
  def change(changeset, _opts, context) do
    txn_id = Ash.Changeset.get_argument(changeset, :bank_transaction_id)

    changeset =
      case Ash.get(SynieCore.Acc.BankTransaction, txn_id, authorize?: false) do
        {:ok, txn} ->
          changeset
          |> Ash.Changeset.force_change_attribute(:bank_transaction_id, txn.id)
          |> Ash.Changeset.force_change_attribute(:company_id, txn.company_id)
          |> Ash.Changeset.force_change_attribute(
            :amount,
            Ash.Changeset.get_argument(changeset, :amount)
          )

        {:error, _} ->
          Ash.Changeset.add_error(changeset,
            field: :bank_transaction_id,
            message: "银行流水不存在"
          )
      end

    changeset
    |> Ash.Changeset.before_action(fn cs -> build_and_audit(cs, context.actor) end)
    |> Ash.Changeset.after_action(fn _cs, record ->
      Reconcile.refresh_transaction!(record.bank_transaction_id, context.actor)
      {:ok, record}
    end)
  end

  defp build_and_audit(cs, actor) do
    txn_id = Ash.Changeset.get_attribute(cs, :bank_transaction_id)
    amount = Ash.Changeset.get_attribute(cs, :amount)
    counter_account_id = Ash.Changeset.get_argument(cs, :counter_account_id)
    posting_date = Ash.Changeset.get_argument(cs, :posting_date)
    summary = Ash.Changeset.get_argument(cs, :summary)

    with {:ok, txn} when txn != nil <- Reconcile.lock_transaction(txn_id),
         {:ok, ledger_account_id} <- Reconcile.ledger_account_id(txn),
         :ok <- check_amount(txn, amount) do
      journal =
        GlJournal
        |> Ash.Changeset.for_create(
          :create,
          %{
            company_id: txn.company_id,
            date: posting_date,
            posting_date: posting_date,
            remarks: summary
          },
          actor: actor
        )
        |> Ash.create!()

      {bank_line, counter_line} = lines_for(txn, amount, ledger_account_id, counter_account_id)

      for {attrs, idx} <- Enum.with_index([bank_line, counter_line], 1) do
        GlJournalLine
        |> Ash.Changeset.for_create(
          :create,
          Map.merge(attrs, %{journal_id: journal.id, idx: idx, remarks: summary}),
          actor: actor
        )
        |> Ash.create!()
      end

      journal
      |> Ash.Changeset.for_update(:audit, %{posting_date: posting_date}, actor: actor)
      |> Ash.update!()

      Ash.Changeset.force_change_attribute(cs, :journal_id, journal.id)
    else
      {:error, field, msg} -> Ash.Changeset.add_error(cs, field: field, message: msg)
      {:error, msg} when is_binary(msg) -> Ash.Changeset.add_error(cs, message: msg)
      _ -> Ash.Changeset.add_error(cs, message: "银行流水不存在")
    end
  end

  defp check_amount(txn, amount) do
    remaining = Decimal.sub(Reconcile.txn_amount(txn), Reconcile.reconciled_total(txn.id))

    cond do
      amount == nil or Decimal.compare(amount, 0) != :gt ->
        {:error, :amount, "对账金额必须大于零"}

      Decimal.compare(amount, remaining) == :gt ->
        {:error, :amount, "超过流水未对账金额(剩余 #{remaining})"}

      true ->
        :ok
    end
  end

  # 收入:借 银行科目 / 贷 对方科目;支出反向
  defp lines_for(txn, amount, ledger_account_id, counter_account_id) do
    zero = Decimal.new(0)

    if txn.income do
      {%{account_id: ledger_account_id, debit: amount, credit: zero},
       %{account_id: counter_account_id, debit: zero, credit: amount}}
    else
      {%{account_id: counter_account_id, debit: amount, credit: zero},
       %{account_id: ledger_account_id, debit: zero, credit: amount}}
    end
  end
end
```

- [ ] **Step 4: 加动作与 policy**——`BankReconciliation` 资源:

(a)policy 里 `policy action([:create, :destroy])` 改为 `policy action([:create, :quick_create, :destroy])`;并在其后加:

```elixir
    policy action(:remaining) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end
```

(b)`actions do` 里 `create :create` 之后加:

```elixir
    create :quick_create do
      description "快速新增凭证并对账:按流水方向预填银行科目行,创建后自动审核并建立关联"
      accept []

      argument :bank_transaction_id, :uuid, allow_nil?: false
      argument :counter_account_id, :uuid, allow_nil?: false
      argument :amount, :decimal, allow_nil?: false
      argument :summary, :string
      argument :posting_date, :date, allow_nil?: false

      change {SynieCore.Acc.BankReconciliation.QuickCreate, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
    end

    action :remaining, :decimal do
      description "给定流水与凭证,返回本组合还可对账的金额(双侧剩余取较小值),供前端预填"

      argument :bank_transaction_id, :uuid, allow_nil?: false
      argument :journal_id, :uuid, allow_nil?: false

      run fn input, context ->
        alias SynieCore.Acc.Reconcile

        # 带 actor 读取:天然套用流水/凭证的 read 策略与公司数据权限(fail-closed)
        with {:ok, txn} <-
               Ash.get(SynieCore.Acc.BankTransaction, input.arguments.bank_transaction_id,
                 actor: context.actor
               ),
             {:ok, journal} <-
               Ash.get(SynieCore.Acc.GlJournal, input.arguments.journal_id,
                 actor: context.actor
               ),
             {:ok, ledger_account_id} <- Reconcile.ledger_account_id(txn) do
          side = Reconcile.side(txn)
          txn_remaining = Decimal.sub(Reconcile.txn_amount(txn), txn.reconciled_amount)

          journal_remaining =
            Decimal.sub(
              Reconcile.journal_line_total(journal.id, ledger_account_id, side),
              Reconcile.journal_used(journal.id, ledger_account_id, side)
            )

          {:ok, Decimal.min(txn_remaining, Decimal.max(journal_remaining, Decimal.new(0)))}
        else
          {:error, msg} when is_binary(msg) -> {:error, msg}
          {:error, _} -> {:error, "银行流水或凭证不存在或无权访问"}
        end
      end
    end
```

- [ ] **Step 5: domain 注册**——`synie_core.ex`:
  - queries 块 `acc_bank_reconciliations` 行后加:

```elixir
      # 对账剩余额度:选中凭证后预填默认对账金额
      action SynieCore.Acc.BankReconciliation, :acc_bank_reconciliation_remaining, :remaining
```

  - mutations 块对账组内加:`create SynieCore.Acc.BankReconciliation, :quick_create_acc_bank_reconciliation, :quick_create`
  - 若 queries 块不支持 `action` 宏(编译报错),把 remaining 注册挪到 mutations 块(照 `init_bas_account_from_template` 先例),前端 Task 8 的调用同步从 query 改为 mutation。

- [ ] **Step 6: 跑测试通过**

Run: `cd backend && mix test apps/synie_core/test/synie_core/acc/bank_reconciliation_test.exs`
Expected: 全绿(约 19 个测试)。若 quick_create 里嵌套 audit 出现事务/锁时序问题(参考 GL spec 的「Ash 时序锁坑」),回退方案:不调 `:audit` 动作,改为在 before_action 内直接 `GL.validate_entries` + `GL.post!` + `force_change` 凭证 status/submitted_at(等效展开,同一事务)。

- [ ] **Step 7: format + 全量回归 + 提交**

```bash
cd backend && mix format && mix test && cd ..
git add -A && git commit -m "feat: 快速新增凭证对账动作与剩余额度查询"
```

---

### Task 5: 前端——组件层扩展(gqlEnum / rowTint / RemoteDialogSelect)

**Files:**
- Modify: `web/app/components/synie-data-grid/query.ts`
- Modify: `web/app/components/synie-data-grid/SynieDataGrid.tsx`
- Modify: `web/app/components/synie-remote-select/RemoteDialogSelect.tsx`
- Modify: `web/app.css`

**Interfaces:**
- Produces:
  - `gqlEnum(token: string)`(query.ts 导出):fixedFilter 里的枚举字面量标记,`toGqlLiteral` 输出裸 token。
  - `SynieDataGridProps.rowTint?: (row: Row) => 'warning' | undefined`:命中行整行浅警示底色。
  - `RemoteDialogSelectProps.gridFilter?: Record<string, unknown>`、`gridColumns?: string[]`:弹窗表格恒定过滤与列白名单。

- [ ] **Step 1: 环境准备**(worktree 首个前端任务)

```bash
[ -e web/node_modules ] || ln -s /home/zyan/code/synie/web/node_modules web/node_modules
cd web && bun run typecheck
```
Expected: 通过(基线干净)

- [ ] **Step 2: query.ts 加 gqlEnum**——`toGqlLiteral` 函数之前加:

```ts
/** GraphQL 枚举字面量标记:fixedFilter 里的枚举值(如凭证状态 AUDITED)不能带引号 */
export class GqlEnum {
  constructor(readonly token: string) {}
}
export const gqlEnum = (token: string) => new GqlEnum(token)
```

`toGqlLiteral` 里 `if (value == null) return 'null'` 之后加一行:

```ts
  if (value instanceof GqlEnum) return value.token
```

- [ ] **Step 3: SynieDataGrid 加 rowTint**——

(a)`SynieDataGridProps` 里 `defaultSort` 之后加:

```ts
  /** 行级着色:返回 'warning' 的行整行浅警示底色(如未完成对账的流水);实现见 app.css 的 :has 规则 */
  rowTint?: (row: Row) => 'warning' | undefined
```

(b)`gridColumns` useMemo 里的 `cell` 回调改为(注意保留占位行分支):

```ts
        cell: (row: Row) => {
          // 懒加载占位行只有 id:首列显示「加载中…」,其余列空
          if (isLoadingRow(row)) return i === 0 ? <span className="text-muted">加载中…</span> : null
          const content =
            overrides[col.name]?.render?.(row[col.name], row) ??
            defaultCell(col, row[col.name], row, overrides[col.name]?.enumColors)
          // DataGrid 无行级 className 入口:首列塞隐藏标记,app.css 用 tr:has() 给整行上色
          const tint = i === 0 ? props.rowTint?.(row) : undefined
          if (!tint) return content
          return (
            <>
              <span hidden data-row-tint={tint} />
              {content}
            </>
          )
        },
```

(c)该 useMemo 依赖数组 `[columns, overrides, filters, treeMode]` 改为 `[columns, overrides, filters, treeMode, props.rowTint]`。

- [ ] **Step 4: app.css 加行高亮规则**——`@layer components` 块内(`.table__cell` 规则后)加:

```css
  /* SynieDataGrid rowTint 行级警示底色:首列隐藏标记 + :has() 上色(DataGrid 无行 className 入口) */
  tr:has([data-row-tint="warning"]) > td {
    background-color: color-mix(in srgb, #f5a524 9%, transparent);
  }
```

- [ ] **Step 5: RemoteDialogSelect 加 gridFilter/gridColumns**——

(a)props 接口改为:

```ts
export interface RemoteDialogSelectProps extends RemoteSelectProps {
  dialogTitle?: string
  /** 弹窗表格的恒定过滤(透传 SynieDataGrid fixedFilter);枚举值用 gqlEnum() 包装 */
  gridFilter?: Record<string, unknown>
  /** 弹窗表格显示列(有序白名单),缺省 meta 全列 */
  gridColumns?: string[]
}
```

(b)弹窗内表格行改为:

```tsx
              <SynieDataGrid
                resource={src.resource}
                columns={props.gridColumns}
                fixedFilter={props.gridFilter}
                pick="single"
                pickedRows={draft}
                onPickChange={setDraft}
              />
```

- [ ] **Step 6: typecheck + 提交**

Run: `cd web && bun run typecheck`
Expected: 通过

```bash
git add -A && git commit -m "feat: DataGrid 行着色/枚举字面量/凭证弹窗过滤三个组件扩展"
```

---

### Task 6: 前端——流水列表接线 + 各处标签登记

**Files:**
- Modify: `web/app/routes/_app/finance/bank-transactions.tsx`
- Modify: `web/app/components/synie-permission-sheet/permission-labels.ts`
- Modify: `web/app/routes/_app/system/logs.tsx`
- Modify: `web/app/components/synie-record-drawer/registry.ts`

**Interfaces:**
- Consumes: Task 5 的 `rowTint`;后端 `reconcileStatus/unreconciledAmount` 列与 `reconcile` 能力码。
- Produces: 页面状态 `reconcileTxn` + `<ReconcileDrawer txn onOpenChange onChanged>` 挂载点(组件本体 Task 7 提供;本任务先建占位文件让 typecheck 通过)。

- [ ] **Step 1: 占位组件**——新建 `web/app/components/bank-reconcile/ReconcileDrawer.tsx`(Task 7 会替换为完整实现):

```tsx
import type { Row } from '~/components/synie-data-grid/types'

export interface ReconcileDrawerProps {
  txn: Row | null
  onOpenChange: (open: boolean) => void
  /** 任一对账变更后回调(父列表刷新) */
  onChanged: () => void
}

// Task 7 实现完整抽屉;先占位保证页面接线可编译
export function ReconcileDrawer(_props: ReconcileDrawerProps) {
  return null
}
```

- [ ] **Step 2: 改流水页** `bank-transactions.tsx`:

(a)imports 加:

```tsx
import { ReconcileDrawer } from '~/components/bank-reconcile/ReconcileDrawer'
import type { ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
```

(b)`GRID_COLUMNS` 改为(插入两列):

```tsx
const GRID_COLUMNS = [
  'companyId',
  'bankAccountId',
  'occurredAt',
  'summary',
  'income',
  'expense',
  'balance',
  'reconcileStatus',
  'unreconciledAmount',
  'counterpartyName',
]

// 对账状态三态胶囊:未对账红、部分对账橙、已对账绿
const GRID_OVERRIDES = {
  reconcileStatus: {
    enumColors: { UNRECONCILED: 'danger', PARTIAL: 'warning', RECONCILED: 'success' },
  },
} satisfies Record<string, ColumnOverride>
```

(c)组件内状态区加:`const [reconcileTxn, setReconcileTxn] = useState<Row | null>(null)`

(d)`<SynieDataGrid>` 加 props:

```tsx
          overrides={GRID_OVERRIDES}
          // 未完成对账的行整行警示底色(醒目展示产品要求)
          rowTint={(row) => (row.reconcileStatus === 'RECONCILED' ? undefined : 'warning')}
          rowActions={[
            { key: 'reconcile', label: '对账', capability: 'reconcile', onAction: (row) => setReconcileTxn(row) },
          ]}
```

(e)`<SynieRecordDrawer>` 加一行(派生列是系统维护字段,不进表单;view 态在对账抽屉里看):

```tsx
        exclude={['reconcileStatus', 'reconciledAmount', 'unreconciledAmount']}
```

(f)页面 JSX 末尾(SynieRecordDrawer 之后)加:

```tsx
      <ReconcileDrawer
        txn={reconcileTxn}
        onOpenChange={(open) => !open && setReconcileTxn(null)}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
```

- [ ] **Step 3: 标签登记**:
  - `permission-labels.ts` 的 `ACTION_LABELS` 末尾加 `reconcile: '对账',`
  - `logs.tsx` 的 `ACTION_LABELS` 末尾加 `quick_create: '快速对账', refresh_reconcile: '对账刷新',`;`RESOURCE_LABELS` 末尾加 `acc_bank_reconciliation: '银行对账记录',`
  - `registry.ts` 的 registry 里 `accVatInvoices` 行后加 `accBankReconciliations: { label: '对账记录' },`

- [ ] **Step 4: typecheck + 提交**

Run: `cd web && bun run typecheck`
Expected: 通过

```bash
git add -A && git commit -m "feat: 流水列表对账状态列/行高亮/对账入口与标签登记"
```

---

### Task 7: 前端——对账抽屉(概要 + 关联记录列表 + 解除)

**Files:**
- Rewrite: `web/app/components/bank-reconcile/ReconcileDrawer.tsx`

**Interfaces:**
- Consumes: Task 6 的 props 约定(`txn/onOpenChange/onChanged`);后端 `accBankReconciliations` 列表、`destroyAccBankReconciliation`。
- Produces: `ReconcileSection` 内部组件(Task 8 在其中追加两个表单);`ledger` 查询结果(银行账户绑定科目 id,Task 8 传给关联表单)。

- [ ] **Step 1: 完整实现**(整文件替换占位):

```tsx
import { useState } from 'react'
import { AlertDialog, Button, toast } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

const DESTROY_RECONCILIATION = `
  mutation ($id: ID!) {
    destroyAccBankReconciliation(id: $id) { errors { message } }
  }
`

// 银行账户绑定科目:严格对账的前提,未绑定时隐藏表单并引导去绑定
const BANK_ACCOUNT_LEDGER = `
  query ($id: ID!) {
    accBankAccounts(filter: {id: {eq: $id}}, limit: 1, offset: 0) { results { id accountId } }
  }
`

export interface ReconcileDrawerProps {
  txn: Row | null
  onOpenChange: (open: boolean) => void
  /** 任一对账变更后回调(父列表刷新) */
  onChanged: () => void
}

export function ReconcileDrawer({ txn, onOpenChange, onChanged }: ReconcileDrawerProps) {
  // 对账增删后 bump:key 变化整体重挂,概要派生列与关联列表一起刷新
  const [version, setVersion] = useState(0)

  const bump = () => {
    setVersion((v) => v + 1)
    onChanged()
  }

  return (
    <SynieRecordDrawer
      key={`${txn?.id ?? ''}:${version}`}
      resource="accBankTransactions"
      label="流水对账"
      mode="view"
      isOpen={txn !== null}
      onOpenChange={onOpenChange}
      // 行数据来自列表白名单不全,按 id 自查完整记录(含派生列)
      rowId={txn?.id}
      contentClassName="w-full lg:w-[880px]"
      exclude={['balance', 'counterpartyAccount', 'note', 'insertedAt', 'updatedAt']}
      extraContent={(_mode, row) => (row ? <ReconcileSection txn={row} onChanged={bump} /> : null)}
    />
  )
}

function ReconcileSection({ txn, onChanged }: { txn: Row; onChanged: () => void }) {
  const [unlink, setUnlink] = useState<Row | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  const ledger = useQuery({
    queryKey: ['bankAccountLedger', txn.bankAccountId],
    queryFn: () =>
      gqlFetch<{ accBankAccounts: { results: { id: string; accountId: string | null }[] } }>(
        BANK_ACCOUNT_LEDGER,
        { id: txn.bankAccountId }
      ).then((d) => d.accBankAccounts.results[0]?.accountId ?? null),
  })

  const confirmUnlink = async () => {
    if (!unlink) return
    setUnlinking(true)
    try {
      const data = await gqlFetch<{
        destroyAccBankReconciliation: { errors: { message: string }[] | null }
      }>(DESTROY_RECONCILIATION, { id: unlink.id })
      if (data.destroyAccBankReconciliation.errors?.length) {
        throw new Error(data.destroyAccBankReconciliation.errors.map((e) => e.message).join('; '))
      }
      toast.success('已解除对账')
      setUnlink(null)
      onChanged()
    } catch (e) {
      toast.danger('解除失败', { description: (e as Error).message })
    } finally {
      setUnlinking(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">对账关联记录</h3>
        <SynieDataGrid
          resource="accBankReconciliations"
          columns={['journalId', 'amount', 'insertedAt']}
          fixedFilter={{ bankTransactionId: { eq: txn.id } }}
          rowActions={[
            { key: 'unlink', label: '解除', isDanger: true, onAction: (row) => setUnlink(row) },
          ]}
        />
      </section>

      {ledger.data === null && !ledger.isPending && (
        <p className="text-sm text-danger">该银行账户未绑定会计科目,请先在「银行账户」中绑定后再对账。</p>
      )}
      {/* Task 8:关联已有凭证 / 快速新增凭证两个表单挂在这里(ledger.data 为科目 id 时渲染) */}

      <AlertDialog.Backdrop isOpen={unlink !== null} onOpenChange={(open) => !open && setUnlink(null)}>
        <AlertDialog.Container>
          {/* 退场动画期间 unlink 已清空,显式 aria-label 防 RAC 无标题警告 */}
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="确认解除对账">
            {unlink && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>确认解除对账?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>将解除该流水与凭证的对账关联(金额 {String(unlink.amount)}),此操作不影响凭证本身。</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={unlinking}>取消</Button>
                  <Button variant="danger" isPending={unlinking} onPress={confirmUnlink}>解除</Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  )
}
```

- [ ] **Step 2: typecheck + 提交**

Run: `cd web && bun run typecheck`
Expected: 通过

```bash
git add -A && git commit -m "feat: 对账抽屉——流水概要+关联记录列表+解除"
```

---

### Task 8: 前端——关联已有凭证 + 快速新增凭证两个表单

**Files:**
- Modify: `web/app/components/bank-reconcile/ReconcileDrawer.tsx`

**Interfaces:**
- Consumes: Task 5 的 `gqlEnum`、RemoteDialogSelect 扩展;Task 4 的 `accBankReconciliationRemaining` 查询、`createAccBankReconciliation`、`quickCreateAccBankReconciliation`;`useGridMeta('accGlJournals').data.capabilities` 门控快速表单。
- Produces: 完整对账交互。

- [ ] **Step 1: 加 imports 与 GraphQL 常量**——文件顶部 imports 增补:

```tsx
import { Input, Label, NumberField, TextField, Calendar, DateField, DatePicker } from '@heroui/react'
import { parseDate } from '@internationalized/date'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { gqlEnum } from '~/components/synie-data-grid/query'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
```

(`AlertDialog, Button, toast` 已在;注意 `@heroui/react` 的具名导入合并进现有 import 行。)

GraphQL 常量区加:

```tsx
const REMAINING = `
  query ($txnId: ID!, $journalId: ID!) {
    accBankReconciliationRemaining(bankTransactionId: $txnId, journalId: $journalId)
  }
`
const CREATE_RECONCILIATION = `
  mutation ($input: CreateAccBankReconciliationInput!) {
    createAccBankReconciliation(input: $input) { result { id } errors { message } }
  }
`
const QUICK_CREATE = `
  mutation ($input: QuickCreateAccBankReconciliationInput!) {
    quickCreateAccBankReconciliation(input: $input) { result { id } errors { message } }
  }
`
```

- [ ] **Step 2: ReconcileSection 挂两个表单**——把 Task 7 留的注释行替换为:

```tsx
      {typeof ledger.data === 'string' && (
        <>
          <LinkExistingForm txn={txn} ledgerAccountId={ledger.data} onChanged={onChanged} />
          <QuickCreateForm txn={txn} onChanged={onChanged} />
        </>
      )}
```

- [ ] **Step 3: LinkExistingForm**——文件末尾加:

```tsx
/** 关联已有凭证:弹窗挑「同公司+已审核+含银行科目方向行」的凭证,选中即预填剩余可对账额度 */
function LinkExistingForm({
  txn,
  ledgerAccountId,
  onChanged,
}: {
  txn: Row
  ledgerAccountId: string
  onChanged: () => void
}) {
  const [journalId, setJournalId] = useState<string | null>(null)
  const [amount, setAmount] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const side = txn.income != null ? 'debit' : 'credit'

  const pickJournal = async (id: string | null) => {
    setJournalId(id)
    setAmount(null)
    if (!id) return
    try {
      const d = await gqlFetch<{ accBankReconciliationRemaining: string }>(REMAINING, {
        txnId: txn.id,
        journalId: id,
      })
      setAmount(Number(d.accBankReconciliationRemaining))
    } catch (e) {
      toast.danger('剩余额度查询失败', { description: (e as Error).message })
    }
  }

  const submit = async () => {
    if (!journalId || amount == null) return
    setSubmitting(true)
    try {
      const data = await gqlFetch<{
        createAccBankReconciliation: { errors: { message: string }[] | null }
      }>(CREATE_RECONCILIATION, {
        input: { bankTransactionId: txn.id, journalId, amount: String(amount) },
      })
      if (data.createAccBankReconciliation.errors?.length) {
        throw new Error(data.createAccBankReconciliation.errors.map((e) => e.message).join('; '))
      }
      toast.success('已关联凭证')
      onChanged()
    } catch (e) {
      toast.danger('关联失败', { description: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">关联已有凭证</h3>
      <div className="grid items-end gap-3 lg:grid-cols-[1fr_200px_auto]">
        <RemoteDialogSelect
          resource="accGlJournals"
          label="凭证"
          // 直连资源须显式给显示字段(缺省 name 拼出非法查询)
          labelField="voucherNo"
          searchFields={['voucherNo']}
          placeholder="选择已审核凭证…"
          value={journalId}
          onChange={(id) => void pickJournal(id)}
          gridColumns={['voucherNo', 'date', 'postingDate', 'remarks', 'debitTotal', 'creditTotal']}
          gridFilter={{
            companyId: { eq: txn.companyId },
            status: { eq: gqlEnum('AUDITED') },
            // 方向匹配预筛:凭证须含该银行科目对应方向的行(后端校验兜底)
            lines: { accountId: { eq: ledgerAccountId }, [side]: { greaterThan: '0' } },
          }}
        />
        <NumberField
          fullWidth
          value={amount == null ? NaN : amount}
          onChange={(n) => setAmount(Number.isFinite(n) ? n : null)}
        >
          <Label>对账金额</Label>
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="选凭证后自动预填" />
          </NumberField.Group>
        </NumberField>
        <Button
          isDisabled={!journalId || amount == null || amount <= 0}
          isPending={submitting}
          onPress={submit}
        >
          关联
        </Button>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: QuickCreateForm**——继续在文件末尾加:

```tsx
/** 快速新增凭证并关联:银行方向行系统预填,用户只选对方科目;创建后自动审核+关联,整体事务 */
function QuickCreateForm({ txn, onChanged }: { txn: Row; onChanged: () => void }) {
  // 三码门控:reconcile(能进本抽屉即有)+ 凭证 create/audit 能力
  const journalMeta = useGridMeta('accGlJournals')
  const isIncome = txn.income != null
  const [accountId, setAccountId] = useState<string | null>(null)
  const [amount, setAmount] = useState<number | null>(() => {
    const n = Number(txn.unreconciledAmount)
    return Number.isFinite(n) && n > 0 ? n : null
  })
  const [summary, setSummary] = useState<string>((txn.summary as string | null) ?? '')
  // 凭证/过账日期默认取流水交易日(UTC 日期部分,与流水展示同口径)
  const [postingDate, setPostingDate] = useState<string | null>(String(txn.occurredAt).slice(0, 10))
  const [submitting, setSubmitting] = useState(false)

  const canQuick = ['create', 'audit'].every((c) =>
    (journalMeta.data?.capabilities ?? []).includes(c)
  )
  if (!canQuick) return null

  const submit = async () => {
    if (!accountId || amount == null || !postingDate) return
    setSubmitting(true)
    try {
      const data = await gqlFetch<{
        quickCreateAccBankReconciliation: { errors: { message: string }[] | null }
      }>(QUICK_CREATE, {
        input: {
          bankTransactionId: txn.id,
          counterAccountId: accountId,
          amount: String(amount),
          summary: summary || null,
          postingDate,
        },
      })
      if (data.quickCreateAccBankReconciliation.errors?.length) {
        throw new Error(
          data.quickCreateAccBankReconciliation.errors.map((e) => e.message).join('; ')
        )
      }
      toast.success('凭证已创建并完成对账')
      onChanged()
    } catch (e) {
      toast.danger('快速对账失败', { description: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">快速新增凭证并关联</h3>
      <p className="text-xs text-muted">
        {isIncome ? '借:银行科目(系统预填) 贷:所选科目' : '借:所选科目 贷:银行科目(系统预填)'}
        ,保存后自动审核过账并建立对账关联。
      </p>
      <div className="grid items-end gap-3 lg:grid-cols-[1fr_160px_1fr_180px_auto]">
        <RemoteSelect
          resource="basAccounts"
          label={isIncome ? '贷方科目' : '借方科目'}
          labelField="name"
          searchFields={['code', 'name']}
          placeholder="选择对方科目…"
          value={accountId}
          onChange={(id) => setAccountId(id)}
          filter={`{companyId: {eq: ${JSON.stringify(txn.companyId)}}, isGroup: {eq: false}, active: {eq: true}}`}
        />
        <NumberField
          fullWidth
          value={amount == null ? NaN : amount}
          onChange={(n) => setAmount(Number.isFinite(n) ? n : null)}
        >
          <Label>金额</Label>
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="默认未对账余额" />
          </NumberField.Group>
        </NumberField>
        <TextField fullWidth value={summary} onChange={setSummary}>
          <Label>摘要</Label>
          <Input placeholder="默认取流水摘要" />
        </TextField>
        <DatePicker
          value={postingDate ? safeParseDate(postingDate) : null}
          onChange={(v) => setPostingDate(v ? v.toString() : null)}
        >
          <Label>凭证/过账日期</Label>
          <DateField.Group fullWidth>
            <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateField.Suffix>
              <DatePicker.Trigger>
                <DatePicker.TriggerIndicator />
              </DatePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DatePicker.Popover>
            <Calendar aria-label="凭证/过账日期">
              <Calendar.Header>
                <Calendar.YearPickerTrigger>
                  <Calendar.YearPickerTriggerHeading />
                  <Calendar.YearPickerTriggerIndicator />
                </Calendar.YearPickerTrigger>
                <Calendar.NavButton slot="previous" />
                <Calendar.NavButton slot="next" />
              </Calendar.Header>
              <Calendar.Grid>
                <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
                <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
              </Calendar.Grid>
              <Calendar.YearPickerGrid>
                <Calendar.YearPickerGridBody>
                  {({ year }) => <Calendar.YearPickerCell year={year} />}
                </Calendar.YearPickerGridBody>
              </Calendar.YearPickerGrid>
            </Calendar>
          </DatePicker.Popover>
        </DatePicker>
        <Button
          isDisabled={!accountId || amount == null || amount <= 0 || !postingDate}
          isPending={submitting}
          onPress={submit}
        >
          创建并对账
        </Button>
      </div>
    </section>
  )
}

// 非法日期串回落 null,不让抽屉崩掉
function safeParseDate(v: string) {
  try {
    return parseDate(v)
  } catch {
    return null
  }
}
```

- [ ] **Step 5: typecheck + 提交**

Run: `cd web && bun run typecheck`
Expected: 通过

```bash
git add -A && git commit -m "feat: 对账抽屉两种关联方式——已有凭证+快速新增凭证"
```

---

### Task 9: 端到端验证(主会话执行,不派子代理)

**Files:** 无新增(修 bug 才动)

- [ ] **Step 1: 后端全量回归**:`cd backend && mix test`,Expected 全绿
- [ ] **Step 2: 起服务**(避开 4000/3000,绑 0.0.0.0):
  - 后端:`cd backend && PORT=4102 mix phx.server`(后台)
  - 前端:`cd web && BACKEND_PORT=4102 bun run dev --host --port 3102`(后台)
- [ ] **Step 3: Playwright 走查**(admin/admin123 登录,财务→银行流水):
  1. 建流水(收入 1000):列表出现红「未对账」Chip + 整行警示底色 + 未对账金额 1000
  2. 行菜单「对账」→ 抽屉概要正确;若账户未绑科目出现红提示,先去银行账户绑定
  3. 凭证页建一张含「借银行科目 400」的凭证并审核;回对账抽屉「关联已有凭证」弹窗只见该凭证,选中后金额预填 400,关联成功 → 列表变橙「部分对账」
  4. 快速新增凭证:默认金额 600、摘要/日期预填,选贷方科目提交 → 状态变绿「已对账」,行高亮消失;凭证页可见新凭证已审核
  5. 关联记录里点凭证号 → 速览抽屉叠出凭证详情
  6. 解除一条 → 状态回橙;凭证页对该凭证「取消」→ 被拒提示先解除对账
  7. 无 reconcile 权限用户(或去掉角色权限)看不到「对账」行动作
- [ ] **Step 4: 问题修复后重跑 `mix test` + `bun run typecheck`,提交**

---

## 范围外(照 spec)

自动匹配建议、批量对账、对账报表、凭证列表反向展示已对账金额、导入时自动对账。
