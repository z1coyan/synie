defmodule SynieCore.Printing.DocBuilder do
  @moduledoc """
  将业务单据装配为 Renderer 的 doc：`%{fields: %{}, items: [%{}]}`，值均为字符串。
  """

  alias SynieCore.Acc.PartyType
  alias SynieCore.Base.Company
  alias SynieCore.Purchase.Supplier
  alias SynieCore.Sales.Customer
  alias SynieCore.Sales.Delivery
  alias SynieCore.Sales.DeliveryItem
  alias SynieCore.Sales.Order
  alias SynieCore.Sales.OrderItem

  @spec build(String.t(), struct()) ::
          {:ok, SynieCore.Printing.Renderer.doc()} | {:error, String.t()}
  def build("sales.order", %Order{} = order) do
    order =
      Ash.load!(order, [:company, :currency, :items, :gross_total, :base_gross_total],
        authorize?: false
      )

    party_name = party_name(order.party_type, order.party_id)

    fields = %{
      "order_no" => s(order.order_no),
      "order_date" => s(order.order_date),
      "order_type" => enum_label(order.order_type),
      "status" => enum_label(order.status),
      "company_name" => s(order.company && order.company.name),
      "company_code" => s(order.company && order.company.code),
      "party_name" => s(party_name),
      "party_type" => enum_label(order.party_type),
      "currency_code" => s(order.currency && order.currency.code),
      "exchange_rate" => s(order.exchange_rate),
      "terms" => s(order.terms),
      "remarks" => s(order.remarks),
      "gross_total" => s(order.gross_total),
      "base_gross_total" => s(order.base_gross_total)
    }

    items =
      order.items
      |> Enum.sort_by(& &1.idx)
      |> Enum.map(fn %OrderItem{} = it ->
        %{
          "material_code" => s(it.material_code),
          "material_name" => s(it.material_name),
          "material_spec" => s(it.material_spec),
          "customer_part_no" => s(it.customer_part_no),
          "unit_name" => s(it.unit_name),
          "qty" => s(it.qty),
          "price" => s(it.price),
          "amount" => s(it.amount),
          "tax_rate" => s(it.tax_rate),
          "remarks" => s(it.remarks)
        }
      end)

    {:ok, %{fields: fields, items: items}}
  end

  def build("sales.delivery", %Delivery{} = delivery) do
    delivery =
      Ash.load!(delivery, [:company, :warehouse, :items], authorize?: false)

    party_name = party_name(delivery.party_type, delivery.party_id)

    fields = %{
      "delivery_no" => s(delivery.delivery_no),
      "delivery_date" => s(delivery.delivery_date),
      "posting_date" => s(delivery.posting_date),
      "status" => enum_label(delivery.status),
      "company_name" => s(delivery.company && delivery.company.name),
      "company_code" => s(delivery.company && delivery.company.code),
      "party_name" => s(party_name),
      "party_type" => enum_label(delivery.party_type),
      "warehouse_name" => s(delivery.warehouse && delivery.warehouse.name),
      "remarks" => s(delivery.remarks)
    }

    items =
      delivery.items
      |> Enum.sort_by(& &1.idx)
      |> Enum.map(fn %DeliveryItem{} = it ->
        %{
          "material_code" => s(it.material_code),
          "material_name" => s(it.material_name),
          "material_spec" => s(it.material_spec),
          "customer_part_no" => s(it.customer_part_no),
          "unit_name" => s(it.unit_name),
          "qty" => s(it.qty),
          "order_no" => s(it.order_no),
          "order_qty" => s(it.order_qty),
          "remarks" => s(it.remarks)
        }
      end)

    {:ok, %{fields: fields, items: items}}
  end

  def build(resource, _), do: {:error, "不支持的资源类型 #{resource}"}

  defp party_name(nil, _), do: ""
  defp party_name(_, nil), do: ""

  defp party_name(type, id) do
    resources = PartyType.party_resources()

    mod =
      case type do
        :customer -> Map.get(resources, :customer) || Customer
        :company -> Map.get(resources, :company) || Company
        :supplier -> Map.get(resources, :supplier) || Supplier
        other when is_atom(other) -> Map.get(resources, other)
        _ -> nil
      end

    if mod do
      case Ash.get(mod, id, authorize?: false) do
        {:ok, rec} ->
          cond do
            Map.has_key?(rec, :name) -> rec.name
            Map.has_key?(rec, :label) -> rec.label
            true -> ""
          end

        _ ->
          ""
      end
    else
      ""
    end
  rescue
    _ -> ""
  end

  defp s(nil), do: ""
  defp s(%Date{} = d), do: Date.to_iso8601(d)
  defp s(%Decimal{} = d), do: Decimal.to_string(d)
  defp s(v) when is_atom(v), do: enum_label(v)
  defp s(v), do: to_string(v)

  defp enum_label(nil), do: ""

  defp enum_label(v) when is_atom(v) do
    Map.get(
      %{
        draft: "草稿",
        audited: "已审核",
        closed: "已关闭",
        voided: "已作废",
        regular: "常规订单",
        sample: "样品订单",
        supplier: "供应商",
        customer: "客户",
        company: "内部公司",
        employee: "员工"
      },
      v,
      Atom.to_string(v)
    )
  end

  defp enum_label(v), do: to_string(v)
end
