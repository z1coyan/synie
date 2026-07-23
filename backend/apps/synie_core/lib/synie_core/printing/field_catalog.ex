defmodule SynieCore.Printing.FieldCatalog do
  @moduledoc """
  打印模板字段清单：Ash 内省自动派生（上传校验与 DocBuilder 装配的同一真相源）。
  全部权限目录资源零代码接入，派生规则一刀切：

    * 公开标量属性、无参公开计算字段、公开聚合进清单；
      排除主键、`*_id` 外键（含 party_id 等多态引用列）、inserted_at/updated_at
    * belongs_to / has_one 展开一层 `关系.字段`（目标侧仅公开标量属性），不再下钻
    * 资源具 party_type/party_id（PartyType 枚举）时派生 `party.name`（对手名称，见 CONTEXT.md「对手」）
    * 每个 has_many 为一个循环区，按关系名寻址（`${items.qty}`）；循环区字段同规则；
      循环区目标资源自身的 has_many 不得再作循环（嵌套，上传即拒）
    * 标签即路径名本身
    * 关系不区分 GraphQL `public?` 标记（打印为后端口径，如 BOM 子表）；
      属性/计算/聚合仍按 `public?` 过滤（防口令散列等敏感字段进入路径展开）
  """

  alias SynieCore.Acc.PartyType
  alias SynieCore.Authz.Registry

  @type field :: %{name: String.t(), label: String.t()}
  @type loop :: %{name: String.t(), label: String.t(), fields: [field()]}
  @type catalog :: %{fields: [field()], loops: [loop()]}

  @doc "可挂打印模板的资源码列表（权限目录全量）。"
  @spec resources() :: [String.t()]
  def resources, do: Registry.resource_modules() |> Map.keys() |> Enum.sort()

  @doc "资源码 → Ash 资源模块；未知返回 nil。"
  @spec module_for(String.t()) :: module() | nil
  def module_for(resource) when is_binary(resource),
    do: Map.get(Registry.resource_modules(), resource)

  @doc "派生字段清单；未知资源返回 nil。"
  @spec get(String.t()) :: catalog() | nil
  def get(resource) when is_binary(resource) do
    case module_for(resource) do
      nil ->
        nil

      module ->
        %{fields: derive_fields(module), loops: derive_loops(module)}
    end
  end

  @doc "允许的头字段名集合（含关联路径与 party.name）；未知资源返回 nil。"
  @spec field_names(String.t()) :: MapSet.t(String.t()) | nil
  def field_names(resource) do
    case module_for(resource) do
      nil -> nil
      module -> module |> derive_fields() |> Enum.map(& &1.name) |> MapSet.new()
    end
  end

  @doc """
  校验占位符集合。`nested` 为点号占位符按首段归组的 map（见 Renderer.extract_placeholders/1）。
  返回 `:ok` 或 `{:error, message}`（中文，点名未知/不支持字段）。`_seq` 视为合法循环区字段。
  """
  @spec validate_placeholders(String.t(), [String.t()], %{String.t() => [String.t()]}) ::
          :ok | {:error, String.t()}
  def validate_placeholders(resource, fields, nested) do
    case module_for(resource) do
      nil ->
        {:error, "不支持的资源类型 #{resource}"}

      module ->
        head = module |> derive_fields() |> Enum.map(& &1.name) |> MapSet.new()
        loops = loop_map(module)

        unknown_head = Enum.reject(fields, &MapSet.member?(head, &1))

        {deep, unknown_head2, unknown_loop, nested_loop} =
          Enum.reduce(nested, {[], [], [], []}, fn {prefix, suffixes}, acc ->
            classify_prefix(prefix, suffixes, head, loops, acc)
          end)

        errors =
          [
            {"未知头字段", unknown_head ++ unknown_head2},
            {"未知循环区字段", unknown_loop},
            {"关联路径只支持一层", deep},
            {"不支持嵌套循环", nested_loop}
          ]
          |> Enum.flat_map(fn
            {_label, []} ->
              []

            {label, names} ->
              ["#{label}: #{names |> Enum.uniq() |> Enum.sort() |> Enum.join(", ")}"]
          end)

        case errors do
          [] -> :ok
          parts -> {:error, Enum.join(parts, "；")}
        end
    end
  end

  ## 派生原语（DocBuilder 复用，保持同一真相源）

  @doc "可打印标量属性（公开、非技术列）。"
  def printable_attributes(module) do
    module
    |> Ash.Resource.Info.public_attributes()
    |> Enum.reject(&technical?(&1, module))
  end

  @doc "可打印计算字段（公开、无参）。"
  def printable_calculations(module) do
    module
    |> Ash.Resource.Info.public_calculations()
    |> Enum.reject(&requires_args?/1)
  end

  @doc "可打印聚合（公开）。"
  def printable_aggregates(module), do: Ash.Resource.Info.public_aggregates(module)

  @doc "单数关联（belongs_to / has_one，不区分 GraphQL public 标记）。"
  def singular_relationships(module) do
    module
    |> Ash.Resource.Info.relationships()
    |> Enum.filter(&(&1.type in [:belongs_to, :has_one]))
  end

  @doc "集合关联（has_many，循环区来源，不区分 GraphQL public 标记）。"
  def many_relationships(module) do
    module
    |> Ash.Resource.Info.relationships()
    |> Enum.filter(&(&1.type == :has_many))
  end

  @doc "资源是否具 Party 多态引用（party_type 为 PartyType 枚举且伴生 party_id）。"
  def party?(module) do
    attrs = Ash.Resource.Info.public_attributes(module)

    Enum.any?(attrs, &(&1.name == :party_id)) and
      Enum.any?(attrs, &(&1.name == :party_type and &1.type == PartyType))
  end

  ## 派生

  # 头字段/循环区字段同一套规则：标量 + 无参计算 + 聚合 + 关联一层路径 + party.name
  defp derive_fields(module) do
    (scalar_field_names(module) ++ rel_path_names(module) ++ party_field_names(module))
    |> Enum.uniq()
    |> Enum.sort()
    |> Enum.map(&%{name: &1, label: &1})
  end

  defp derive_loops(module) do
    module
    |> many_relationships()
    |> Enum.map(fn rel ->
      name = to_string(rel.name)
      %{name: name, label: name, fields: derive_fields(rel.destination)}
    end)
    |> Enum.sort_by(& &1.name)
  end

  defp scalar_field_names(module) do
    (printable_attributes(module) ++
       printable_calculations(module) ++ printable_aggregates(module))
    |> Enum.map(&to_string(&1.name))
  end

  defp rel_path_names(module) do
    module
    |> singular_relationships()
    |> Enum.flat_map(fn rel ->
      rel.destination
      |> printable_attributes()
      |> Enum.map(&"#{rel.name}.#{&1.name}")
    end)
  end

  defp party_field_names(module) do
    if party?(module), do: ["party.name"], else: []
  end

  # 首段为循环区（has_many）→ 循环区字段规则；否则统一按头路径一层规则（belongs_to/party/未知前缀）
  defp classify_prefix(prefix, suffixes, head, loops, {deep, unknown_head, unknown_loop, nested}) do
    case Map.fetch(loops, prefix) do
      {:ok, dest} ->
        dest_loops = dest |> many_relationships() |> Enum.map(&to_string(&1.name))

        {nested_hit, normal} =
          Enum.split_with(suffixes, fn s ->
            s |> first_segment() |> then(&(&1 in dest_loops))
          end)

        allowed =
          dest |> derive_fields() |> Enum.map(& &1.name) |> MapSet.new() |> MapSet.put("_seq")

        unknown = Enum.reject(normal, &MapSet.member?(allowed, &1))

        {deep, unknown_head, unknown_loop ++ Enum.map(unknown, &"#{prefix}.#{&1}"),
         nested ++ Enum.map(nested_hit, &"#{prefix}.#{first_segment(&1)}")}

      :error ->
        Enum.reduce(suffixes, {deep, unknown_head, unknown_loop, nested}, fn suffix, acc ->
          {d, h, l, n} = acc
          full = "#{prefix}.#{suffix}"

          cond do
            String.contains?(suffix, ".") -> {[full | d], h, l, n}
            MapSet.member?(head, full) -> {d, h, l, n}
            true -> {d, [full | h], l, n}
          end
        end)
    end
  end

  defp loop_map(module) do
    module
    |> many_relationships()
    |> Map.new(fn rel -> {to_string(rel.name), rel.destination} end)
  end

  defp technical?(attr, module) do
    attr.name in Ash.Resource.Info.primary_key(module) or
      attr.name in [:inserted_at, :updated_at] or
      String.ends_with?(to_string(attr.name), "_id")
  end

  defp requires_args?(calc), do: calc.arguments != []

  defp first_segment(name), do: name |> String.split(".", parts: 2) |> hd()
end
