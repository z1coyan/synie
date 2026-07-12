defmodule SynieCore.Acc.BankImportTemplateTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.BankAccount
  alias SynieCore.Acc.BankImportTemplate
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Currency

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    %{company: company, bank_account: bank_account!(company)}
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

  defp template!(attrs) do
    BankImportTemplate
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # 缺省给合法的「时间单列 + 金额双列」配置,用 overrides 切换模式
  defp valid_attrs(company, bank_account, overrides \\ %{}) do
    Map.merge(
      %{
        name: "招行导出#{System.unique_integer([:positive])}",
        company_id: company.id,
        bank_account_id: bank_account.id,
        datetime_col: "A",
        datetime_format: :ymd_dash_hms,
        income_col: "C",
        expense_col: "D"
      },
      overrides
    )
  end

  defp actor(overrides) do
    struct!(
      %Actor{
        user_id: Ash.UUID.generate(),
        permissions: MapSet.new(["acc.bank_import_template:*"])
      },
      overrides
    )
  end

  test "时间单列 + 带符号单金额列模式", %{company: co, bank_account: ba} do
    tpl =
      template!(
        valid_attrs(co, ba, %{
          income_col: nil,
          expense_col: nil,
          amount_col: "C",
          balance_col: "E",
          summary_col: "F"
        })
      )

    assert tpl.start_row == 2
    assert tpl.amount_col == "C"
  end

  test "日期/时间双列 + 收支双列模式,时间列可省", %{company: co, bank_account: ba} do
    template!(
      valid_attrs(co, ba, %{
        datetime_col: nil,
        datetime_format: nil,
        date_col: "A",
        date_format: :ymd_slash,
        time_col: "B",
        time_format: :hms
      })
    )

    # 只有日期没有时间列(缺省 00:00:00)
    template!(
      valid_attrs(co, ba, %{
        datetime_col: nil,
        datetime_format: nil,
        date_col: "A",
        date_format: :ymd_dash
      })
    )
  end

  test "时间配置非法组合全拒绝", %{company: co, bank_account: ba} do
    invalid = [
      # 单列缺格式
      %{datetime_format: nil},
      # 两模式混填
      %{date_col: "B", date_format: :ymd_dash},
      # 全空
      %{datetime_col: nil, datetime_format: nil},
      # 双列缺日期格式
      %{datetime_col: nil, datetime_format: nil, date_col: "A"},
      # 时间列缺格式
      %{
        datetime_col: nil,
        datetime_format: nil,
        date_col: "A",
        date_format: :ymd_dash,
        time_col: "B"
      },
      # 时间格式没有时间列
      %{
        datetime_col: nil,
        datetime_format: nil,
        date_col: "A",
        date_format: :ymd_dash,
        time_format: :hms
      }
    ]

    for overrides <- invalid do
      assert_raise Ash.Error.Invalid, fn ->
        template!(valid_attrs(co, ba, overrides))
      end
    end
  end

  test "金额列配置:全空拒绝,单列与双列互斥", %{company: co, bank_account: ba} do
    assert_raise Ash.Error.Invalid, fn ->
      template!(valid_attrs(co, ba, %{income_col: nil, expense_col: nil}))
    end

    assert_raise Ash.Error.Invalid, fn ->
      template!(valid_attrs(co, ba, %{amount_col: "E"}))
    end
  end

  test "列号归一大写,非法列号拒绝", %{company: co, bank_account: ba} do
    tpl = template!(valid_attrs(co, ba, %{datetime_col: "aa"}))
    assert tpl.datetime_col == "AA"

    for bad <- ["A1", "ABC", "1"] do
      assert_raise Ash.Error.Invalid, fn ->
        template!(valid_attrs(co, ba, %{income_col: bad}))
      end
    end
  end

  test "模板名同公司唯一,跨公司可重复", %{company: co, bank_account: ba} do
    other = company!()
    template!(valid_attrs(co, ba, %{name: "招行导出"}))
    template!(valid_attrs(other, bank_account!(other), %{name: "招行导出"}))

    assert_raise Ash.Error.Invalid, fn ->
      template!(valid_attrs(co, ba, %{name: "招行导出"}))
    end
  end

  test "账户必须属于同一公司", %{company: co} do
    other_ba = bank_account!(company!())

    assert_raise Ash.Error.Invalid, fn ->
      template!(valid_attrs(co, other_ba))
    end
  end

  test "读取按授权公司过滤(fail-closed),无权限拒绝创建", %{company: co, bank_account: ba} do
    other = company!()
    template!(valid_attrs(co, ba))
    template!(valid_attrs(other, bank_account!(other)))

    rows = Ash.read!(BankImportTemplate, actor: actor(%{company_ids: [co.id]}))
    assert Enum.map(rows, & &1.company_id) == [co.id]

    assert Ash.read!(BankImportTemplate, actor: actor(%{})) == []

    no_perm = struct!(%Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new()}, %{})

    assert_raise Ash.Error.Forbidden, fn ->
      BankImportTemplate
      |> Ash.Changeset.for_create(:create, valid_attrs(co, ba))
      |> Ash.create!(actor: no_perm)
    end
  end
end
