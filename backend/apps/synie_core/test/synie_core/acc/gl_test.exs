defmodule SynieCore.Acc.GLTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{GL, GlEntry}
  alias SynieCore.Base.Account

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    cash = account!(%{code: "1001", name: "库存现金", direction: :debit, company_id: company.id})
    sales = account!(%{code: "6001", name: "主营业务收入", direction: :credit, company_id: company.id})
    %{company: company, cash: cash, sales: sales}
  end

  defp account!(attrs) do
    Account
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp voucher(co) do
    %{
      voucher_type: "acc.gl_journal",
      voucher_id: Ash.UUID.generate(),
      voucher_no: "记-0001",
      company_id: co.id,
      posting_date: ~D[2026-07-09]
    }
  end

  defp pair(cash, sales, amount) do
    [
      %{account_id: cash.id, debit: Decimal.new(amount), credit: Decimal.new(0)},
      %{account_id: sales.id, debit: Decimal.new(0), credit: Decimal.new(amount)}
    ]
  end

  defp entries_of(voucher_id) do
    GlEntry
    |> Ash.Query.filter(voucher_id == ^voucher_id)
    |> Ash.read!(authorize?: false)
  end

  test "post! 落两条配平分录并回填单据引用", %{company: co, cash: cash, sales: sales} do
    v = voucher(co)
    assert :ok = GL.post!(v, pair(cash, sales, "100"))

    entries = entries_of(v.voucher_id)
    assert length(entries) == 2
    assert Enum.all?(entries, &(&1.voucher_no == "记-0001" and &1.posting_date == ~D[2026-07-09]))
  end

  test "借贷不平被拒", %{company: co, cash: cash, sales: sales} do
    entries = [
      %{account_id: cash.id, debit: Decimal.new("100"), credit: Decimal.new(0)},
      %{account_id: sales.id, debit: Decimal.new(0), credit: Decimal.new("99")}
    ]

    assert {:error, "借贷不平"} = GL.validate_entries(co.id, entries)
    assert_raise ArgumentError, ~r/借贷不平/, fn -> GL.post!(voucher(co), entries) end
  end

  test "不足两行被拒", %{company: co, cash: cash} do
    assert {:error, "分录不少于两行"} =
             GL.validate_entries(co.id, [
               %{account_id: cash.id, debit: Decimal.new("1"), credit: Decimal.new(0)}
             ])
  end

  test "汇总科目/停用科目/跨公司科目被拒", %{company: co, cash: cash, sales: sales} do
    group =
      account!(%{
        code: "1002",
        name: "银行存款",
        direction: :debit,
        is_group: true,
        company_id: co.id
      })

    assert {:error, "汇总科目不能入账"} = GL.validate_entries(co.id, pair(group, sales, "1"))

    inactive =
      account!(%{code: "1003", name: "停用", direction: :debit, active: false, company_id: co.id})

    assert {:error, "停用科目不能入账"} = GL.validate_entries(co.id, pair(inactive, sales, "1"))

    other = company!()
    foreign = account!(%{code: "1001", name: "现金", direction: :debit, company_id: other.id})
    assert {:error, "科目必须属于单据公司"} = GL.validate_entries(co.id, pair(foreign, sales, "1"))

    assert {:error, "科目不存在"} =
             GL.validate_entries(co.id, [
               %{
                 account_id: Ash.UUID.generate(),
                 debit: Decimal.new("1"),
                 credit: Decimal.new(0)
               },
               %{account_id: cash.id, debit: Decimal.new(0), credit: Decimal.new("1")}
             ])
  end

  test "每行必须恰一边大于零", %{company: co, cash: cash, sales: sales} do
    entries = [
      %{account_id: cash.id, debit: Decimal.new(0), credit: Decimal.new(0)},
      %{account_id: sales.id, debit: Decimal.new(0), credit: Decimal.new(0)}
    ]

    assert {:error, "每行借贷必须恰一边大于零"} = GL.validate_entries(co.id, entries)
  end

  test "对手不成对被拒", %{company: co, cash: cash, sales: sales} do
    [a, b] = pair(cash, sales, "5")

    assert {:error, "对手类型与对手必须同时填写"} =
             GL.validate_entries(co.id, [Map.put(a, :party_type, :customer), b])
  end

  test "cancel! 标记该单据全部分录", %{company: co, cash: cash, sales: sales} do
    v = voucher(co)
    :ok = GL.post!(v, pair(cash, sales, "88"))
    :ok = GL.cancel!(v.voucher_type, v.voucher_id)

    assert Enum.all?(entries_of(v.voucher_id), & &1.is_cancelled)
  end
end
