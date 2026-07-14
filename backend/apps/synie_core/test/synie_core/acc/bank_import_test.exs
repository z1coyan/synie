defmodule SynieCore.Acc.BankImportTest do
  # 改全局 storage 配置,不能 async(照 FilesTest 先例)
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.BankAccount
  alias SynieCore.Acc.BankImport
  alias SynieCore.Acc.BankImportItem
  alias SynieCore.Acc.BankImportTemplate
  alias SynieCore.Acc.BankTransaction
  alias SynieCore.Authz
  alias SynieCore.Base.Currency
  alias SynieCore.Files
  alias SynieCore.XlsxFixture

  require Ash.Query

  @header ["日期", "时间", "收入", "支出", "余额", "对方户名", "摘要"]
  @row1 ["2026-07-01", "10:30:00", "1,234.56", "", "5000.00", "某某公司", "货款"]
  @row2 ["2026-07-02", "08:00:00", "", "88.00", "4912.00", "房东", "房租"]

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_bank_import_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(base, "objects"))

    SynieCore.Files.StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{
      name: "test_local",
      label: "测试本地",
      kind: :local,
      root: Path.join(base, "objects")
    })
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)

    on_exit(fn -> File.rm_rf!(base) end)

    company = company!()
    bank_account = bank_account!(company)
    # 全权 actor:文件上传 + 流水全动作(含 import),授权到本公司
    actor = actor_with!(["sys.file:create", "sys.file:read", "acc.bank_transaction:*"], [company])

    %{
      base: base,
      company: company,
      bank_account: bank_account,
      template: template!(company, bank_account),
      actor: actor
    }
  end

  defp actor_with!(permissions, companies) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Enum.each(companies, &grant_company!(user, &1))
    Authz.build_actor(user)
  end

  defp currency! do
    i = System.unique_integer([:positive])
    code = <<?A + rem(div(i, 676), 26), ?A + rem(div(i, 26), 26), ?A + rem(i, 26)>>

    Currency
    |> Ash.Changeset.for_create(:create, %{name: "测试币", iso_code: code})
    |> Ash.create!(authorize?: false)
  end

  defp bank_account!(company) do
    BankAccount
    |> Ash.Changeset.for_create(:create, %{
      alias: "基本户#{System.unique_integer([:positive])}",
      bank_name: "招商银行",
      holder_name: "测试公司",
      account_no: "#{System.unique_integer([:positive])}",
      company_id: company.id,
      currency_id: currency!().id
    })
    |> Ash.create!(authorize?: false)
  end

  defp template!(company, bank_account) do
    BankImportTemplate
    |> Ash.Changeset.for_create(:create, %{
      name: "标准模板#{System.unique_integer([:positive])}",
      start_row: 2,
      date_col: "A",
      date_format: :ymd_dash,
      time_col: "B",
      time_format: :hms,
      income_col: "C",
      expense_col: "D",
      balance_col: "E",
      counterparty_name_col: "F",
      summary_col: "G",
      company_id: company.id,
      bank_account_id: bank_account.id
    })
    |> Ash.create!(authorize?: false)
  end

  # 上传 xlsx 行数据,返回 sys_file id
  defp upload!(ctx, rows, filename \\ "流水.xlsx") do
    path = Path.join(ctx.base, "#{System.unique_integer([:positive])}_#{filename}")
    File.write!(path, XlsxFixture.build(rows))
    {:ok, %{file: file}} = Files.upload(ctx.actor, %{path: path, filename: filename})
    file.id
  end

  defp create_import!(ctx, file_id, overrides \\ %{}) do
    BankImport
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          company_id: ctx.company.id,
          bank_account_id: ctx.bank_account.id,
          template_id: ctx.template.id,
          file_id: file_id
        },
        overrides
      ),
      # actor 构建期传入:change 里 context.actor 构建期即读(GraphQL 真实路径同款)
      actor: ctx.actor
    )
    |> Ash.create!()
  end

  defp items_of(import_record) do
    BankImportItem
    |> Ash.Query.filter(import_id == ^import_record.id)
    |> Ash.Query.sort(row_no: :asc)
    |> Ash.read!(authorize?: false)
  end

  defp run_import(import_record, actor) do
    import_record
    |> Ash.Changeset.for_update(:import, %{}, actor: actor)
    |> Ash.update()
  end

  test "create 即解析:parsed 状态、行落库、聚合可查", ctx do
    record = create_import!(ctx, upload!(ctx, [@header, @row1, @row2]))

    assert record.status == :parsed
    assert record.error == nil
    assert record.created_by_id != nil

    [item1, item2] = items_of(record)
    assert item1.row_no == 2
    assert item1.occurred_at == ~U[2026-07-01 02:30:00Z]
    assert Decimal.equal?(item1.income, Decimal.new("1234.56"))
    assert item1.error == nil
    assert Decimal.equal?(item2.expense, Decimal.new("88.00"))

    loaded = Ash.load!(record, [:item_count, :error_count], authorize?: false)
    assert loaded.item_count == 2
    assert loaded.error_count == 0
  end

  test "文件不可解析:failed 记录照常落库带原因", ctx do
    path = Path.join(ctx.base, "bad.xls")
    File.write!(path, "这不是 xlsx")
    {:ok, %{file: file}} = Files.upload(ctx.actor, %{path: path, filename: "bad.xls"})

    record = create_import!(ctx, file.id)

    assert record.status == :failed
    assert record.error =~ "仅支持 Excel"
    assert items_of(record) == []
  end

  test "同账户同文件去重:非 failed 记录存在即拒绝,failed 不算、跨账户放行", ctx do
    file_id = upload!(ctx, [@header, @row1])
    create_import!(ctx, file_id)

    assert_raise Ash.Error.Invalid, ~r/相同文件/, fn ->
      create_import!(ctx, file_id)
    end

    # 跨账户同文件放行(各账户各导各的)
    other_account = bank_account!(ctx.company)
    other_template = template!(ctx.company, other_account)

    create_import!(ctx, file_id, %{
      bank_account_id: other_account.id,
      template_id: other_template.id
    })

    # failed 记录不挡重传
    bad_path = Path.join(ctx.base, "bad2.xlsx")
    File.write!(bad_path, "still not xlsx")
    {:ok, %{file: bad1}} = Files.upload(ctx.actor, %{path: bad_path, filename: "b1.xlsx"})
    {:ok, %{file: bad2}} = Files.upload(ctx.actor, %{path: bad_path, filename: "b2.xlsx"})
    assert create_import!(ctx, bad1.id).status == :failed
    assert create_import!(ctx, bad2.id).status == :failed
  end

  test "模板必须属于所选银行账户", ctx do
    other_account = bank_account!(ctx.company)
    other_template = template!(ctx.company, other_account)

    assert_raise Ash.Error.Invalid, ~r/导入模板必须属于所选银行账户/, fn ->
      create_import!(ctx, upload!(ctx, [@header, @row1]), %{template_id: other_template.id})
    end
  end

  test "行编辑:修复错误行清 error,校验与流水同源", ctx do
    bad_row = ["2026/07/03", "09:00:00", "10", "", "", "", "写错格式的日期"]
    record = create_import!(ctx, upload!(ctx, [@header, @row1, bad_row]))

    [_ok, bad] = items_of(record)
    assert bad.occurred_at == nil
    assert bad.error =~ "不符合格式"

    # 双填收支被拒(与流水同源校验)
    assert_raise Ash.Error.Invalid, fn ->
      bad
      |> Ash.Changeset.for_update(
        :update,
        %{
          occurred_at: ~U[2026-07-03 01:00:00Z],
          income: Decimal.new("10"),
          expense: Decimal.new("5")
        },
        actor: ctx.actor
      )
      |> Ash.update!()
    end

    fixed =
      bad
      |> Ash.Changeset.for_update(:update, %{occurred_at: ~U[2026-07-03 01:00:00Z]},
        actor: ctx.actor
      )
      |> Ash.update!()

    assert fixed.error == nil
    loaded = Ash.load!(record, [:error_count], authorize?: false)
    assert loaded.error_count == 0
  end

  test "导入执行:建流水、回填行引用、状态 imported 后只读不可删", ctx do
    record = create_import!(ctx, upload!(ctx, [@header, @row1, @row2]))

    {:ok, imported} = run_import(record, ctx.actor)
    assert imported.status == :imported
    assert imported.imported_at != nil
    assert imported.imported_by_id != nil

    transactions =
      BankTransaction
      |> Ash.Query.filter(bank_account_id == ^ctx.bank_account.id)
      |> Ash.Query.sort(occurred_at: :asc)
      |> Ash.read!(authorize?: false)

    assert length(transactions) == 2
    [t1, t2] = transactions
    assert Decimal.equal?(t1.income, Decimal.new("1234.56"))
    assert t1.summary == "货款"
    assert Decimal.equal?(t2.expense, Decimal.new("88.00"))

    assert items_of(imported) |> Enum.map(& &1.transaction_id) |> Enum.all?(&(&1 != nil))

    # 已导入:重复导入、改行、删行、删记录全部拒绝
    assert {:error, _} = run_import(imported, ctx.actor)

    [item | _] = items_of(imported)

    assert_raise Ash.Error.Invalid, ~r/已解析/, fn ->
      item
      |> Ash.Changeset.for_update(:update, %{summary: "改一下"}, actor: ctx.actor)
      |> Ash.update!()
    end

    assert_raise Ash.Error.Invalid, ~r/已解析/, fn ->
      item |> Ash.Changeset.for_destroy(:destroy, %{}, actor: ctx.actor) |> Ash.destroy!()
    end

    assert_raise Ash.Error.Invalid, ~r/已导入的记录不可删除/, fn ->
      imported |> Ash.Changeset.for_destroy(:destroy, %{}, actor: ctx.actor) |> Ash.destroy!()
    end
  end

  test "有错误行拒绝导入,删除错误行后放行", ctx do
    bad_row = ["还没到日期", "09:00:00", "10", "", "", "", ""]
    record = create_import!(ctx, upload!(ctx, [@header, @row1, bad_row]))

    assert {:error, error} = run_import(record, ctx.actor)
    assert Exception.message(error) =~ "修正或删除"

    [_ok, bad] = items_of(record)
    bad |> Ash.Changeset.for_destroy(:destroy, %{}, actor: ctx.actor) |> Ash.destroy!()

    assert {:ok, %{status: :imported}} = run_import(record, ctx.actor)
    assert length(items_of(record)) == 1
  end

  test "全部行删光后导入报没有可导入的行", ctx do
    record = create_import!(ctx, upload!(ctx, [@header, @row1]))

    for item <- items_of(record) do
      item |> Ash.Changeset.for_destroy(:destroy, %{}, actor: ctx.actor) |> Ash.destroy!()
    end

    assert {:error, error} = run_import(record, ctx.actor)
    assert Exception.message(error) =~ "没有可导入的行"
  end

  test "无流水新增权限:导入整体回滚(纵深防御)", ctx do
    record = create_import!(ctx, upload!(ctx, [@header, @row1]))

    # 只有 import 没有 create:每行创建被策略拒绝
    weak =
      actor_with!(["acc.bank_transaction:import", "acc.bank_transaction:read"], [ctx.company])

    assert {:error, error} = run_import(record, weak)
    assert Exception.message(error) =~ "无权新增银行流水"

    assert BankTransaction
           |> Ash.Query.filter(bank_account_id == ^ctx.bank_account.id)
           |> Ash.read!(authorize?: false) == []

    assert Ash.get!(BankImport, record.id, authorize?: false).status == :parsed
  end

  test "删除 parsed 记录级联删行", ctx do
    record = create_import!(ctx, upload!(ctx, [@header, @row1, @row2]))
    assert length(items_of(record)) == 2

    record |> Ash.Changeset.for_destroy(:destroy, %{}, actor: ctx.actor) |> Ash.destroy!()

    assert BankImportItem
           |> Ash.Query.filter(import_id == ^record.id)
           |> Ash.read!(authorize?: false) == []
  end

  test "权限与公司隔离:无 import 码拒创建,读取 fail-closed", ctx do
    no_import = actor_with!(["acc.bank_transaction:read", "sys.file:create"], [ctx.company])

    assert_raise Ash.Error.Forbidden, fn ->
      BankImport
      |> Ash.Changeset.for_create(
        :create,
        %{
          company_id: ctx.company.id,
          bank_account_id: ctx.bank_account.id,
          template_id: ctx.template.id,
          file_id: upload!(ctx, [@header, @row1])
        },
        actor: no_import
      )
      |> Ash.create!()
    end

    create_import!(ctx, upload!(ctx, [@header, @row1]))

    # 有码但未授权任何公司 → 空集
    scoped = actor_with!(["acc.bank_transaction:import"], [])
    assert Ash.read!(BankImport, actor: scoped) == []
    assert Ash.read!(BankImportItem, actor: scoped) == []

    # 有码且授权本公司 → 可见
    visible = actor_with!(["acc.bank_transaction:import"], [ctx.company])
    assert [%{company_id: company_id}] = Ash.read!(BankImport, actor: visible)
    assert company_id == ctx.company.id
  end
end
