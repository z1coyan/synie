defmodule SynieCore.Printing.FieldCatalog do
  @moduledoc """
  打印模板字段清单：上传校验与 DocBuilder 装配的同一真相源。
  键为稳定英文标识；label 供管理页展示。
  """

  @type field :: %{name: String.t(), label: String.t()}
  @type catalog :: %{fields: [field()], items: [field()]}

  @catalogs %{
    "sales.order" => %{
      fields: [
        %{name: "order_no", label: "订单号"},
        %{name: "order_date", label: "订单日期"},
        %{name: "order_type", label: "订单类型"},
        %{name: "status", label: "状态"},
        %{name: "company_name", label: "公司名称"},
        %{name: "company_code", label: "公司编号"},
        %{name: "party_name", label: "对手名称"},
        %{name: "party_type", label: "对手类型"},
        %{name: "currency_code", label: "币种"},
        %{name: "exchange_rate", label: "汇率"},
        %{name: "terms", label: "条款"},
        %{name: "remarks", label: "备注"},
        %{name: "gross_total", label: "原币含税总额"},
        %{name: "base_gross_total", label: "本币含税总额"}
      ],
      items: [
        %{name: "material_code", label: "物料编码"},
        %{name: "material_name", label: "物料名称"},
        %{name: "material_spec", label: "规格"},
        %{name: "customer_part_no", label: "客户料号"},
        %{name: "unit_name", label: "单位"},
        %{name: "qty", label: "数量"},
        %{name: "price", label: "单价"},
        %{name: "amount", label: "金额"},
        %{name: "tax_rate", label: "税率"},
        %{name: "remarks", label: "行备注"}
      ]
    },
    "sales.delivery" => %{
      fields: [
        %{name: "delivery_no", label: "发货单号"},
        %{name: "delivery_date", label: "发货日期"},
        %{name: "posting_date", label: "过账日期"},
        %{name: "status", label: "状态"},
        %{name: "company_name", label: "公司名称"},
        %{name: "company_code", label: "公司编号"},
        %{name: "party_name", label: "对手名称"},
        %{name: "party_type", label: "对手类型"},
        %{name: "warehouse_name", label: "仓库"},
        %{name: "remarks", label: "备注"}
      ],
      items: [
        %{name: "material_code", label: "物料编码"},
        %{name: "material_name", label: "物料名称"},
        %{name: "material_spec", label: "规格"},
        %{name: "customer_part_no", label: "客户料号"},
        %{name: "unit_name", label: "单位"},
        %{name: "qty", label: "数量"},
        %{name: "order_no", label: "订单号"},
        %{name: "order_qty", label: "订单数量"},
        %{name: "remarks", label: "行备注"}
      ]
    }
  }

  @doc "已注册可挂打印模板的资源前缀列表。"
  @spec resources() :: [String.t()]
  def resources, do: Map.keys(@catalogs) |> Enum.sort()

  @doc "取资源字段清单；未知资源返回 nil。"
  @spec get(String.t()) :: catalog() | nil
  def get(resource) when is_binary(resource), do: Map.get(@catalogs, resource)

  @doc "允许的头字段名集合（含空校验用）。"
  @spec field_names(String.t()) :: MapSet.t(String.t()) | nil
  def field_names(resource) do
    case get(resource) do
      nil -> nil
      %{fields: fields} -> fields |> Enum.map(& &1.name) |> MapSet.new()
    end
  end

  @doc "允许的明细字段名集合（不含引擎保留 `_seq`）。"
  @spec item_names(String.t()) :: MapSet.t(String.t()) | nil
  def item_names(resource) do
    case get(resource) do
      nil -> nil
      %{items: items} -> items |> Enum.map(& &1.name) |> MapSet.new()
    end
  end

  @doc """
  校验占位符集合。返回 `:ok` 或 `{:error, message}`（中文，点名未知字段）。
  `_seq` 视为合法明细字段。
  """
  @spec validate_placeholders(String.t(), [String.t()], [String.t()]) ::
          :ok | {:error, String.t()}
  def validate_placeholders(resource, fields, items) do
    with {:ok, allowed_f} <- fetch_names(field_names(resource), resource),
         {:ok, allowed_i} <- fetch_names(item_names(resource), resource) do
      allowed_i = MapSet.put(allowed_i, "_seq")
      unknown_f = Enum.reject(fields, &MapSet.member?(allowed_f, &1))
      unknown_i = Enum.reject(items, &MapSet.member?(allowed_i, &1))

      case {unknown_f, unknown_i} do
        {[], []} ->
          :ok

        {uf, ui} ->
          parts =
            []
            |> then(fn acc ->
              if uf == [],
                do: acc,
                else: ["未知头字段: " <> Enum.join(Enum.sort(uf), ", ") | acc]
            end)
            |> then(fn acc ->
              if ui == [],
                do: acc,
                else: ["未知明细字段: " <> Enum.join(Enum.sort(ui), ", ") | acc]
            end)

          {:error, Enum.join(Enum.reverse(parts), "；")}
      end
    end
  end

  defp fetch_names(nil, resource), do: {:error, "不支持的资源类型 #{resource}"}
  defp fetch_names(set, _resource), do: {:ok, set}
end
