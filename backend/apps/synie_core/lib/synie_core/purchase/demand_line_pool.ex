defmodule SynieCore.Purchase.DemandLinePool do
  @moduledoc """
  采购/委外订单「从需求单勾选」池查询(`OrderItem` `:demand_line_pool` 泛型动作)。

  池 = 已确认未关闭未作废需求单 + 行未完成 + 剩余可下单 > 0 + 公司一致 +
  履约方式匹配单据委外标记(外购↔非委外单、委外↔委外单)。

  权限复用 `purchase.order:read`(采购员不必持需求单读权限);公司数据权限手动检查。
  返回带入所需最小字段(json 标量数组,Decimal 转字符串)。
  """

  use Ash.Resource.Actions.Implementation

  require Ash.Query

  alias SynieCore.Authz.Actor

  @impl true
  def run(input, _opts, context) do
    company_id = input.arguments.company_id
    is_outsourced = input.arguments.is_outsourced == true
    method = if is_outsourced, do: :outsource, else: :buy

    with :ok <- check_company_access(context.actor, company_id) do
      items =
        SynieCore.Mfg.DemandItem
        |> Ash.Query.filter(
          company_id == ^company_id and
            fulfillment_method == ^method and
            status != :completed and
            demand.status == :confirmed and
            ordered_qty < base_qty
        )
        |> Ash.Query.load([:demand])
        |> Ash.Query.sort(need_date: :asc, inserted_at: :asc)
        |> Ash.Query.limit(200)
        |> Ash.read!(authorize?: false)

      {:ok, Enum.map(items, &row/1)}
    end
  end

  defp row(item) do
    remaining = Decimal.sub(item.base_qty || Decimal.new(0), item.ordered_qty || Decimal.new(0))

    %{
      "demandLineId" => item.id,
      "demandId" => item.demand_id,
      "demandNo" => item.demand && item.demand.demand_no,
      "materialId" => item.material_id,
      "unitId" => item.unit_id,
      "materialCode" => item.material_code,
      "materialName" => item.material_name,
      "materialSpec" => item.material_spec,
      "unitName" => item.unit_name,
      "qty" => Decimal.to_string(item.qty, :normal),
      "baseQty" => Decimal.to_string(item.base_qty, :normal),
      "orderedQty" => Decimal.to_string(item.ordered_qty || Decimal.new(0), :normal),
      "remainingOrderableQty" => Decimal.to_string(remaining, :normal),
      "needDate" => item.need_date && Date.to_iso8601(item.need_date),
      "fulfillmentMethod" => to_string(item.fulfillment_method)
    }
  end

  defp check_company_access(actor, company_id) do
    if company_accessible?(actor, company_id) do
      :ok
    else
      {:error, Ash.Error.Changes.InvalidChanges.exception(message: "无权查看该公司数据")}
    end
  end

  defp company_accessible?(nil, _company_id), do: true
  defp company_accessible?(%Actor{super_admin: true}, _company_id), do: true
  defp company_accessible?(%Actor{all_companies: true}, _company_id), do: true
  defp company_accessible?(%Actor{company_ids: ids}, company_id), do: company_id in ids
end
