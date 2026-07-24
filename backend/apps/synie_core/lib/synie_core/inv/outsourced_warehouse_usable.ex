defmodule SynieCore.Inv.OutsourcedWarehouseUsable do
  @moduledoc """
  校验委外单据的外协仓:必须存在、属于单据公司、是外协仓(`is_outsourced`)、
  叶子且启用,且绑定的协作方与单据对手一致(ADR 2026-07-24-outsourced-purchase,
  「委外单据选外协仓时只列绑定当前对手的仓」的后端权威校验)。

  仓停用「拦新不拦旧」与 WarehouseUsable 同口径——新单据保存(create/update)拦截,
  审核/作废不再校验启用位(审核在锁内复检绑定关系与叶子,不过滤停用)。

  固定读 changeset 的 outsourced_warehouse_id/company_id/party_type/party_id 四属性
  (委外单据头直接用)。行资源无对手属性时,
  由行方校验先取母单对手再调 `check/4`(见 Purchase.OutsourcedIssueItem 先例)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    attribute = :outsourced_warehouse_id
    warehouse_id = Ash.Changeset.get_attribute(changeset, attribute)

    # nil 由调用方按必填/可空各自兜底
    if is_nil(warehouse_id) do
      :ok
    else
      company_id = Ash.Changeset.get_attribute(changeset, :company_id)
      party_type = Ash.Changeset.get_attribute(changeset, :party_type)
      party_id = Ash.Changeset.get_attribute(changeset, :party_id)

      case check(warehouse_id, company_id, party_type, party_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: attribute, message: message}
      end
    end
  end

  @doc """
  单仓检查:存在、同公司、外协仓、叶子且启用、绑定协作方与给定对手一致,
  返回 :ok | {:error, 消息}。审核锁内复检(无 changeset)也走此。
  """
  def check(warehouse_id, company_id, party_type, party_id) do
    case Ash.get(SynieCore.Inv.Warehouse, warehouse_id, authorize?: false) do
      {:ok, %{company_id: ^company_id, is_outsourced: false}} ->
        {:error, "仓库不是外协仓"}

      {:ok, %{company_id: ^company_id, is_leaf: false}} ->
        {:error, "只有叶子仓库才能发生库存"}

      {:ok, %{company_id: ^company_id, active: false}} ->
        {:error, "仓库已停用"}

      {:ok, %{company_id: ^company_id, party_type: ^party_type, party_id: ^party_id}} ->
        :ok

      {:ok, %{company_id: ^company_id}} ->
        {:error, "外协仓绑定的协作方与单据对手不一致"}

      {:ok, _warehouse} ->
        {:error, "仓库不属于本公司"}

      {:error, _} ->
        {:error, "仓库不存在"}
    end
  end
end
