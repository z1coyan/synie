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

  describe "科目角色对手强校" do
    test "挂角色科目的分录必须填对手", %{company: co, sales: sales} do
      receivable =
        account!(%{
          code: "1122",
          name: "应收账款",
          direction: :debit,
          role: :receivable,
          company_id: co.id
        })

      assert {:error, "往来科目「应收账款」的分录必须填写对手"} =
               GL.validate_entries(co.id, pair(receivable, sales, "100"))

      with_party =
        pair(receivable, sales, "100")
        |> List.update_at(
          0,
          &Map.merge(&1, %{party_type: :customer, party_id: Ash.UUID.generate()})
        )

      assert :ok = GL.validate_entries(co.id, with_party)
    end

    test "红字行豁免:存量无对手分录可红冲", %{company: co, cash: cash, sales: sales} do
      # 先无角色过账(模拟存量),再给科目挂角色
      v = voucher(co)
      :ok = GL.post!(v, pair(cash, sales, "100"))

      cash
      |> Ash.Changeset.for_update(:update, %{role: :unbilled_receivable})
      |> Ash.update!(authorize?: false)

      assert :ok = GL.reverse!(v.voucher_type, v.voucher_id, ~D[2026-07-31])
    end

    test "费用角色科目的分录不要求带对手(强校仅往来角色)", %{company: co, cash: cash} do
      travel =
        account!(%{
          code: "660201",
          name: "差旅费",
          direction: :debit,
          role: :travel,
          company_id: co.id
        })

      assert :ok = GL.validate_entries(co.id, pair(travel, cash, "100"))
    end
  end

  test "cancel! 标记该单据全部分录", %{company: co, cash: cash, sales: sales} do
    v = voucher(co)
    :ok = GL.post!(v, pair(cash, sales, "88"))
    :ok = GL.cancel!(v.voucher_type, v.voucher_id)

    assert Enum.all?(entries_of(v.voucher_id), & &1.is_cancelled)
  end

  describe "红字扩展" do
    test "默认 post! 拒绝负数金额", %{company: co, cash: cash, sales: sales} do
      entries = [
        %{account_id: cash.id, debit: Decimal.new("-100"), credit: Decimal.new(0)},
        %{account_id: sales.id, debit: Decimal.new(0), credit: Decimal.new("-100")}
      ]

      assert_raise ArgumentError, ~r/恰一边大于零/, fn ->
        GL.post!(voucher(co), entries)
      end
    end

    test "allow_negative 放行恰一边非零的负数行", %{company: co, cash: cash, sales: sales} do
      entries = [
        %{account_id: cash.id, debit: Decimal.new("-100"), credit: Decimal.new(0)},
        %{account_id: sales.id, debit: Decimal.new(0), credit: Decimal.new("-100")}
      ]

      assert :ok == GL.post!(voucher(co), entries, allow_negative: true)
    end

    test "reverse! 生成取负红字组并把原组标已红冲", %{company: co, cash: cash, sales: sales} do
      v = voucher(co)
      :ok = GL.post!(v, pair(cash, sales, "100"))
      :ok = GL.reverse!(v.voucher_type, v.voucher_id, ~D[2026-07-31])

      all = entries_of(v.voucher_id)
      originals = Enum.filter(all, &(not &1.is_reversal))
      reds = Enum.filter(all, & &1.is_reversal)

      assert length(reds) == 2
      assert Enum.all?(originals, & &1.is_reversed)
      assert Enum.all?(reds, &(&1.posting_date == ~D[2026-07-31]))
      assert Enum.all?(reds, &String.starts_with?(&1.remarks || "", "红冲"))
      # 借贷合计归零
      assert Decimal.equal?(sum(all, :debit), Decimal.new(0))
      assert Decimal.equal?(sum(all, :credit), Decimal.new(0))
    end

    test "reverse! 无可红冲分录时报错" do
      assert_raise ArgumentError, ~r/没有可红冲的分录/, fn ->
        GL.reverse!("acc.gl_journal", Ash.UUID.generate(), ~D[2026-07-31])
      end
    end

    test "重复 reverse! 被拒(原组已标记,不再命中)", %{company: co, cash: cash, sales: sales} do
      v = voucher(co)
      :ok = GL.post!(v, pair(cash, sales, "100"))
      :ok = GL.reverse!(v.voucher_type, v.voucher_id, ~D[2026-07-31])

      assert_raise ArgumentError, ~r/没有可红冲的分录/, fn ->
        GL.reverse!(v.voucher_type, v.voucher_id, ~D[2026-07-31])
      end
    end
  end

  defp sum(entries, key) do
    entries |> Enum.map(&Map.fetch!(&1, key)) |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
  end
end
