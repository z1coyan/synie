defmodule SynieCore.Setup.SampleData.Finance do
  @moduledoc """
  示例数据:财务域(编排在最后,发票读已确认对账单的合计金额)。

  银行账户 1(绑 1002 银行存款)+ 手工流水 6 条(收付款散布近 90 天,无 GL 副作用);
  手工凭证 2 张并审核(D-85 期初 借1002/贷3001 实收资本、D-30 借5602/贷1002);
  报销单 1 张(纯无票行,费用 5602、付款 1002,审核);工资单 2 张(上月,
  其中 1 张 PayrollPayment 发放);销项/进项发票各 1 张:关联已确认对账单,
  价税合计=对账合计(审核强校),审核即把对账单翻为已结单,两条链走完整。
  """

  alias SynieCore.Acc.BankAccount
  alias SynieCore.Acc.BankTransaction
  alias SynieCore.Acc.ExpenseReport
  alias SynieCore.Acc.ExpenseReportItem
  alias SynieCore.Acc.GlJournal
  alias SynieCore.Acc.GlJournalLine
  alias SynieCore.Acc.VatInvoice
  alias SynieCore.Hr.Payroll
  alias SynieCore.Hr.PayrollPayment
  alias SynieCore.Setup.SampleData

  @vat_rate Decimal.new("0.13")

  @doc "返回 `{ %{bank_transactions:, gl_journals:, payrolls:, vat_invoices:}, notifications }`。"
  def seed!(ctx, master, sales, purchase, actor) do
    {bank_account, n1} = seed_bank_account!(ctx)
    {transactions, n2} = seed_bank_transactions!(ctx, master, bank_account)
    {journals, n3} = seed_gl_journals!(ctx, actor)
    {_expense_report, n4} = seed_expense_report!(ctx, master, actor)
    {payrolls, n5} = seed_payrolls!(master, actor)
    {invoices, n6} = seed_vat_invoices!(ctx, master, sales, purchase, actor)

    result = %{
      bank_transactions: transactions,
      gl_journals: journals,
      payrolls: payrolls,
      vat_invoices: invoices
    }

    {result, n1 ++ n2 ++ n3 ++ n4 ++ n5 ++ n6}
  end

  # ---------------------------------------------------------------------------
  # 银行账户与流水
  # ---------------------------------------------------------------------------

  defp seed_bank_account!(ctx) do
    SampleData.create!(
      BankAccount,
      %{
        alias: "基本户",
        bank_name: "中国银行",
        branch_name: "台州分行营业部",
        holder_name: ctx.company.name,
        account_no: "377601886688901",
        company_id: ctx.company.id,
        currency_id: ctx.company.base_currency_id,
        account_id: ctx.accounts.bank.id
      },
      nil
    )
  end

  # 收付款散布近 90 天;income/expense 恰填一项(SingleSidedAmount),balance 随手记
  defp seed_bank_transactions!(ctx, master, bank_account) do
    c01 = master.customers["C01"]
    c02 = master.customers["C02"]
    s01 = master.suppliers["S01"]
    s04 = master.suppliers["S04"]

    specs = [
      %{
        ago: 80,
        hour: 10,
        income: "200000.00",
        balance: "200000.00",
        counterparty: "王建国",
        summary: "股东注资款"
      },
      %{
        ago: 28,
        hour: 14,
        income: "36000.00",
        balance: "236000.00",
        counterparty: c01.name,
        summary: "海纳电气货款"
      },
      %{
        ago: 20,
        hour: 9,
        expense: "33360.00",
        balance: "202640.00",
        counterparty: s01.name,
        summary: "支付精铜材料货款"
      },
      %{
        ago: 15,
        hour: 16,
        expense: "8500.00",
        balance: "194140.00",
        counterparty: s04.name,
        summary: "支付恒力钣金部分货款"
      },
      %{
        ago: 8,
        hour: 11,
        income: "12500.00",
        balance: "206640.00",
        counterparty: c02.name,
        summary: "联成机电预付款"
      },
      %{
        ago: 5,
        hour: 15,
        expense: "3200.00",
        balance: "203440.00",
        counterparty: "陈晓梅",
        summary: "报销及办公用品采购"
      }
    ]

    Enum.map_reduce(specs, [], fn spec, acc ->
      attrs = %{
        company_id: ctx.company.id,
        bank_account_id: bank_account.id,
        occurred_at: DateTime.new!(SampleData.days_ago(spec.ago), Time.new!(spec.hour, 0, 0)),
        counterparty_name: spec.counterparty,
        summary: spec.summary,
        balance: Decimal.new(spec.balance)
      }

      attrs =
        case spec do
          %{income: amount} -> Map.put(attrs, :income, Decimal.new(amount))
          %{expense: amount} -> Map.put(attrs, :expense, Decimal.new(amount))
        end

      {row, notifications} = SampleData.create!(BankTransaction, attrs, nil)
      {row, acc ++ notifications}
    end)
  end

  # ---------------------------------------------------------------------------
  # 手工凭证
  # ---------------------------------------------------------------------------

  defp seed_gl_journals!(ctx, actor) do
    accounts = ctx.accounts

    {j1, n1} =
      journal!(ctx, 85, "期初实收资本入账", actor,
        lines: [
          {accounts.bank, "200000.00", "0"},
          {accounts.capital, "0", "200000.00"}
        ]
      )

    {j2, n2} =
      journal!(ctx, 30, "支付当月办公场地租金", actor,
        lines: [
          {accounts.expense, "1200.00", "0"},
          {accounts.bank, "0", "1200.00"}
        ]
      )

    {[j1, j2], n1 ++ n2}
  end

  # lines: [{科目, 借方, 贷方}](均无往来角色,不带对手)
  defp journal!(ctx, date_ago, remarks, actor, opts) do
    lines = Keyword.fetch!(opts, :lines)
    date = SampleData.days_ago(date_ago)

    {journal, n1} =
      SampleData.create!(
        GlJournal,
        %{company_id: ctx.company.id, date: date, posting_date: date, remarks: remarks},
        actor
      )

    n2 =
      lines
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {{account, debit, credit}, idx} ->
        {_line, notifications} =
          SampleData.create!(
            GlJournalLine,
            %{
              journal_id: journal.id,
              idx: idx,
              account_id: account.id,
              debit: Decimal.new(debit),
              credit: Decimal.new(credit)
            },
            actor
          )

        notifications
      end)

    {audited, n3} = SampleData.run_action!(journal, :audit, %{}, actor)
    {audited, n1 ++ n2 ++ n3}
  end

  # ---------------------------------------------------------------------------
  # 报销单
  # ---------------------------------------------------------------------------

  # 纯无票行:借行费用科目(5602),贷头付款科目(1002),审核即过账
  defp seed_expense_report!(ctx, master, actor) do
    date = SampleData.days_ago(18)

    {report, n1} =
      SampleData.create!(
        ExpenseReport,
        %{
          company_id: ctx.company.id,
          employee_id: master.employees["陈晓梅"].id,
          expense_date: date,
          posting_date: date,
          payment_account_id: ctx.accounts.bank.id,
          remarks: "初始化示例报销单"
        },
        actor
      )

    n2 =
      [
        {"宁波客户拜访差旅费", "860.00"},
        {"办公用品采购", "240.50"}
      ]
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {{summary, amount}, idx} ->
        {_item, notifications} =
          SampleData.create!(
            ExpenseReportItem,
            %{
              report_id: report.id,
              idx: idx,
              kind: :manual,
              summary: summary,
              amount: Decimal.new(amount),
              expense_account_id: ctx.accounts.expense.id
            },
            actor
          )

        notifications
      end)

    {audited, n3} = SampleData.run_action!(report, :audit, %{}, actor)
    {audited, n1 ++ n2 ++ n3}
  end

  # ---------------------------------------------------------------------------
  # 工资单
  # ---------------------------------------------------------------------------

  # 上月工资单 2 张:张伟强已发放( PayrollPayment 联动翻已发放),李秀英待发放
  defp seed_payrolls!(master, actor) do
    month =
      Date.utc_today()
      |> Date.beginning_of_month()
      |> Date.add(-1)
      |> Date.beginning_of_month()
      |> Calendar.strftime("%Y-%m")

    {p1, n1} =
      SampleData.create!(
        Payroll,
        %{
          employee_id: master.employees["张伟强"].id,
          month: month,
          workdays: Decimal.new(22),
          attendance_days: 22,
          daily_wage: Decimal.new("260"),
          allowance: Decimal.new("300"),
          bonus: Decimal.new("500"),
          loan_deduction: Decimal.new(0),
          remarks: "初始化示例工资单"
        },
        actor
      )

    # 应发 = 22×260 + 300 + 500 = 6520,全额发放(发放日期 D-10)
    {_payment, n1b} =
      SampleData.create!(
        PayrollPayment,
        %{
          payroll_id: p1.id,
          paid_on: SampleData.days_ago(10),
          amount: Decimal.new("6520.00"),
          remarks: "银行代发"
        },
        actor
      )

    {p2, n2} =
      SampleData.create!(
        Payroll,
        %{
          employee_id: master.employees["李秀英"].id,
          month: month,
          workdays: Decimal.new(21),
          attendance_days: 21,
          daily_wage: Decimal.new("220"),
          allowance: Decimal.new("300"),
          loan_deduction: Decimal.new(0),
          remarks: "初始化示例工资单(待发放)"
        },
        actor
      )

    {[p1, p2], n1 ++ n1b ++ n2}
  end

  # ---------------------------------------------------------------------------
  # 增值税发票(销项 + 进项,放最后:金额读自已确认对账单)
  # ---------------------------------------------------------------------------

  # 发票审核强校「价税合计=对账单合计」,故合计从对账行实时读出再填;
  # 审核同事务把常规对账单翻为已结单(close_from_invoice)
  defp seed_vat_invoices!(ctx, master, sales, purchase, actor) do
    c01 = master.customers["C01"]
    s01 = master.suppliers["S01"]

    # 销项:配电箱壳体 50×128 + 汇流铜排组件 20×86.5 = 8130.00(对账行本币合计)
    sal_gross =
      reconciliation_total(SynieCore.Sales.Reconciliation, sales.confirmed_reconciliation)

    {outbound, n1} =
      invoice!(ctx, actor,
        direction: :outbound,
        date_ago: 15,
        party: {:customer, c01},
        invoice_code: "033002400116",
        invoice_no: "04632188",
        seller_name: ctx.company.name,
        buyer_name: c01.name,
        items: [
          {"配电箱壳体", "HN-BX-100 定制", "件", "50", "128.00"},
          {"汇流铜排组件", "HN-BB-08 8 路", "件", "20", "86.50"}
        ],
        gross: sal_gross,
        party_account: ctx.accounts.receivable,
        amount_account: ctx.accounts.revenue,
        tax_account: ctx.accounts.tax,
        link: {:sal_reconciliation_id, sales.confirmed_reconciliation.id},
        remarks: "初始化示例销项发票"
      )

    # 进项:紫铜棒 500×52 + 紫铜排 200×36.8 = 33360.00
    pur_gross =
      reconciliation_total(SynieCore.Purchase.Reconciliation, purchase.confirmed_reconciliation)

    {inbound, n2} =
      invoice!(ctx, actor,
        direction: :inbound,
        date_ago: 10,
        party: {:supplier, s01},
        invoice_code: "033002400205",
        invoice_no: "55209317",
        seller_name: s01.name,
        buyer_name: ctx.company.name,
        items: [
          {"紫铜棒", "T2 φ20", "件", "500", "52.00"},
          {"紫铜排", "T2 3×30×1000", "件", "200", "36.80"}
        ],
        gross: pur_gross,
        party_account: ctx.accounts.payable,
        amount_account: ctx.accounts.inventory,
        tax_account: ctx.accounts.tax,
        link: {:pur_reconciliation_id, purchase.confirmed_reconciliation.id},
        remarks: "初始化示例进项发票"
      )

    {[outbound, inbound], n1 ++ n2}
  end

  # 对账单本币含税合计(行 base_amount 加总,与审核校验同口径)
  defp reconciliation_total(resource, reconciliation) do
    reconciliation.id
    |> resource.load_items()
    |> Enum.map(& &1.base_amount)
    |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
    |> Decimal.round(2)
  end

  defp invoice!(ctx, actor, opts) do
    direction = Keyword.fetch!(opts, :direction)
    {party_type, party} = Keyword.fetch!(opts, :party)
    gross = Keyword.fetch!(opts, :gross)
    {net, tax} = split_vat(gross)
    date = SampleData.days_ago(Keyword.fetch!(opts, :date_ago))
    {link_field, link_id} = Keyword.fetch!(opts, :link)

    attrs = %{
      company_id: ctx.company.id,
      direction: direction,
      invoice_date: date,
      party_type: party_type,
      party_id: party.id,
      invoice_kind: :special,
      invoice_code: Keyword.fetch!(opts, :invoice_code),
      invoice_no: Keyword.fetch!(opts, :invoice_no),
      seller_name: Keyword.fetch!(opts, :seller_name),
      buyer_name: Keyword.fetch!(opts, :buyer_name),
      items: Enum.map(Keyword.fetch!(opts, :items), &invoice_item/1),
      net_total: net,
      tax_total: tax,
      gross_total: gross,
      party_account_id: Keyword.fetch!(opts, :party_account).id,
      amount_account_id: Keyword.fetch!(opts, :amount_account).id,
      tax_account_id: Keyword.fetch!(opts, :tax_account).id,
      remarks: Keyword.fetch!(opts, :remarks)
    }

    {invoice, n1} = SampleData.create!(VatInvoice, Map.put(attrs, link_field, link_id), actor)
    {audited, n2} = SampleData.run_action!(invoice, :audit, %{posting_date: date}, actor)
    {audited, n1 ++ n2}
  end

  # 含税价拆分:未税=含税÷1.13(2 位),税额=含税−未税(恒有 未税+税额=含税,审核强校)
  defp split_vat(gross) do
    net = gross |> Decimal.div(Decimal.add(Decimal.new(1), @vat_rate)) |> Decimal.round(2)
    {net, Decimal.sub(gross, net)}
  end

  # 发票明细行(纯文本档案,不关联物料;字段同前端清单列)
  defp invoice_item({name, model, unit, qty, price}) do
    gross = qty |> Decimal.new() |> Decimal.mult(Decimal.new(price)) |> Decimal.round(2)
    {net, tax} = split_vat(gross)

    %{
      "name" => name,
      "model" => model,
      "unit" => unit,
      "quantity" => qty,
      "price" => price,
      "net_amount" => Decimal.to_string(net),
      "tax_rate" => "13%",
      "tax_amount" => Decimal.to_string(tax)
    }
  end
end
