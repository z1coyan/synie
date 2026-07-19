defmodule SynieCore.Inv.StockBalance do
  @moduledoc """
  库存余额表(`StockEntry` `:stock_balance` 泛型动作实现)。

  纯分录聚合口径(ADR 2026-07-19-stock-ledger):公司下未作废分录、业务日期 ≤ 截至日,
  按仓×物料分组 sum(quantity);在途仓作为普通仓自然呈现「在途库存」。可选按仓/物料
  筛选,hide_zero(缺省 true)隐藏零余额行。报表只查分录不查单据,权限复用
  inv.stock_entry:read,公司数据权限在本模块手动检查(同 ArApReport 做法)。

  返回仓×物料聚合行数组(经 GraphQL 为 json 标量,Decimal 一律转字符串照聚合
  action 先例):warehouseId/warehouseName/materialId/materialCode/materialName/
  materialSpec/unitName(物料默认单位名)/quantity,按仓名+物料编号升序。
  """

  use Ash.Resource.Actions.Implementation

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, StockEntry, Warehouse}

  @impl true
  def run(input, _opts, context) do
    company_id = input.arguments.company_id

    with :ok <- check_company_access(context.actor, company_id) do
      {:ok, build(company_id, input.arguments)}
    end
  end

  defp build(company_id, arguments) do
    as_of = Map.get(arguments, :as_of) || Date.utc_today()
    hide_zero = Map.get(arguments, :hide_zero, true)
    hide_zero = if is_nil(hide_zero), do: true, else: hide_zero

    company_id
    |> read_entries(as_of, Map.get(arguments, :warehouse_id), Map.get(arguments, :material_id))
    |> Enum.group_by(&{&1.warehouse_id, &1.material_id}, & &1.quantity)
    |> Enum.map(fn {{warehouse_id, material_id}, quantities} ->
      {warehouse_id, material_id, Enum.reduce(quantities, Decimal.new(0), &Decimal.add/2)}
    end)
    |> Enum.reject(fn {_warehouse_id, _material_id, qty} ->
      hide_zero and Decimal.compare(qty, 0) == :eq
    end)
    |> rows()
  end

  defp read_entries(company_id, as_of, warehouse_id, material_id) do
    StockEntry
    |> Ash.Query.filter(
      company_id == ^company_id and is_cancelled == false and posting_date <= ^as_of
    )
    |> maybe_filter(:warehouse_id, warehouse_id)
    |> maybe_filter(:material_id, material_id)
    |> Ash.read!(authorize?: false)
  end

  defp maybe_filter(query, _field, nil), do: query
  defp maybe_filter(query, :warehouse_id, id), do: Ash.Query.filter(query, warehouse_id == ^id)
  defp maybe_filter(query, :material_id, id), do: Ash.Query.filter(query, material_id == ^id)

  # 名称回查:仓名/物料编号名称规格/默认单位名批量读主数据(照 ArApReport 对手回查先例)
  defp rows([]), do: []

  defp rows(balances) do
    warehouse_ids = balances |> Enum.map(&elem(&1, 0)) |> Enum.uniq()
    material_ids = balances |> Enum.map(&elem(&1, 1)) |> Enum.uniq()

    warehouses =
      Warehouse
      |> Ash.Query.filter(id in ^warehouse_ids)
      |> Ash.read!(authorize?: false)
      |> Map.new(&{&1.id, &1.name})

    materials =
      Material
      |> Ash.Query.filter(id in ^material_ids)
      |> Ash.read!(authorize?: false)
      |> Map.new(&{&1.id, &1})

    unit_names =
      Unit
      |> Ash.Query.filter(id in ^(materials |> Map.values() |> Enum.map(& &1.default_unit_id)))
      |> Ash.read!(authorize?: false)
      |> Map.new(&{&1.id, &1.name})

    balances
    |> Enum.map(fn {warehouse_id, material_id, qty} ->
      material = Map.fetch!(materials, material_id)

      %{
        "warehouseId" => warehouse_id,
        "warehouseName" => Map.fetch!(warehouses, warehouse_id),
        "materialId" => material_id,
        "materialCode" => material.code,
        "materialName" => material.name,
        "materialSpec" => material.spec,
        "unitName" => Map.fetch!(unit_names, material.default_unit_id),
        "quantity" => Decimal.to_string(qty, :normal)
      }
    end)
    |> Enum.sort_by(&{&1["warehouseName"], &1["materialCode"]})
  end

  # 泛型动作没有 changeset,公司数据权限手动检查(同 ArApReport 做法,与 CompanyScope 同口径)
  defp check_company_access(nil, _company_id), do: :ok
  defp check_company_access(%Actor{super_admin: true}, _company_id), do: :ok
  defp check_company_access(%Actor{all_companies: true}, _company_id), do: :ok

  defp check_company_access(%Actor{company_ids: ids}, company_id) do
    if company_id in ids do
      :ok
    else
      {:error, Ash.Error.Changes.InvalidChanges.exception(message: "无权查看该公司数据")}
    end
  end
end
