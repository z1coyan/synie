defmodule SynieCore.Mfg.SalesItemOccupancy do
  @moduledoc """
  销售订单条目占用查询(`DemandItem` `:sales_item_occupancy` 泛型动作实现)。

  需求单勾选池用:给定一组销售订单条目 id,返回各条目订购 base、已被履约需求行
  (未作废需求单上的有来源行,含草稿与已确认)占用的 base、剩余可占用 base。
  权限复用 mfg.demand:read(计划侧不必持销售读权限),公司数据权限在本模块
  手动检查(同 StockBalance 做法,与 CompanyScope 同口径)。

  返回按输入 id 顺序的行数组(经 GraphQL 为 json 标量,Decimal 一律转字符串
  照聚合 action 先例):salesOrderItemId/orderedBaseQty/occupiedBaseQty/
  remainingBaseQty;不存在的条目静默略过。
  """

  use Ash.Resource.Actions.Implementation

  require Ash.Query

  alias SynieCore.Authz.Actor

  @impl true
  def run(input, _opts, context) do
    ids = input.arguments.sales_order_item_ids || []

    items =
      SynieCore.Sales.OrderItem
      |> Ash.Query.filter(id in ^ids)
      |> Ash.read!(authorize?: false)

    with :ok <- check_company_access(context.actor, items) do
      by_id = Map.new(items, &{&1.id, &1})

      rows =
        ids
        |> Enum.map(&Map.get(by_id, &1))
        |> Enum.reject(&is_nil/1)
        |> Enum.map(&row/1)

      {:ok, rows}
    end
  end

  defp row(item) do
    occupied = SynieCore.Mfg.DemandItem.occupied_base_qty(item.id)
    remaining = Decimal.sub(item.base_qty, occupied)

    %{
      "salesOrderItemId" => item.id,
      "orderedBaseQty" => Decimal.to_string(item.base_qty, :normal),
      "occupiedBaseQty" => Decimal.to_string(occupied, :normal),
      "remainingBaseQty" => Decimal.to_string(remaining, :normal)
    }
  end

  # 泛型动作没有 changeset,公司数据权限手动检查(同 StockBalance 做法)
  defp check_company_access(actor, items) do
    if Enum.all?(items, &company_accessible?(actor, &1.company_id)) do
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
