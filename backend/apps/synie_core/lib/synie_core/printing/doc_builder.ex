defmodule SynieCore.Printing.DocBuilder do
  @moduledoc """
  将任意资源记录装配为 Renderer 的 doc：`%{fields: %{}, loops: %{关系名 => [%{}]}}`，值均为字符串。
  取值口径与 FieldCatalog 派生规则同一真相源：标量/计算/聚合直取，belongs_to 一层路径，
  party_type/party_id 解析对手名称，枚举经类型 description 映射中文标签，布尔显示 是/否。
  """

  alias SynieCore.Acc.PartyType
  alias SynieCore.Printing.FieldCatalog

  @spec build(String.t(), struct()) ::
          {:ok, SynieCore.Printing.Renderer.doc()} | {:error, String.t()}
  def build(resource, %_{} = record) when is_binary(resource) do
    case FieldCatalog.module_for(resource) do
      nil ->
        {:error, "不支持的资源类型 #{resource}"}

      module ->
        record = Ash.load!(record, load_list(module), authorize?: false)
        {:ok, %{fields: head_fields(module, record), loops: loop_maps(module, record)}}
    end
  end

  ## 加载清单：单数关联一层 + 无参计算/聚合 + 各 has_many（含其一层单数关联与计算/聚合）

  defp load_list(module) do
    singular = module |> FieldCatalog.singular_relationships() |> Enum.map(& &1.name)
    calc_agg = calc_agg_names(module)

    many =
      module
      |> FieldCatalog.many_relationships()
      |> Enum.map(fn rel ->
        nested =
          (rel.destination |> FieldCatalog.singular_relationships() |> Enum.map(& &1.name)) ++
            calc_agg_names(rel.destination)

        {rel.name, nested}
      end)

    singular ++ calc_agg ++ many
  end

  defp calc_agg_names(module) do
    (FieldCatalog.printable_calculations(module) ++ FieldCatalog.printable_aggregates(module))
    |> Enum.map(& &1.name)
  end

  ## 头字段（对任意资源记录通用；循环区条目复用同一函数）

  defp head_fields(module, record) do
    scalars =
      (FieldCatalog.printable_attributes(module) ++
         FieldCatalog.printable_calculations(module))
      |> Map.new(fn attr ->
        {to_string(attr.name), format(attr.type, Map.get(record, attr.name))}
      end)

    aggs =
      module
      |> FieldCatalog.printable_aggregates()
      |> Map.new(fn agg -> {to_string(agg.name), format(nil, Map.get(record, agg.name))} end)

    paths =
      module
      |> FieldCatalog.singular_relationships()
      |> Map.new(fn rel ->
        related = Map.get(record, rel.name)

        pairs =
          rel.destination
          |> FieldCatalog.printable_attributes()
          |> Enum.map(fn attr ->
            value =
              case related do
                %Ash.NotLoaded{} -> ""
                nil -> ""
                rec -> format(attr.type, Map.get(rec, attr.name))
              end

            {"#{rel.name}.#{attr.name}", value}
          end)

        {rel.name, pairs}
      end)
      |> Enum.flat_map(fn {_rel, pairs} -> pairs end)
      |> Map.new()

    party =
      if FieldCatalog.party?(module) do
        %{"party.name" => party_name(Map.get(record, :party_type), Map.get(record, :party_id))}
      else
        %{}
      end

    Map.merge(scalars, aggs) |> Map.merge(paths) |> Map.merge(party)
  end

  defp loop_maps(module, record) do
    module
    |> FieldCatalog.many_relationships()
    |> Map.new(fn rel ->
      items =
        case Map.get(record, rel.name) do
          %Ash.NotLoaded{} -> []
          nil -> []
          list -> sort_items(rel.destination, list)
        end

      {to_string(rel.name), Enum.map(items, &head_fields(rel.destination, &1))}
    end)
  end

  # 行序：idx（单据行惯例）→ inserted_at → 加载序
  defp sort_items(destination, items) do
    attr_names = destination |> Ash.Resource.Info.attributes() |> Enum.map(& &1.name)

    cond do
      :idx in attr_names -> Enum.sort_by(items, & &1.idx)
      :inserted_at in attr_names -> Enum.sort_by(items, & &1.inserted_at, NaiveDateTime)
      true -> items
    end
  end

  ## Party 解析（统一规则：类型 → 主数据资源 → 名称字段）

  defp party_name(nil, _), do: ""
  defp party_name(_, nil), do: ""

  defp party_name(type, id) do
    case Map.get(PartyType.party_resources(), type) do
      nil ->
        ""

      mod ->
        case Ash.get(mod, id, authorize?: false) do
          {:ok, rec} ->
            cond do
              Map.has_key?(rec, :name) -> rec.name || ""
              Map.has_key?(rec, :label) -> rec.label || ""
              true -> ""
            end

          _ ->
            ""
        end
    end
  rescue
    _ -> ""
  end

  ## 格式化（显示口径统一在这里；显示格式仍由单元格 Excel 格式控制，引擎只管文本值）

  defp format(_type, nil), do: ""

  defp format({:array, inner}, values) when is_list(values),
    do: Enum.map_join(values, ", ", &format(inner, &1))

  defp format(type, value) do
    cond do
      enum_type?(type) -> enum_label(type, value)
      match?(%Date{}, value) -> Date.to_iso8601(value)
      match?(%Time{}, value) -> Time.to_iso8601(value)
      match?(%NaiveDateTime{}, value) -> NaiveDateTime.to_iso8601(value)
      match?(%DateTime{}, value) -> DateTime.to_iso8601(value)
      match?(%Decimal{}, value) -> Decimal.to_string(value)
      is_boolean(value) -> if(value, do: "是", else: "否")
      is_atom(value) -> Atom.to_string(value)
      is_map(value) and not is_struct(value) -> Jason.encode!(value)
      true -> safe_to_string(value)
    end
  end

  # 打印容错从宽:无 String.Chars 实现的罕见类型降级为 inspect,不让单条字段崩掉整次打印
  defp safe_to_string(value) do
    to_string(value)
  rescue
    Protocol.UndefinedError -> inspect(value)
  end

  # Ash.Type.Enum 派生类型带 description/1（本仓库枚举统一 `values: [atom: "中文"]` 写法）
  defp enum_type?(type) do
    is_atom(type) and Code.ensure_loaded?(type) and function_exported?(type, :description, 1)
  end

  defp enum_label(type, value) do
    case type.description(value) do
      nil -> to_string(value)
      label -> label
    end
  rescue
    _ -> to_string(value)
  end
end
