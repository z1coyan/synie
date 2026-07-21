defmodule SynieCore.Sales.CompanyAccountDefaultTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Base.Account
  alias SynieCore.Sales.CompanyAccountDefault

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    debit = account!(company, "1122U", "未开票应收", :unbilled_receivable)
    credit = account!(company, "6001", "主营业务收入", nil)
    receipt_debit = account!(company, "1405", "库存商品", nil)
    receipt_credit = account!(company, "2202U", "未开票应付", :unbilled_payable)

    %{
      company: company,
      debit: debit,
      credit: credit,
      receipt_debit: receipt_debit,
      receipt_credit: receipt_credit
    }
  end

  defp account!(company, code, name, role) do
    Account
    |> Ash.Changeset.for_create(:create, %{
      code: "#{code}-#{System.unique_integer([:positive])}",
      name: name,
      direction: :debit,
      company_id: company.id,
      role: role
    })
    |> Ash.create!(authorize?: false)
  end

  test "一公司一行:合法四槽可保存", ctx do
    row =
      CompanyAccountDefault
      |> Ash.Changeset.for_create(:create, %{
        company_id: ctx.company.id,
        delivery_debit_account_id: ctx.debit.id,
        delivery_credit_account_id: ctx.credit.id,
        receipt_debit_account_id: ctx.receipt_debit.id,
        receipt_credit_account_id: ctx.receipt_credit.id
      })
      |> Ash.create!(authorize?: false)

    assert row.company_id == ctx.company.id
    assert row.delivery_debit_account_id == ctx.debit.id
    assert row.receipt_credit_account_id == ctx.receipt_credit.id

    # 同公司再建冲突
    assert {:error, _} =
             CompanyAccountDefault
             |> Ash.Changeset.for_create(:create, %{company_id: ctx.company.id})
             |> Ash.create(authorize?: false)
  end

  test "四槽均可空", ctx do
    row =
      CompanyAccountDefault
      |> Ash.Changeset.for_create(:create, %{company_id: ctx.company.id})
      |> Ash.create!(authorize?: false)

    assert is_nil(row.delivery_debit_account_id)
    assert is_nil(row.receipt_credit_account_id)
  end

  test "发货借方非未开票应收角色时报错", ctx do
    bad = account!(ctx.company, "1122", "应收账款", :receivable)

    assert {:error, _} =
             CompanyAccountDefault
             |> Ash.Changeset.for_create(:create, %{
               company_id: ctx.company.id,
               delivery_debit_account_id: bad.id
             })
             |> Ash.create(authorize?: false)
  end

  test "入库贷方非未开票应付角色时报错", ctx do
    bad = account!(ctx.company, "2202", "应付账款", :payable)

    assert {:error, _} =
             CompanyAccountDefault
             |> Ash.Changeset.for_create(:create, %{
               company_id: ctx.company.id,
               receipt_credit_account_id: bad.id
             })
             |> Ash.create(authorize?: false)
  end

  test "本 Tab 可只更新发货两槽不覆盖入库", ctx do
    row =
      CompanyAccountDefault
      |> Ash.Changeset.for_create(:create, %{
        company_id: ctx.company.id,
        receipt_debit_account_id: ctx.receipt_debit.id,
        receipt_credit_account_id: ctx.receipt_credit.id
      })
      |> Ash.create!(authorize?: false)

    updated =
      row
      |> Ash.Changeset.for_update(:update, %{
        delivery_debit_account_id: ctx.debit.id,
        delivery_credit_account_id: ctx.credit.id
      })
      |> Ash.update!(authorize?: false)

    assert updated.delivery_debit_account_id == ctx.debit.id
    assert updated.receipt_debit_account_id == ctx.receipt_debit.id
    assert updated.receipt_credit_account_id == ctx.receipt_credit.id
  end

  test "get_for_company/1", ctx do
    assert is_nil(CompanyAccountDefault.get_for_company(ctx.company.id))

    CompanyAccountDefault
    |> Ash.Changeset.for_create(:create, %{
      company_id: ctx.company.id,
      delivery_debit_account_id: ctx.debit.id
    })
    |> Ash.create!(authorize?: false)

    found = CompanyAccountDefault.get_for_company(ctx.company.id)
    assert found.delivery_debit_account_id == ctx.debit.id
  end
end
