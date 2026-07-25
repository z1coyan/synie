defmodule SynieCore.Scm.OrderFlowItemTest do
  @moduledoc """
  订单收发货历史(只读 UNION 视图)测试:透出口径、任一来源码即可读、公司数据权限。
  夹具链(公司/供应商/物料/已审核订单/入库单)照 Purchase.ReceiptTest 先例。
  """

  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz
  alias SynieCore.Base.{Account, Unit}
  alias SynieCore.Inv.{Material, MaterialCategory, Warehouse}
  alias SynieCore.Purchase.{Order, OrderItem, Receipt, ReceiptItem, Supplier}
  alias SynieCore.Scm.OrderFlowItem

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    supplier = supplier!()

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-of#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "F#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material =
      Ash.Seed.seed!(Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "铜杆",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    warehouse =
      Warehouse
      |> Ash.Changeset.for_create(:create, %{name: "收货仓", company_id: company.id})
      |> Ash.create!(authorize?: false)

    debit = account!(company, "1405", "库存商品", nil)
    credit = account!(company, "2202U", "未开票应付", :unbilled_payable)

    {order, order_item} = audited_order!(company, supplier, material, kg)

    receipt =
      Receipt
      |> Ash.Changeset.for_create(:create, %{
        receipt_no: "RN-#{System.unique_integer([:positive])}",
        receipt_date: ~D[2026-07-20],
        company_id: company.id,
        party_type: :supplier,
        party_id: supplier.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })
      |> Ash.create!(authorize?: false)

    receipt_item =
      ReceiptItem
      |> Ash.Changeset.for_create(:create, %{
        receipt_id: receipt.id,
        idx: 1,
        order_item_id: order_item.id,
        material_id: material.id,
        unit_id: kg.id,
        warehouse_id: warehouse.id,
        qty: Decimal.new(3)
      })
      |> Ash.create!(authorize?: false)

    %{
      company: company,
      order: order,
      order_item: order_item,
      receipt: receipt,
      receipt_item: receipt_item
    }
  end

  test "UNION 视图透出采购入库行(类型/单号/日期/状态/快照/数量,按订单过滤)", ctx do
    rows =
      OrderFlowItem
      |> Ash.Query.filter(order_id == ^ctx.order.id)
      |> Ash.read!(authorize?: false)

    assert [%{} = row] = rows
    assert row.id == "purchase_receipt:#{ctx.receipt_item.id}"
    assert row.flow_type == :purchase_receipt
    assert row.voucher_no == ctx.receipt.receipt_no
    assert row.voucher_date == ctx.receipt.receipt_date
    assert row.status == :draft
    assert Decimal.equal?(row.qty, Decimal.new(3))
    assert row.material_name == "铜杆"
    assert row.unit_name == "千克"
    assert row.order_item_id == ctx.order_item.id
    assert row.company_id == ctx.company.id
  end

  test "权限:无任何来源单据 read 权限者读被拒", ctx do
    actor = actor!(ctx.company, [])

    assert_raise Ash.Error.Forbidden, fn ->
      OrderFlowItem |> Ash.Query.filter(order_id == ^ctx.order.id) |> Ash.read!(actor: actor)
    end
  end

  test "权限:持任一来源 read 权限即可读;无公司授权则空集(CompanyScope fail-closed)", ctx do
    actor = actor!(ctx.company, ["purchase.outsourced_issue:read"])

    rows =
      OrderFlowItem
      |> Ash.Query.filter(order_id == ^ctx.order.id)
      |> Ash.read!(actor: actor)

    assert [%{flow_type: :purchase_receipt}] = rows

    no_company_actor = actor!(nil, ["purchase.receipt:read"])

    assert [] =
             OrderFlowItem
             |> Ash.Query.filter(order_id == ^ctx.order.id)
             |> Ash.read!(actor: no_company_actor)
  end

  # 用户+角色+授权码;company 为 nil 时不给公司授权(验证 CompanyScope 空集)
  defp actor!(company, permissions) do
    user = user!()
    role = role!()
    assign!(user, role)
    Enum.each(permissions, &grant!(role, &1))
    if company, do: grant_company!(user, company)
    Authz.build_actor(user)
  end

  defp supplier! do
    Supplier
    |> Ash.Changeset.for_create(:create, %{
      code: "S-#{System.unique_integer([:positive])}",
      name: "测试供应商"
    })
    |> Ash.create!(authorize?: false)
  end

  defp account!(company, code, name, role) do
    Account
    |> Ash.Changeset.for_create(:create, %{
      code: "#{code}-#{System.unique_integer([:positive])}",
      name: name,
      direction: :credit,
      company_id: company.id,
      role: role
    })
    |> Ash.create!(authorize?: false)
  end

  # 零星单自由录价,数量 10、含税单价 100(本币单,双套同值)
  defp audited_order!(company, supplier, material, unit) do
    order =
      Order
      |> Ash.Changeset.for_create(:create, %{
        order_no: "PO-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-17],
        order_type: :spot,
        company_id: company.id,
        party_type: :supplier,
        party_id: supplier.id
      })
      |> Ash.create!(authorize?: false)

    order_item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: material.id,
        unit_id: unit.id,
        qty: Decimal.new(10),
        price: Decimal.new("100.00"),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    {order, order_item}
  end
end
