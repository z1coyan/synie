defmodule SynieCore.Sales.MaterialCustomerAllowed do
  @moduledoc """
  销侧客户物料约束:行上的物料必须是通用料,或客户 = 单据对手客户。
  内部公司对手只能用通用料;对手未定时(不应到此)拒绝客户料。

  销售订单条目与报价单条目共用。依赖父单已由 SyncOrder/SyncQuotation 校验存在;
  读父单 party_type/party_id 与物料 is_customer_material/customer_id。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    material_id = Ash.Changeset.get_attribute(changeset, :material_id)

    if is_nil(material_id) do
      :ok
    else
      with {:ok, material} <- load_material(material_id),
           {:ok, party} <- load_party(changeset) do
        check(material, party)
      end
    end
  end

  defp load_material(material_id) do
    case Ash.get(SynieCore.Inv.Material, material_id, authorize?: false) do
      {:ok, m} -> {:ok, m}
      _ -> {:error, field: :material_id, message: "物料不存在"}
    end
  end

  defp load_party(changeset) do
    case changeset.resource do
      SynieCore.Sales.OrderItem ->
        order_id =
          Ash.Changeset.get_attribute(changeset, :order_id) || Map.get(changeset.data, :order_id)

        case Ash.get(SynieCore.Sales.Order, order_id, authorize?: false) do
          {:ok, %{party_type: t, party_id: id}} -> {:ok, {t, id}}
          _ -> {:error, field: :material_id, message: "订单不存在"}
        end

      SynieCore.Sales.QuotationItem ->
        quotation_id =
          Ash.Changeset.get_attribute(changeset, :quotation_id) ||
            Map.get(changeset.data, :quotation_id)

        case Ash.get(SynieCore.Sales.Quotation, quotation_id, authorize?: false) do
          {:ok, %{party_type: t, party_id: id}} -> {:ok, {t, id}}
          _ -> {:error, field: :material_id, message: "报价单不存在"}
        end

      _ ->
        {:error, field: :material_id, message: "无法校验物料客户约束"}
    end
  end

  defp check(%{is_customer_material: false}, _party), do: :ok

  defp check(%{is_customer_material: true, customer_id: customer_id}, {:customer, party_id})
       when not is_nil(customer_id) and customer_id == party_id,
       do: :ok

  defp check(%{is_customer_material: true}, {:customer, _}),
    do: {:error, field: :material_id, message: "非本客户物料,不能挂到此单据"}

  defp check(%{is_customer_material: true}, _),
    do: {:error, field: :material_id, message: "客户物料不能挂到内部公司单据"}
end
