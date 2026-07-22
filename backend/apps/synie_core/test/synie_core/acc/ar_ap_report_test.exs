defmodule SynieCore.Acc.ArApReportTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.{GL, GlEntry}
  alias SynieCore.Base.Account

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()

    accounts = %{
      unbilled: account!(company, "112201", "未开票应收", :debit, :unbilled_receivable),
      receivable: account!(company, "112202", "应收账款", :debit, :receivable),
      advance_received: account!(company, "2203", "预收账款", :credit, :advance_received),
      payable: account!(company, "2202", "应付账款", :credit, :payable),
      bank: account!(company, "1002", "银行存款", :debit, nil),
      sales: account!(company, "6001", "主营业务收入", :credit, nil)
    }

    customer_a =
      SynieCore.Sales.Customer
      |> Ash.Changeset.for_create(:create, %{code: "C001", name: "客户甲"})
      |> Ash.create!(authorize?: false)

    customer_b =
      SynieCore.Sales.Customer
      |> Ash.Changeset.for_create(:create, %{code: "C002", name: "客户乙"})
      |> Ash.create!(authorize?: false)

    supplier =
      SynieCore.Purchase.Supplier
      |> Ash.Changeset.for_create(:create, %{code: "S001", name: "供应商丙"})
      |> Ash.create!(authorize?: false)

    %{
      company: company,
      acc: accounts,
      customer_a: customer_a,
      customer_b: customer_b,
      supplier: supplier
    }
  end

  defp account!(company, code, name, direction, role) do
    Account
    |> Ash.Changeset.for_create(:create, %{
      code: code,
      name: name,
      direction: direction,
      role: role,
      company_id: company.id
    })
    |> Ash.create!(authorize?: false)
  end

  defp post!(company, date, lines) do
    GL.post!(
      %{
        voucher_type: "acc.gl_journal",
        voucher_id: Ash.UUID.generate(),
        voucher_no: "记-#{System.unique_integer([:positive])}",
        company_id: company.id,
        posting_date: date
      },
      lines
    )
  end

  defp line(account, debit, credit, party \\ nil) do
    %{
      account_id: account.id,
      debit: Decimal.new(debit),
      credit: Decimal.new(credit),
      party_type: party && elem(party, 0),
      party_id: party && elem(party, 1)
    }
  end

  defp report(company, as_of) do
    GlEntry
    |> Ash.ActionInput.for_action(:ar_ap_report, %{company_id: company.id, as_of: as_of})
    |> Ash.run_action!(authorize?: false)
  end

  defp row(report, label), do: Enum.find(report["rows"], &(&1["partyLabel"] == label))

  test "对手×角色轧差、净额、兜底行与作废/截至日过滤", ctx do
    %{company: co, acc: acc, customer_a: a, customer_b: b, supplier: s} = ctx
    ca = {:customer, a.id}

    # 客户甲:发货 100 → 开票 60 → 收款 30
    :ok = post!(co, ~D[2026-07-01], [line(acc.unbilled, "100", 0, ca), line(acc.sales, 0, "100")])

    :ok =
      post!(co, ~D[2026-07-02], [
        line(acc.receivable, "60", 0, ca),
        line(acc.unbilled, 0, "60", ca)
      ])

    :ok = post!(co, ~D[2026-07-03], [line(acc.bank, "30", 0), line(acc.receivable, 0, "30", ca)])

    # 客户乙:预收 50
    :ok =
      post!(co, ~D[2026-07-04], [
        line(acc.bank, "50", 0),
        line(acc.advance_received, 0, "50", {:customer, b.id})
      ])

    # 供应商丙:应付 80(费用行借收入科目凑平,方向不影响口径)
    :ok =
      post!(co, ~D[2026-07-05], [
        line(acc.sales, "80", 0),
        line(acc.payable, 0, "80", {:supplier, s.id})
      ])

    # 作废组不算数
    v = %{
      voucher_type: "acc.gl_journal",
      voucher_id: Ash.UUID.generate(),
      voucher_no: "记-void",
      company_id: co.id,
      posting_date: ~D[2026-07-06]
    }

    :ok = GL.post!(v, [line(acc.unbilled, "20", 0, ca), line(acc.sales, 0, "20")])
    :ok = GL.cancel!(v.voucher_type, v.voucher_id)

    # 截至日之后的分录不算数
    :ok = post!(co, ~D[2026-08-01], [line(acc.unbilled, "5", 0, ca), line(acc.sales, 0, "5")])

    # 存量无对手行(绕过 GL 直插,模拟强校验之前的历史数据)
    for {debit, credit, account} <- [{"10", 0, acc.unbilled}, {0, "10", acc.sales}] do
      GlEntry
      |> Ash.Changeset.for_create(:create, %{
        company_id: co.id,
        account_id: account.id,
        posting_date: ~D[2026-07-01],
        debit: Decimal.new(debit),
        credit: Decimal.new(credit),
        voucher_type: "acc.gl_journal",
        voucher_id: Ash.UUID.generate(),
        voucher_no: "记-legacy"
      })
      |> Ash.create!(authorize?: false)
    end

    result = report(co, ~D[2026-07-31])

    assert result["asOf"] == "2026-07-31"

    row_a = row(result, "客户甲")
    assert row_a["partyType"] == "customer"
    assert row_a["balances"]["unbilledReceivable"] == "40"
    assert row_a["balances"]["receivable"] == "30"
    assert row_a["netReceivable"] == "70"
    assert row_a["netPayable"] == "0"

    row_b = row(result, "客户乙")
    assert row_b["balances"]["advanceReceived"] == "50"
    assert row_b["netReceivable"] == "-50"

    row_s = row(result, "供应商丙")
    assert row_s["balances"]["payable"] == "80"
    assert row_s["netPayable"] == "80"

    fallback = row(result, "未指定对手")
    assert fallback["partyId"] == nil
    assert fallback["balances"]["unbilledReceivable"] == "10"
    # 兜底行排最后
    assert List.last(result["rows"]) == fallback

    # 无角色科目(银行/收入)不进报表;角色科目清单供下钻
    assert Enum.map(result["roleAccounts"]["receivable"], & &1["code"]) == ["112202"]
    assert Enum.map(result["roleAccounts"]["unbilledReceivable"], & &1["code"]) == ["112201"]
  end

  test "其他应付款计入净应付;费用角色不进报表列", ctx do
    %{company: co, acc: acc} = ctx

    other_payable = account!(co, "2241", "其他应付款", :credit, :other_payable)
    travel = account!(co, "660201", "差旅费", :debit, :travel)

    employee =
      SynieCore.Hr.Employee
      |> Ash.Changeset.for_create(:create, %{
        code: "E#{System.unique_integer([:positive])}",
        name: "员工甲"
      })
      |> Ash.create!(authorize?: false)

    # 报销挂账:借差旅费(费用角色,不带对手)/贷其他应付款(带员工对手)
    :ok =
      post!(co, ~D[2026-07-01], [
        line(travel, "100", 0),
        line(other_payable, 0, "100", {:employee, employee.id})
      ])

    # 供应商应付 80 对照(净应付 = 应付 + 其他应付款)
    :ok =
      post!(co, ~D[2026-07-02], [
        line(acc.sales, "80", 0),
        line(acc.payable, 0, "80", {:supplier, ctx.supplier.id})
      ])

    result = report(co, ~D[2026-07-31])

    row_e = row(result, "员工甲")
    assert row_e["partyType"] == "employee"
    assert row_e["balances"]["otherPayable"] == "100"
    assert row_e["netPayable"] == "100"
    # 费用角色不出列、不进角色科目清单
    refute Map.has_key?(row_e["balances"], "travel")
    refute Map.has_key?(result["roleAccounts"], "travel")

    row_s = row(result, "供应商丙")
    assert row_s["netPayable"] == "80"
  end

  test "全零对手不出行(开票后全额收款)", ctx do
    %{company: co, acc: acc, customer_a: a} = ctx
    ca = {:customer, a.id}

    :ok =
      post!(co, ~D[2026-07-01], [line(acc.receivable, "100", 0, ca), line(acc.sales, 0, "100")])

    :ok =
      post!(co, ~D[2026-07-02], [line(acc.bank, "100", 0), line(acc.receivable, 0, "100", ca)])

    assert %{"rows" => []} = report(co, ~D[2026-07-31])
  end

  test "无角色科目的公司返回空报表", %{company: co} do
    other = company!()
    assert %{"rows" => [], "roleAccounts" => role_accounts} = report(other, ~D[2026-07-31])
    assert role_accounts == %{}
    # 有角色公司的科目不会串进别的公司
    assert %{"rows" => []} = report(co, ~D[2026-07-31])
  end
end
