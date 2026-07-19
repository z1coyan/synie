defmodule SynieCore.Inv.StockItemUnitAllowed do
  @moduledoc """
  校验库存单据行单位:必须是物料默认单位或该物料单位转换行里的单位——
  任何取值都能折算回默认单位(库存分录只认默认单位,表上无单位字段,
  见 ADR 2026-07-19-stock-ledger)。物料不存在在此一并报出(友好报错,DB 外键兜底)。
  手工出入库单行与调拨单行共用(读 material_id/unit_id 两属性,同销侧 MaterialUnitAllowed 先例)。
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

defmodule SynieCore.Inv.StockItemBaseQty do
  @moduledoc """
  折算数量系统算(库存分录只认物料默认单位),`base_qty` 不允许手改
  (属性 writable? false 兜底,照 OrderItem 金额链先例):
  单位即物料默认单位时 base_qty = qty;否则 base_qty = qty ÷ 该物料转换行
  换算系数(1 默认单位 = factor 该单位),Decimal.round 6 位。

  在 before_action 内取数——此时 SyncDoc 的 FOR UPDATE 已锁住母单
  (changes 声明序在其后,钩子同序执行)。物料/单位/数量读不到时跳过,
  由 StockItemUnitAllowed 与必填校验兜底报错;转换行缺失按同文案报错。
  手工出入库单行与调拨单行共用。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      material_id = Ash.Changeset.get_attribute(cs, :material_id)
      unit_id = Ash.Changeset.get_attribute(cs, :unit_id)
      qty = Ash.Changeset.get_attribute(cs, :qty)

      with false <- is_nil(material_id) or is_nil(unit_id) or is_nil(qty),
           {:ok, material} <- get_material(material_id) do
        if material.default_unit_id == unit_id do
          Ash.Changeset.force_change_attribute(cs, :base_qty, qty)
        else
          case conversion_factor(material_id, unit_id) do
            nil ->
              Ash.Changeset.add_error(cs,
                field: :unit_id,
                message: "单位必须是物料默认单位或其单位转换单位"
              )

            factor ->
              base_qty = qty |> Decimal.div(factor) |> Decimal.round(6)
              Ash.Changeset.force_change_attribute(cs, :base_qty, base_qty)
          end
        end
      else
        _ -> cs
      end
    end)
  end

  defp get_material(material_id) do
    case Ash.get(SynieCore.Inv.Material, material_id, authorize?: false) do
      {:ok, material} -> {:ok, material}
      _ -> :error
    end
  end

  defp conversion_factor(material_id, unit_id) do
    SynieCore.Inv.MaterialUnit
    |> Ash.Query.filter(material_id == ^material_id and unit_id == ^unit_id)
    |> Ash.read_one!(authorize?: false)
    |> case do
      nil -> nil
      conversion -> conversion.factor
    end
  end
end

defmodule SynieCore.Inv.StockItemSnapshot do
  @moduledoc """
  物料信息快照:行保存(create/update)即按当前 material_id/unit_id 重拍
  物料编号/名称/规格与单位名称——「行保存即重拍」是定案语义,审核锁行即冻结,
  主数据后续变更不回溯(同销侧 SnapshotMaterial 先例,库存行无客户料号)。
  快照属性 writable? false,只能经此 change 写入。物料/单位读不到时跳过,
  由 StockItemUnitAllowed 与外键兜底报错。手工出入库单行与调拨单行共用。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    material_id = Ash.Changeset.get_attribute(changeset, :material_id)
    unit_id = Ash.Changeset.get_attribute(changeset, :unit_id)

    with {:ok, material} <- get(SynieCore.Inv.Material, material_id),
         {:ok, unit} <- get(SynieCore.Base.Unit, unit_id) do
      changeset
      |> Ash.Changeset.force_change_attribute(:material_code, material.code)
      |> Ash.Changeset.force_change_attribute(:material_name, material.name)
      |> Ash.Changeset.force_change_attribute(:material_spec, material.spec)
      |> Ash.Changeset.force_change_attribute(:unit_name, unit.name)
    else
      _ -> changeset
    end
  end

  defp get(_resource, nil), do: :error
  defp get(resource, id), do: Ash.get(resource, id, authorize?: false)
end
