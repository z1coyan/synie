defmodule SynieCore.Sales.MaterialCustomerAllowedTest do
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory}
  alias SynieCore.Sales.{Customer, Quotation, QuotationItem}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    n = System.unique_integer([:positive])

    customer =
      Customer
      |> Ash.Changeset.for_create(:create, %{code: "C#{n}", name: "客户A"})
      |> Ash.create!(authorize?: false)

    other =
      Customer
      |> Ash.Changeset.for_create(:create, %{code: "D#{n}", name: "客户B"})
      |> Ash.create!(authorize?: false)

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "kg#{n}",
        symbol: "kg#{n}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{code: "L#{n}", name: "类"})
      |> Ash.create!(authorize?: false)

    # 物料编号仅自动取号(动作不接受 code),夹具用 seed 直写以保留确定性编号
    general =
      Ash.Seed.seed!(Material, %{
        code: "G-#{n}",
        name: "通用料",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    owned =
      Ash.Seed.seed!(Material, %{
        code: "O-#{n}",
        name: "客户料",
        category_id: leaf.id,
        default_unit_id: kg.id,
        is_customer_material: true,
        customer_id: customer.id
      })

    quotation =
      Quotation
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        party_type: :customer,
        party_id: customer.id,
        quotation_no: "QT-#{n}",
        quotation_date: ~D[2026-07-17],
        valid_until: ~D[2026-08-17]
      })
      |> Ash.create!(authorize?: false)

    company_party_q =
      Quotation
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        party_type: :company,
        party_id: company!().id,
        quotation_no: "QT-CO-#{n}",
        quotation_date: ~D[2026-07-17],
        valid_until: ~D[2026-08-17]
      })
      |> Ash.create!(authorize?: false)

    %{
      company: company,
      customer: customer,
      other: other,
      kg: kg,
      general: general,
      owned: owned,
      quotation: quotation,
      company_party_q: company_party_q
    }
  end

  defp item!(quotation, material, unit) do
    QuotationItem
    |> Ash.Changeset.for_create(:create, %{
      quotation_id: quotation.id,
      idx: 1,
      material_id: material.id,
      unit_id: unit.id,
      price: Decimal.new("1")
    })
    |> Ash.create!(authorize?: false)
  end

  test "通用料可挂任意客户报价", ctx do
    item = item!(ctx.quotation, ctx.general, ctx.kg)
    assert item.material_id == ctx.general.id
  end

  test "本客户料可挂", ctx do
    item = item!(ctx.quotation, ctx.owned, ctx.kg)
    assert item.material_id == ctx.owned.id
  end

  test "他客料拒绝", ctx do
    other_q =
      Quotation
      |> Ash.Changeset.for_create(:create, %{
        company_id: ctx.company.id,
        party_type: :customer,
        party_id: ctx.other.id,
        quotation_no: "QT-X-#{System.unique_integer([:positive])}",
        quotation_date: ~D[2026-07-17],
        valid_until: ~D[2026-08-17]
      })
      |> Ash.create!(authorize?: false)

    assert_raise Ash.Error.Invalid, ~r/非本客户物料/, fn ->
      item!(other_q, ctx.owned, ctx.kg)
    end
  end

  test "内部公司报价拒绝客户料,允许通用料", ctx do
    assert_raise Ash.Error.Invalid, ~r/客户物料不能挂到内部公司/, fn ->
      item!(ctx.company_party_q, ctx.owned, ctx.kg)
    end

    item = item!(ctx.company_party_q, ctx.general, ctx.kg)
    assert item.material_id == ctx.general.id
  end

  test "有条目后不可改对手", ctx do
    _ = item!(ctx.quotation, ctx.general, ctx.kg)

    assert_raise Ash.Error.Invalid, ~r/请先删除报价条目/, fn ->
      ctx.quotation
      |> Ash.Changeset.for_update(:update, %{party_id: ctx.other.id})
      |> Ash.update!(authorize?: false)
    end
  end
end
