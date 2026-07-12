defmodule SynieCore.Acc.VatInvoiceTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.VatInvoice
  alias SynieCore.Authz.Actor
  alias SynieCore.Sales.Customer

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    company = company!()
    customer = customer!()
    %{company: company, customer: customer}
  end

  defp customer!(attrs \\ %{}) do
    attrs =
      Map.merge(%{code: "C#{System.unique_integer([:positive])}", name: "测试客户"}, attrs)

    Customer
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

  # 默认走客户对手(party_type=customer);party_id 显式传参以便个别用例覆盖成内部公司等
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
      items: [%{"name" => "货物A", "qty" => 1}]
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
end
