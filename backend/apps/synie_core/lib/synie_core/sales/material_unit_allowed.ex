defmodule SynieCore.Sales.MaterialUnitAllowed do
  @moduledoc """
  校验行单位:必须是物料默认单位或该物料单位转换行里的单位——
  任何取值都能折算回默认单位,将来发货扣库存不会卡在无法换算的行上。
  物料不存在在此一并报出(友好报错,DB 外键兜底)。
  销售订单条目与报价单条目共用(读 material_id/unit_id 两属性)。
  """

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    material_id = Ash.Changeset.get_attribute(changeset, :material_id)
    unit_id = Ash.Changeset.get_attribute(changeset, :unit_id)

    # nil 由 allow_nil? false 兜底报必填
    if is_nil(material_id) or is_nil(unit_id) do
      :ok
    else
      case Ash.get(SynieCore.Inv.Material, material_id, authorize?: false) do
        {:ok, %{default_unit_id: ^unit_id}} ->
          :ok

        {:ok, _material} ->
          if conversion_exists?(material_id, unit_id) do
            :ok
          else
            {:error, field: :unit_id, message: "单位必须是物料默认单位或其单位转换单位"}
          end

        {:error, _} ->
          {:error, field: :material_id, message: "物料不存在"}
      end
    end
  end

  defp conversion_exists?(material_id, unit_id) do
    SynieCore.Inv.MaterialUnit
    |> Ash.Query.filter(material_id == ^material_id and unit_id == ^unit_id)
    |> Ash.exists?(authorize?: false)
  end
end
