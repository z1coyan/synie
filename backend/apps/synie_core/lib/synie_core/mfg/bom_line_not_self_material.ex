defmodule SynieCore.Mfg.BomLineNotSelfMaterial do
  @moduledoc """
  校验 BOM 行(配料行/副产品行)物料:不能等于所属 BOM 的物料自身
  (配料子物料不能是母物料,见 BOM 模块 ADR;多级间接成环不硬校验,树展开检测环)。
  读 changeset 的 bom_id/material_id 两属性,配料行与副产品行共用。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    bom_id = Ash.Changeset.get_attribute(changeset, :bom_id)
    material_id = Ash.Changeset.get_attribute(changeset, :material_id)

    # nil 由 allow_nil? false 兜底报必填
    if is_nil(bom_id) or is_nil(material_id) do
      :ok
    else
      case Ash.get(SynieCore.Mfg.Bom, bom_id, authorize?: false) do
        {:ok, %{material_id: ^material_id}} ->
          {:error, field: :material_id, message: "行物料不能是 BOM 物料自身"}

        {:ok, _} ->
          :ok

        {:error, _} ->
          {:error, field: :bom_id, message: "BOM 不存在"}
      end
    end
  end
end
