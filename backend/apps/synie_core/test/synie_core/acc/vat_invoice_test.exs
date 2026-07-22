defmodule SynieCore.Acc.VatInvoiceTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.{GlEntry, VatInvoice}
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Account
  alias SynieCore.Purchase.{Reconciliation, Supplier}
  alias SynieCore.Sales.Customer

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    customer = customer!()

    accounts = %{
      party: account!(%{code: "1122", name: "应收账款", direction: :debit, company_id: company.id}),
      amount:
        account!(%{code: "6001", name: "主营业务收入", direction: :credit, company_id: company.id}),
      tax:
        account!(%{
          code: "222101",
          name: "应交税费——应交增值税(销项税额)",
          direction: :credit,
          company_id: company.id
        })
    }

    # 开入发票 create/update 必须关联采购对账单(VatInvoiceReconciliationLink);
    # 本模块用例聚焦发票自身,setup 备一张草稿采购对账单供 base_attrs 默认关联
    # (审核五笔/结单/解除关联全链路见 purchase/reconciliation_test.exs)
    supplier =
      Supplier
      |> Ash.Changeset.for_create(:create, %{
        code: "S#{System.unique_integer([:positive])}",
        name: "测试供应商"
      })
      |> Ash.create!(authorize?: false)

    unbilled =
      account!(%{
        code: "2202U",
        name: "未开票应付",
        direction: :credit,
        company_id: company.id,
        role: :unbilled_payable
      })

    pur_recon =
      Reconciliation
      |> Ash.Changeset.for_create(:create, %{
        reconciliation_no: "PR-#{System.unique_integer([:positive])}",
        reconciliation_type: :regular,
        company_id: company.id,
        party_type: :supplier,
        party_id: supplier.id,
        debit_account_id: unbilled.id,
        credit_account_id: accounts.amount.id
      })
      |> Ash.create!(authorize?: false)

    Process.put(:test_pur_recon_id, pur_recon.id)

    %{company: company, customer: customer, accounts: accounts, pur_recon: pur_recon}
  end

  defp customer!(attrs \\ %{}) do
    attrs =
      Map.merge(%{code: "C#{System.unique_integer([:positive])}", name: "测试客户"}, attrs)

    Customer
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
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["acc.vat_invoice:*"])},
      overrides
    )
  end

  defp invoice!(attrs, opts) do
    VatInvoice
    |> Ash.Changeset.for_create(:create, attrs, opts)
    |> Ash.create!(opts)
  end

  # 默认走客户对手(party_type=customer);party_id 显式传参以便个别用例覆盖成内部公司等;
  # direction 默认开入,故默认关联 setup 的草稿采购对账单(开入强制关联)
  defp base_attrs(co, party_id) do
    %{
      company_id: co.id,
      doc_no: "FP-#{System.unique_integer([:positive])}",
      direction: :inbound,
      invoice_date: ~D[2026-07-01],
      party_type: :customer,
      party_id: party_id,
      invoice_kind: :normal,
      invoice_code: "1100",
      invoice_no: "#{System.unique_integer([:positive])}",
      items: [%{"name" => "货物A", "qty" => 1}],
      pur_reconciliation_id: Process.get(:test_pur_recon_id)
    }
  end

  test "创建草稿:状态默认 draft,创建人取 actor", %{company: co, customer: cust} do
    user = user!()
    actor = actor(user_id: user.id, company_ids: [co.id])
    invoice = invoice!(base_attrs(co, cust.id), actor: actor)

    assert invoice.status == :draft
    assert invoice.created_by_id == user.id
  end

  test "对手存在性:party_type=company 时 party_id 必须是公司", %{company: co} do
    other = company!()

    attrs = base_attrs(co, other.id) |> Map.put(:party_type, :company)
    invoice = invoice!(attrs, authorize?: false)
    assert invoice.party_id == other.id

    bad_attrs =
      attrs
      |> Map.put(:party_id, Ash.UUID.generate())
      |> Map.put(:doc_no, "FP-#{System.unique_integer([:positive])}")
      |> Map.put(:invoice_no, "#{System.unique_integer([:positive])}")

    assert_raise Ash.Error.Invalid, fn -> invoice!(bad_attrs, authorize?: false) end
  end

  test "对手不能是本公司自身:create 时 party_type=company 且 party_id=company_id 被拒", %{
    company: co
  } do
    attrs = base_attrs(co, co.id) |> Map.put(:party_type, :company)

    error =
      assert_raise Ash.Error.Invalid, fn -> invoice!(attrs, authorize?: false) end

    assert Exception.message(error) =~ "对手不能是本公司"
  end

  test "对手不能是本公司自身:update 把对手改成本公司被拒", %{company: co, customer: cust} do
    draft = invoice!(base_attrs(co, cust.id), authorize?: false)

    error =
      assert_raise Ash.Error.Invalid, fn ->
        draft
        |> Ash.Changeset.for_update(:update, %{party_type: :company, party_id: co.id})
        |> Ash.update!(authorize?: false)
      end

    assert Exception.message(error) =~ "对手不能是本公司"
  end

  test "开出发票必须关联销售对账单:create 未关联被拒", %{company: co, customer: cust} do
    attrs = base_attrs(co, cust.id) |> Map.put(:direction, :outbound)

    error =
      assert_raise Ash.Error.Invalid, fn -> invoice!(attrs, authorize?: false) end

    assert Exception.message(error) =~ "开出发票必须关联销售对账单"
  end

  test "开出发票必须关联销售对账单:update 改为开出方向未补关联同样被拒", %{
    company: co,
    customer: cust
  } do
    draft = invoice!(base_attrs(co, cust.id), authorize?: false)

    error =
      assert_raise Ash.Error.Invalid, fn ->
        draft
        |> Ash.Changeset.for_update(:update, %{direction: :outbound})
        |> Ash.update!(authorize?: false)
      end

    assert Exception.message(error) =~ "开出发票必须关联销售对账单"
  end

  test "开入发票必须关联采购对账单:create 未关联被拒", %{company: co, customer: cust} do
    attrs = base_attrs(co, cust.id) |> Map.delete(:pur_reconciliation_id)

    error =
      assert_raise Ash.Error.Invalid, fn -> invoice!(attrs, authorize?: false) end

    assert Exception.message(error) =~ "开入发票必须关联采购对账单"
  end

  test "开入发票关联的采购对账单必须存在", %{company: co, customer: cust} do
    attrs =
      base_attrs(co, cust.id) |> Map.put(:pur_reconciliation_id, Ash.UUID.generate())

    error =
      assert_raise Ash.Error.Invalid, fn -> invoice!(attrs, authorize?: false) end

    assert Exception.message(error) =~ "关联的采购对账单不存在"
  end

  defp employee!(attrs \\ %{}) do
    attrs =
      Map.merge(%{code: "E#{System.unique_integer([:positive])}", name: "测试员工"}, attrs)

    SynieCore.Hr.Employee
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  describe "员工对手(费用报销发票)" do
    test "员工对手开入不强制关联采购对账单", %{company: co} do
      employee = employee!()

      attrs =
        base_attrs(co, employee.id)
        |> Map.put(:party_type, :employee)
        |> Map.delete(:pur_reconciliation_id)

      invoice = invoice!(attrs, authorize?: false)
      assert invoice.party_type == :employee
      assert invoice.direction == :inbound
      assert invoice.pur_reconciliation_id == nil
    end

    test "员工对手不允许开出方向", %{company: co} do
      employee = employee!()

      attrs =
        base_attrs(co, employee.id)
        |> Map.merge(%{party_type: :employee, direction: :outbound})
        |> Map.delete(:pur_reconciliation_id)

      error =
        assert_raise Ash.Error.Invalid, fn -> invoice!(attrs, authorize?: false) end

      assert Exception.message(error) =~ "员工对手的发票必须为开入方向"
    end

    test "员工发票关联采购对账单被拒", %{company: co} do
      employee = employee!()

      # base_attrs 默认带采购对账单关联
      attrs = base_attrs(co, employee.id) |> Map.put(:party_type, :employee)

      error =
        assert_raise Ash.Error.Invalid, fn -> invoice!(attrs, authorize?: false) end

      assert Exception.message(error) =~ "费用报销发票不关联对账单"
    end

    test "员工发票关联销售对账单被拒", %{company: co} do
      employee = employee!()

      attrs =
        base_attrs(co, employee.id)
        |> Map.merge(%{party_type: :employee, sal_reconciliation_id: Ash.UUID.generate()})
        |> Map.delete(:pur_reconciliation_id)

      error =
        assert_raise Ash.Error.Invalid, fn -> invoice!(attrs, authorize?: false) end

      assert Exception.message(error) =~ "费用报销发票不关联对账单"
    end
  end

  test "同公司同发票代码+号码重复被唯一索引拒绝", %{company: co, customer: cust} do
    attrs = base_attrs(co, cust.id) |> Map.merge(%{invoice_code: "1100", invoice_no: "00000001"})
    invoice!(attrs, authorize?: false)

    dup_attrs = %{attrs | doc_no: "FP-#{System.unique_integer([:positive])}"}
    assert_raise Ash.Error.Invalid, fn -> invoice!(dup_attrs, authorize?: false) end
  end

  test "数电票(代码空串)同号码判重同样生效", %{company: co, customer: cust} do
    attrs =
      base_attrs(co, cust.id)
      |> Map.merge(%{
        invoice_kind: :digital_normal,
        invoice_code: "",
        invoice_no: "24000000000000000001"
      })

    invoice!(attrs, authorize?: false)

    dup_attrs = %{attrs | doc_no: "FP-#{System.unique_integer([:positive])}"}
    assert_raise Ash.Error.Invalid, fn -> invoice!(dup_attrs, authorize?: false) end
  end

  test "invoice_no 为空的草稿不占唯一坑(可多张)", %{company: co, customer: cust} do
    attrs = base_attrs(co, cust.id) |> Map.delete(:invoice_no)
    first = invoice!(attrs, authorize?: false)

    second =
      invoice!(%{attrs | doc_no: "FP-#{System.unique_integer([:positive])}"}, authorize?: false)

    assert first.invoice_no == nil
    assert second.invoice_no == nil
  end

  test "仅草稿可改可删:手工把 status 置 audited 后 update/destroy 报错", %{
    company: co,
    customer: cust
  } do
    draft = invoice!(base_attrs(co, cust.id), authorize?: false)

    updated =
      draft
      |> Ash.Changeset.for_update(:update, %{remarks: "备注"})
      |> Ash.update!(authorize?: false)

    assert updated.remarks == "备注"

    audited =
      Ash.Seed.seed!(
        VatInvoice,
        Map.merge(base_attrs(co, cust.id), %{
          status: :audited,
          doc_no: "FP-#{System.unique_integer([:positive])}"
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

  test "读取按公司范围过滤 fail-closed", %{company: co, customer: cust} do
    invoice!(base_attrs(co, cust.id), authorize?: false)

    in_scope = actor(company_ids: [co.id])
    out_scope = actor([])

    assert [_] = Ash.read!(VatInvoice, actor: in_scope)
    assert [] = Ash.read!(VatInvoice, actor: out_scope)
  end

  test "items 接受 map 数组并原样读回", %{company: co, customer: cust} do
    items = [
      %{"name" => "货物A", "qty" => 2, "price" => "100.00"},
      %{"name" => "货物B", "qty" => 1}
    ]

    invoice = invoice!(Map.put(base_attrs(co, cust.id), :items, items), authorize?: false)

    assert invoice.items == items
  end

  test "镜像互链:删除镜像草稿后原票 mirror_invoice_id 被外键置空", %{company: co, customer: cust} do
    original = invoice!(base_attrs(co, cust.id), authorize?: false)

    mirror_attrs =
      base_attrs(co, cust.id)
      |> Map.merge(%{
        doc_no: "FP-#{System.unique_integer([:positive])}",
        mirror_invoice_id: original.id
      })

    mirror = invoice!(mirror_attrs, authorize?: false)

    original =
      original
      |> Ash.Changeset.for_update(:update, %{mirror_invoice_id: mirror.id})
      |> Ash.update!(authorize?: false)

    assert original.mirror_invoice_id == mirror.id

    Ash.destroy!(mirror, authorize?: false)

    reloaded = Ash.get!(VatInvoice, original.id, authorize?: false)
    assert reloaded.mirror_invoice_id == nil
  end

  # 齐全的发票属性:三科目 + 勾稽相符的三金额(net 100 + tax 13 = gross 113),direction 默认开出;
  # base_attrs 默认带采购对账单关联(开入强制),开出用例须剔除(两槽互斥,审核按 direction 走 sal 分支)
  defp invoice_attrs(co, cust, accounts, overrides \\ %{}) do
    base_attrs(co, cust.id)
    |> Map.delete(:pur_reconciliation_id)
    |> Map.merge(%{
      direction: :outbound,
      party_account_id: accounts.party.id,
      amount_account_id: accounts.amount.id,
      tax_account_id: accounts.tax.id,
      net_total: Decimal.new("100"),
      tax_total: Decimal.new("13"),
      gross_total: Decimal.new("113")
    })
    |> Map.merge(overrides)
  end

  # 开出发票 create/update 必须关联销售对账单(VatInvoiceReconciliationLink);本模块的审核/作废/
  # 红冲用例聚焦分录生成与状态机,草稿直接 seed 建档(同文件 audited/nil doc_no 种子先例)——
  # 关联对账单的发票全链路(五笔分录/结单/作废红冲解除关联)见 sales/reconciliation_test.exs
  defp seed_invoice!(attrs), do: Ash.Seed.seed!(VatInvoice, attrs)

  defp audit!(inv, posting_date, opts \\ [authorize?: false]) do
    updated =
      inv
      |> Ash.Changeset.for_update(:audit, %{posting_date: posting_date}, opts)
      |> Ash.update!()

    {:ok, updated}
  end

  defp audited_invoice!(co, cust, accounts, overrides \\ %{}) do
    draft = seed_invoice!(invoice_attrs(co, cust, accounts, overrides))
    {:ok, audited} = audit!(draft, ~D[2026-07-15])
    audited
  end

  defp void!(inv, opts \\ [authorize?: false]) do
    inv
    |> Ash.Changeset.for_update(:void, %{}, opts)
    |> Ash.update!()
  end

  defp reverse!(inv, red_invoice_no, posting_date, opts \\ [authorize?: false]) do
    inv
    |> Ash.Changeset.for_update(
      :reverse,
      %{red_invoice_no: red_invoice_no, posting_date: posting_date},
      opts
    )
    |> Ash.update!()
  end

  defp entries_for(voucher_type, voucher_id) do
    GlEntry
    |> Ash.Query.filter(voucher_type == ^voucher_type and voucher_id == ^voucher_id)
    |> Ash.read!(authorize?: false)
  end

  describe "审核过账" do
    test "开出发票审核生成 借往来(带对手)/贷价款/贷税额 三行且配平", %{
      company: co,
      customer: cust,
      accounts: accounts
    } do
      inv = seed_invoice!(invoice_attrs(co, cust, accounts))

      {:ok, audited} = audit!(inv, ~D[2026-07-15])

      assert audited.status == :audited
      assert audited.audited_at != nil

      entries = entries_for("acc.vat_invoice", inv.id)
      assert length(entries) == 3

      party_line = Enum.find(entries, &(&1.account_id == accounts.party.id))
      amount_line = Enum.find(entries, &(&1.account_id == accounts.amount.id))
      tax_line = Enum.find(entries, &(&1.account_id == accounts.tax.id))

      assert Decimal.equal?(party_line.debit, Decimal.new("113"))
      assert Decimal.equal?(party_line.credit, Decimal.new("0"))
      assert party_line.party_type == :customer
      assert party_line.party_id == cust.id

      assert Decimal.equal?(amount_line.debit, Decimal.new("0"))
      assert Decimal.equal?(amount_line.credit, Decimal.new("100"))
      assert amount_line.party_id == nil

      assert Decimal.equal?(tax_line.debit, Decimal.new("0"))
      assert Decimal.equal?(tax_line.credit, Decimal.new("13"))
      assert tax_line.party_id == nil

      debit_total = Enum.reduce(entries, Decimal.new(0), &Decimal.add(&1.debit, &2))
      credit_total = Enum.reduce(entries, Decimal.new(0), &Decimal.add(&1.credit, &2))
      assert Decimal.equal?(debit_total, credit_total)
    end

    test "开入发票审核生成 借价款/借税额/贷往来(带对手) 三行", %{
      company: co,
      customer: cust,
      accounts: accounts
    } do
      # 开入 create 强制关联采购对账单;本用例聚焦 inbound 三分录派生,直接 seed 建档(同 outbound 先例)
      inv =
        invoice_attrs(co, cust, accounts, %{direction: :inbound}) |> seed_invoice!()

      {:ok, audited} = audit!(inv, ~D[2026-07-15])
      assert audited.status == :audited

      entries = entries_for("acc.vat_invoice", inv.id)
      assert length(entries) == 3

      party_line = Enum.find(entries, &(&1.account_id == accounts.party.id))
      amount_line = Enum.find(entries, &(&1.account_id == accounts.amount.id))
      tax_line = Enum.find(entries, &(&1.account_id == accounts.tax.id))

      assert Decimal.equal?(amount_line.debit, Decimal.new("100"))
      assert Decimal.equal?(amount_line.credit, Decimal.new("0"))
      assert amount_line.party_id == nil

      assert Decimal.equal?(tax_line.debit, Decimal.new("13"))
      assert Decimal.equal?(tax_line.credit, Decimal.new("0"))
      assert tax_line.party_id == nil

      assert Decimal.equal?(party_line.debit, Decimal.new("0"))
      assert Decimal.equal?(party_line.credit, Decimal.new("113"))
      assert party_line.party_type == :customer
      assert party_line.party_id == cust.id
    end

    test "税额为 0 只生成两行,税额科目可空", %{company: co, customer: cust, accounts: accounts} do
      inv =
        seed_invoice!(
          invoice_attrs(co, cust, accounts, %{
            tax_account_id: nil,
            net_total: Decimal.new("50"),
            tax_total: Decimal.new("0"),
            gross_total: Decimal.new("50")
          })
        )

      {:ok, audited} = audit!(inv, ~D[2026-07-15])
      assert audited.status == :audited

      entries = entries_for("acc.vat_invoice", inv.id)
      assert length(entries) == 2
      assert Enum.all?(entries, &(&1.account_id in [accounts.party.id, accounts.amount.id]))
    end

    test "审核必填项缺失被拒:无发票号码/无开票日期/勾稽不平(net+tax≠gross)/税额>0 但无税额科目",
         %{company: co, customer: cust, accounts: accounts} do
      no_invoice_no =
        invoice_attrs(co, cust, accounts)
        |> Map.delete(:invoice_no)
        |> seed_invoice!()

      assert_raise Ash.Error.Invalid, ~r/发票号码/, fn -> audit!(no_invoice_no, ~D[2026-07-15]) end

      no_invoice_date =
        invoice_attrs(co, cust, accounts)
        |> Map.delete(:invoice_date)
        |> seed_invoice!()

      assert_raise Ash.Error.Invalid, ~r/开票日期/, fn -> audit!(no_invoice_date, ~D[2026-07-15]) end

      unbalanced =
        seed_invoice!(invoice_attrs(co, cust, accounts, %{gross_total: Decimal.new("999")}))

      assert_raise Ash.Error.Invalid, ~r/未税金额\+税额必须等于价税合计/, fn ->
        audit!(unbalanced, ~D[2026-07-15])
      end

      tax_no_account =
        seed_invoice!(invoice_attrs(co, cust, accounts, %{tax_account_id: nil}))

      assert_raise Ash.Error.Invalid, ~r/税额大于零时必须选择税额科目/, fn ->
        audit!(tax_no_account, ~D[2026-07-15])
      end
    end

    test "审核后 update/destroy 被拒", %{company: co, customer: cust, accounts: accounts} do
      audited = audited_invoice!(co, cust, accounts)

      assert_raise Ash.Error.Invalid, fn ->
        audited
        |> Ash.Changeset.for_update(:update, %{remarks: "x"})
        |> Ash.update!(authorize?: false)
      end

      assert_raise Ash.Error.Invalid, fn -> Ash.destroy!(audited, authorize?: false) end
    end

    test "voucher_no 优先 doc_no,无则用 invoice_no", %{
      company: co,
      customer: cust,
      accounts: accounts
    } do
      with_doc = audited_invoice!(co, cust, accounts)
      entries_a = entries_for("acc.vat_invoice", with_doc.id)
      assert Enum.all?(entries_a, &(&1.voucher_no == with_doc.doc_no))

      seeded =
        Ash.Seed.seed!(
          VatInvoice,
          invoice_attrs(co, cust, accounts, %{doc_no: nil, invoice_no: "SEEDNO001"})
        )

      {:ok, seeded_audited} = audit!(seeded, ~D[2026-07-15])
      assert seeded_audited.doc_no == nil

      entries_b = entries_for("acc.vat_invoice", seeded.id)
      assert Enum.all?(entries_b, &(&1.voucher_no == "SEEDNO001"))
    end
  end

  describe "作废与红冲" do
    test "void:原分录组标记 is_cancelled,发票 voided", %{
      company: co,
      customer: cust,
      accounts: accounts
    } do
      inv = audited_invoice!(co, cust, accounts)

      voided = void!(inv)
      assert voided.status == :voided

      entries = entries_for("acc.vat_invoice", inv.id)
      assert length(entries) == 3
      assert Enum.all?(entries, & &1.is_cancelled)
    end

    test "reverse:红字组生成、原组标 is_reversed,发票 reversed,red_invoice_no 存档", %{
      company: co,
      customer: cust,
      accounts: accounts
    } do
      inv = audited_invoice!(co, cust, accounts)
      actor = actor(company_ids: [co.id])

      inv =
        inv
        |> Ash.Changeset.for_update(
          :reverse,
          %{red_invoice_no: "RED001", posting_date: ~D[2026-07-31]},
          actor: actor
        )
        |> Ash.update!()

      assert inv.status == :reversed
      assert inv.red_invoice_no == "RED001"

      entries = entries_for("acc.vat_invoice", inv.id)
      assert Enum.count(entries, & &1.is_reversal) == Enum.count(entries, & &1.is_reversed)

      assert Decimal.equal?(
               Enum.reduce(entries, Decimal.new(0), &Decimal.add(&1.debit, &2)),
               Decimal.new(0)
             )
    end

    test "void 后不能 reverse,reverse 后不能 void(仅 audited 可操作)", %{
      company: co,
      customer: cust,
      accounts: accounts
    } do
      voided = audited_invoice!(co, cust, accounts) |> void!()

      assert_raise Ash.Error.Invalid, ~r/仅已审核发票可红冲/, fn ->
        reverse!(voided, "RED001", ~D[2026-07-31])
      end

      reversed = audited_invoice!(co, cust, accounts) |> reverse!("RED002", ~D[2026-07-31])

      assert_raise Ash.Error.Invalid, ~r/仅已审核发票可作废/, fn -> void!(reversed) end
    end

    test "草稿不能 void/reverse", %{company: co, customer: cust, accounts: accounts} do
      draft = seed_invoice!(invoice_attrs(co, cust, accounts))

      assert_raise Ash.Error.Invalid, ~r/仅已审核发票可作废/, fn -> void!(draft) end

      assert_raise Ash.Error.Invalid, ~r/仅已审核发票可红冲/, fn ->
        reverse!(draft, "RED003", ~D[2026-07-31])
      end
    end
  end
end
