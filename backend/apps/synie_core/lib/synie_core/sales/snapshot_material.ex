defmodule SynieCore.Sales.SnapshotMaterial do
  @moduledoc """
  物料信息快照:行保存(create/update)即按当前 material_id/unit_id 重拍
  物料编号/名称/规格/客户料号与单位名称——「行保存即重拍」是定案语义,审核锁行
  即冻结,主数据后续变更不回溯(ADR 2026-07-17-sales-order-item-snapshot)。
  快照属性 writable? false,只能经此 change 写入(force_change_attribute,
  照 ComputeAmount 先例)。物料/单位读不到时跳过,由 MaterialUnitAllowed 与
  外键兜底报错。销售订单条目与报价单条目共用(两者快照列同名)。
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
      |> Ash.Changeset.force_change_attribute(:customer_part_no, material.customer_part_no)
      |> Ash.Changeset.force_change_attribute(:unit_name, unit.name)
    else
      _ -> changeset
    end
  end

  defp get(_resource, nil), do: :error
  defp get(resource, id), do: Ash.get(resource, id, authorize?: false)
end
