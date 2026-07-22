defmodule SynieCore.Acc.ExpenseReportTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{ExpenseReport, ExpenseReportItem, GlEntry, VatInvoice}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Account
  alias SynieCore.Hr.Employee

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    employee = employee!(%{})

    accounts = %{
      payment: account!(%{code: "1002", name: "银行存款", direction: :debit, company_id: company.id}),
      other_payable:
        account!(%{
          code: "2241",
          name: "其他应付款",
          direction: :credit,
          role: :other_payable,
          company_id: company.id
        }),
      travel:
        account!(%{
          code: "660201",
          name: "差旅费",
          direction: :debit,
          role: :travel,
          company_id: company.id
        }),
      office:
        account!(%{
          code: "660202",
          name: "办公费",
          direction: :debit,
          role: :office,
          company_id: company.id
        })
    }

    %{company: company, employee: employee, accounts: accounts}
  end

  defp employee!(attrs) do
    attrs =
      Map.merge(%{code: "E#{System.unique_integer([:positive])}", name: "测试员工"}, attrs)

    Employee
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp account!(attrs) do
    Account
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["acc.expense_report:*"])},
      overrides
    )
  end

  # 费用报销发票:开入+员工对手+不关联对账单;税额 0(两行过账),gross=100
  defp invoice_attrs(co, employee, accounts, overrides \\ %{}) do
    %{
      company_id: co.id,
      doc_no: "FP-#{System.unique_integer([:positive])}",
      direction: :inbound,
      invoice_date: ~D[2026-07-01],
      party_type: :employee,
      party_id: employee.id,
      invoice_kind: :normal,
      invoice_code: "1100",
      invoice_no: "#{System.unique_integer([:positive])}",
      party_account_id: accounts.other_payable.id,
      amount_account_id: accounts.travel.id,
      net_total: Decimal.new("100"),
      tax_total: Decimal.new("0"),
      gross_total: Decimal.new("100")
    }
    |> Map.merge(overrides)
  end

  defp audited_invoice!(co, employee, accounts, overrides \\ %{}) do
    inv =
      VatInvoice
      |> Ash.Changeset.for_create(:create, invoice_attrs(co, employee, accounts, overrides))
      |> Ash.create!(authorize?: false)

    inv
    |> Ash.Changeset.for_update(:audit, %{posting_date: ~D[2026-07-10]})
    |> Ash.update!(authorize?: false)
  end

  defp report_attrs(co, employee, accounts, overrides \\ %{}) do
    %{
      company_id: co.id,
      doc_no: "BX-#{System.unique_integer([:positive])}",
      employee_id: employee.id,
      expense_date: ~D[2026-07-15],
      payment_account_id: accounts.payment.id
    }
    |> Map.merge(overrides)
  end

  defp report!(attrs, opts \\ [authorize?: false]) do
    ExpenseReport
    |> Ash.Changeset.for_create(:create, attrs, opts)
    |> Ash.create!(opts)
  end

  defp invoiced_item!(report, invoice, idx \\ 1) do
    ExpenseReportItem
    |> Ash.Changeset.for_create(:create, %{
      report_id: report.id,
      idx: idx,
      kind: :invoiced,
      invoice_id: invoice.id
    })
    |> Ash.create!(authorize?: false)
  end

  defp manual_item!(report, accounts, overrides \\ %{}) do
    attrs =
      %{
        report_id: report.id,
        idx: 2,
        kind: :manual,
        summary: "五金店现金采购",
        amount: Decimal.new("50"),
        expense_account_id: accounts.office.id
      }
      |> Map.merge(overrides)

    ExpenseReportItem
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp audit!(report, posting_date) do
    report
    |> Ash.Changeset.for_update(:audit, %{posting_date: posting_date})
    |> Ash.update!(authorize?: false)
  end

  defp void!(report) do
    report
    |> Ash.Changeset.for_update(:void, %{})
    |> Ash.update!(authorize?: false)
  end

  defp entries_for(voucher_type, voucher_id) do
    GlEntry
    |> Ash.Query.filter(voucher_type == ^voucher_type and voucher_id == ^voucher_id)
    |> Ash.read!(authorize?: false)
  end

  describe "单头 CRUD" do
    test "创建草稿:状态默认 draft,创建人取 actor", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      user = user!()
      actor = actor(user_id: user.id, company_ids: [co.id])
      report = report!(report_attrs(co, emp, accounts), actor: actor)

      assert report.status == :draft
      assert report.created_by_id == user.id
      assert report.doc_no =~ "BX-"
    end

    test "付款科目必填,且须本公司启用非汇总", %{company: co, employee: emp, accounts: accounts} do
      error =
        assert_raise Ash.Error.Invalid, fn ->
          report!(report_attrs(co, emp, accounts) |> Map.delete(:payment_account_id))
        end

      assert Exception.message(error) =~ "付款科目不能为空"

      group =
        account!(%{
          code: "1000",
          name: "汇总",
          direction: :debit,
          is_group: true,
          company_id: co.id
        })

      error =
        assert_raise Ash.Error.Invalid, fn ->
          report!(report_attrs(co, emp, accounts, %{payment_account_id: group.id}))
        end

      assert Exception.message(error) =~ "不能选择汇总科目"

      other = company!()

      foreign =
        account!(%{code: "1002", name: "银行存款", direction: :debit, company_id: other.id})

      error =
        assert_raise Ash.Error.Invalid, fn ->
          report!(report_attrs(co, emp, accounts, %{payment_account_id: foreign.id}))
        end

      assert Exception.message(error) =~ "科目不属于本公司"
    end

    test "单号公司内唯一", %{company: co, employee: emp, accounts: accounts} do
      attrs = report_attrs(co, emp, accounts, %{doc_no: "BX-DUP"})
      report!(attrs)

      assert_raise Ash.Error.Invalid, fn -> report!(attrs) end

      other = company!()

      other_payment =
        account!(%{code: "1002", name: "银行存款", direction: :debit, company_id: other.id})

      assert report!(
               report_attrs(co, emp, accounts, %{
                 doc_no: "BX-DUP",
                 company_id: other.id,
                 payment_account_id: other_payment.id
               })
             ).doc_no == "BX-DUP"
    end

    test "仅草稿可改可删", %{company: co, employee: emp, accounts: accounts} do
      draft = report!(report_attrs(co, emp, accounts))

      updated =
        draft
        |> Ash.Changeset.for_update(:update, %{remarks: "备注"})
        |> Ash.update!(authorize?: false)

      assert updated.remarks == "备注"

      audited =
        Ash.Seed.seed!(
          ExpenseReport,
          Map.merge(report_attrs(co, emp, accounts), %{
            status: :audited,
            doc_no: "BX-#{System.unique_integer([:positive])}"
          })
        )

      assert_raise Ash.Error.Invalid, fn ->
        audited
        |> Ash.Changeset.for_update(:update, %{remarks: "x"})
        |> Ash.update!(authorize?: false)
      end

      assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(audited, authorize?: false) end
      assert :ok = Ash.destroy!(draft, authorize?: false)
    end

    test "读取按公司范围过滤 fail-closed", %{company: co, employee: emp, accounts: accounts} do
      report!(report_attrs(co, emp, accounts))

      in_scope = actor(company_ids: [co.id])
      out_scope = actor([])

      assert [_] = Ash.read!(ExpenseReport, actor: in_scope)
      assert [] = Ash.read!(ExpenseReport, actor: out_scope)
    end
  end

  describe "报销行" do
    test "两槽互斥:挂票行只有发票,无票行摘要/金额/科目必填且发票必空", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      report = report!(report_attrs(co, emp, accounts))
      invoice = audited_invoice!(co, emp, accounts)

      create_item = fn attrs ->
        ExpenseReportItem
        |> Ash.Changeset.for_create(:create, Map.merge(%{report_id: report.id, idx: 1}, attrs))
        |> Ash.create!(authorize?: false)
      end

      assert_raise Ash.Error.Invalid, ~r/挂票行必须选择发票/, fn ->
        create_item.(%{kind: :invoiced})
      end

      assert_raise Ash.Error.Invalid, ~r/挂票行金额取发票价税合计/, fn ->
        create_item.(%{kind: :invoiced, invoice_id: invoice.id, amount: Decimal.new("1")})
      end

      assert_raise Ash.Error.Invalid, ~r/无票行不关联发票/, fn ->
        create_item.(%{
          kind: :manual,
          invoice_id: invoice.id,
          summary: "x",
          amount: Decimal.new("1"),
          expense_account_id: accounts.office.id
        })
      end

      assert_raise Ash.Error.Invalid, ~r/无票行必须填写摘要/, fn ->
        create_item.(%{
          kind: :manual,
          amount: Decimal.new("1"),
          expense_account_id: accounts.office.id
        })
      end

      assert_raise Ash.Error.Invalid, ~r/金额必须大于零/, fn ->
        create_item.(%{
          kind: :manual,
          summary: "x",
          amount: Decimal.new("0"),
          expense_account_id: accounts.office.id
        })
      end

      assert_raise Ash.Error.Invalid, ~r/无票行必须选择费用科目/, fn ->
        create_item.(%{kind: :manual, summary: "x", amount: Decimal.new("1")})
      end

      # 合法两类行可保存
      assert create_item.(%{kind: :invoiced, invoice_id: invoice.id}).kind == :invoiced
      assert manual_item!(report, accounts).kind == :manual
    end

    test "行随报销单级联删除", %{company: co, employee: emp, accounts: accounts} do
      report = report!(report_attrs(co, emp, accounts))
      manual_item!(report, accounts, %{idx: 1})

      assert :ok = Ash.destroy!(report, authorize?: false)

      assert ExpenseReportItem
             |> Ash.Query.filter(report_id == ^report.id)
             |> Ash.read!(authorize?: false) == []
    end

    test "非草稿报销单不可编辑行", %{company: co, employee: emp, accounts: accounts} do
      report = report!(report_attrs(co, emp, accounts))
      manual_item!(report, accounts, %{idx: 1})
      audited = audit!(report, ~D[2026-07-20])

      assert_raise Ash.Error.Invalid, ~r/仅草稿报销单可编辑报销行/, fn ->
        manual_item!(audited, accounts)
      end
    end
  end

  describe "挂票行条目池" do
    test "发票须已审核、本公司、该员工名下、未被其他报销单引用", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      report = report!(report_attrs(co, emp, accounts))

      # 草稿发票不可挂
      draft_invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, invoice_attrs(co, emp, accounts))
        |> Ash.create!(authorize?: false)

      assert_raise Ash.Error.Invalid, ~r/挂票发票须为已审核状态/, fn ->
        invoiced_item!(report, draft_invoice)
      end

      # 他公司发票不可挂(员工主数据全局,口径按发票公司)
      other = company!()

      other_accounts = %{
        other_payable:
          account!(%{
            code: "2241",
            name: "其他应付款",
            direction: :credit,
            role: :other_payable,
            company_id: other.id
          }),
        travel:
          account!(%{
            code: "660201",
            name: "差旅费",
            direction: :debit,
            role: :travel,
            company_id: other.id
          })
      }

      other_invoice = audited_invoice!(other, emp, other_accounts)

      assert_raise Ash.Error.Invalid, ~r/挂票发票公司与报销单不一致/, fn ->
        invoiced_item!(report, other_invoice)
      end

      # 其他员工名下发票不可挂
      other_emp = employee!(%{})
      other_emp_invoice = audited_invoice!(co, other_emp, accounts)

      assert_raise Ash.Error.Invalid, ~r/挂票发票须为报销单员工名下/, fn ->
        invoiced_item!(report, other_emp_invoice)
      end

      # 已被其他非作废报销单引用不可挂
      invoice = audited_invoice!(co, emp, accounts)
      other_report = report!(report_attrs(co, emp, accounts))
      invoiced_item!(other_report, invoice)

      assert_raise Ash.Error.Invalid, ~r/挂票发票已被其他报销单引用/, fn ->
        invoiced_item!(report, invoice)
      end
    end
  end

  describe "审核过账" do
    test "审核生成 借发票往来(带员工对手)/借费用科目/贷付款科目 三行且配平", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      report = report!(report_attrs(co, emp, accounts))
      invoice = audited_invoice!(co, emp, accounts)
      invoiced_item!(report, invoice)
      manual_item!(report, accounts)

      audited = audit!(report, ~D[2026-07-20])

      assert audited.status == :audited
      assert audited.audited_at != nil
      assert audited.posting_date == ~D[2026-07-20]

      entries = entries_for("acc.expense_report", report.id)
      assert length(entries) == 3
      assert Enum.all?(entries, &(&1.voucher_no == report.doc_no))

      party_line = Enum.find(entries, &(&1.account_id == accounts.other_payable.id))
      assert Decimal.equal?(party_line.debit, Decimal.new("100"))
      assert Decimal.equal?(party_line.credit, Decimal.new("0"))
      assert party_line.party_type == :employee
      assert party_line.party_id == emp.id

      expense_line = Enum.find(entries, &(&1.account_id == accounts.office.id))
      assert Decimal.equal?(expense_line.debit, Decimal.new("50"))
      assert Decimal.equal?(expense_line.credit, Decimal.new("0"))
      assert expense_line.party_id == nil

      payment_line = Enum.find(entries, &(&1.account_id == accounts.payment.id))
      assert Decimal.equal?(payment_line.debit, Decimal.new("0"))
      assert Decimal.equal?(payment_line.credit, Decimal.new("150"))
      assert payment_line.party_id == nil

      debit_total = Enum.reduce(entries, Decimal.new(0), &Decimal.add(&1.debit, &2))
      credit_total = Enum.reduce(entries, Decimal.new(0), &Decimal.add(&1.credit, &2))
      assert Decimal.equal?(debit_total, credit_total)
    end

    test "审核前必须至少一行、必须填过账日期", %{company: co, employee: emp, accounts: accounts} do
      report = report!(report_attrs(co, emp, accounts))

      assert_raise Ash.Error.Invalid, ~r/审核前必须至少填写一行报销行/, fn ->
        audit!(report, ~D[2026-07-20])
      end

      manual_item!(report, accounts, %{idx: 1})

      assert_raise Ash.Error.Invalid, ~r/审核过账前必须填写过账日期/, fn ->
        report
        |> Ash.Changeset.for_update(:audit, %{})
        |> Ash.update!(authorize?: false)
      end
    end

    test "权威复检:挂票发票非已审核(绕过行绑定直插)审核被拒", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      report = report!(report_attrs(co, emp, accounts))

      draft_invoice =
        VatInvoice
        |> Ash.Changeset.for_create(:create, invoice_attrs(co, emp, accounts))
        |> Ash.create!(authorize?: false)

      Ash.Seed.seed!(ExpenseReportItem, %{
        report_id: report.id,
        company_id: co.id,
        idx: 1,
        kind: :invoiced,
        invoice_id: draft_invoice.id
      })

      assert_raise Ash.Error.Invalid, ~r/挂票发票须为已审核状态/, fn ->
        audit!(report, ~D[2026-07-20])
      end
    end

    test "审核后单头与行锁死", %{company: co, employee: emp, accounts: accounts} do
      report = report!(report_attrs(co, emp, accounts))
      manual_item!(report, accounts, %{idx: 1})
      audited = audit!(report, ~D[2026-07-20])

      assert_raise Ash.Error.Invalid, fn ->
        audited
        |> Ash.Changeset.for_update(:update, %{remarks: "x"})
        |> Ash.update!(authorize?: false)
      end

      assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(audited, authorize?: false) end
    end

    test "一票一单:作废原报销单后发票可被新报销单重新引用", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      invoice = audited_invoice!(co, emp, accounts)

      report_a = report!(report_attrs(co, emp, accounts))
      invoiced_item!(report_a, invoice)
      audited_a = audit!(report_a, ~D[2026-07-20])

      report_b = report!(report_attrs(co, emp, accounts))

      assert_raise Ash.Error.Invalid, ~r/挂票发票已被其他报销单引用/, fn ->
        invoiced_item!(report_b, invoice)
      end

      void!(audited_a)
      assert invoiced_item!(report_b, invoice).invoice_id == invoice.id
    end
  end

  describe "作废" do
    test "作废:分录组标记 is_cancelled,报销单 voided", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      report = report!(report_attrs(co, emp, accounts))
      invoice = audited_invoice!(co, emp, accounts)
      invoiced_item!(report, invoice)
      manual_item!(report, accounts)
      audited = audit!(report, ~D[2026-07-20])

      voided = void!(audited)
      assert voided.status == :voided

      entries = entries_for("acc.expense_report", report.id)
      assert length(entries) == 3
      assert Enum.all?(entries, & &1.is_cancelled)
    end

    test "仅已审核可作废", %{company: co, employee: emp, accounts: accounts} do
      draft = report!(report_attrs(co, emp, accounts))

      assert_raise Ash.Error.Invalid, ~r/仅已审核报销单可作废/, fn -> void!(draft) end

      manual_item!(draft, accounts, %{idx: 1})
      audited = audit!(draft, ~D[2026-07-20])
      void!(audited)

      assert_raise Ash.Error.Invalid, ~r/仅已审核报销单可作废/, fn -> void!(audited) end
    end
  end

  describe "发票锁定" do
    test "被草稿报销单引用的发票不可作废/红冲,移除行后恢复", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      invoice = audited_invoice!(co, emp, accounts)
      report = report!(report_attrs(co, emp, accounts))
      item = invoiced_item!(report, invoice)

      assert_raise Ash.Error.Invalid, ~r/发票已被报销单引用/, fn ->
        invoice
        |> Ash.Changeset.for_update(:void, %{})
        |> Ash.update!(authorize?: false)
      end

      assert_raise Ash.Error.Invalid, ~r/发票已被报销单引用/, fn ->
        invoice
        |> Ash.Changeset.for_update(:reverse, %{posting_date: ~D[2026-07-31]})
        |> Ash.update!(authorize?: false)
      end

      # 草稿上移除该行后恢复可作废
      Ash.destroy!(item, authorize?: false)

      voided =
        invoice
        |> Ash.Changeset.for_update(:void, %{})
        |> Ash.update!(authorize?: false)

      assert voided.status == :voided
    end

    test "被已审核报销单引用的发票不可作废,作废报销单后恢复", %{
      company: co,
      employee: emp,
      accounts: accounts
    } do
      invoice = audited_invoice!(co, emp, accounts)
      report = report!(report_attrs(co, emp, accounts))
      invoiced_item!(report, invoice)
      audited = audit!(report, ~D[2026-07-20])

      assert_raise Ash.Error.Invalid, ~r/发票已被报销单引用/, fn ->
        invoice
        |> Ash.Changeset.for_update(:void, %{})
        |> Ash.update!(authorize?: false)
      end

      void!(audited)

      voided =
        invoice
        |> Ash.Changeset.for_update(:void, %{})
        |> Ash.update!(authorize?: false)

      assert voided.status == :voided

      # 发票分录组随之作废
      entries = entries_for("acc.vat_invoice", invoice.id)
      assert Enum.all?(entries, & &1.is_cancelled)
    end
  end
end
