defmodule SynieWeb.GridMeta do
  @moduledoc """
  数据表格元数据:列定义反射 + 当前 actor 能力集 + 扩展动作描述符。

  资源必须在 @resources 白名单注册(信任边界,不做动态模块查找)。
  capabilities 只驱动前端按钮显隐,真正的权限校验在服务端 Ash policy。
  """

  alias SynieCore.Authz

  @resources %{
    "sysRoles" => SynieCore.Authz.Role,
    "basCompanies" => SynieCore.Org.Company
  }

  @spec resolve(String.t(), Authz.Actor.t() | nil) :: {:ok, map()} | {:error, String.t()}
  def resolve(resource_name, actor) do
    case Map.fetch(@resources, resource_name) do
      {:ok, module} -> {:ok, build(module, actor)}
      :error -> {:error, "未知的表格资源: #{resource_name}"}
    end
  end

  def resources, do: @resources

  @doc false
  # 公开仅供白名单 resolve/2 内部调用与测试直接反射(如 GridDoc 测试资源);不构成对外 API。
  def build(module, actor) do
    refs = fk_refs(module, actor)
    rel_descriptions = rel_descriptions(module)

    %{
      columns:
        module
        |> Ash.Resource.Info.public_attributes()
        |> Enum.map(&column(&1, refs, rel_descriptions)),
      capabilities: capabilities(module, actor),
      extended_actions: extended_actions(module),
      destroy_mutation: destroy_mutation(module)
    }
  end

  defp column(attr, refs, rel_descriptions) do
    case Map.fetch(refs, attr.name) do
      {:ok, ref} ->
        %{
          name: camelize(attr.name),
          type: "fk",
          # belongs_to 的 FK attribute 一般没有 description,兜底用关系上的 description
          label: attr.description || ref.label || to_string(attr.name),
          # uuid 排序无意义;筛选走 eq/in(不走 contains,见 filterable?/1 注释)
          sortable: false,
          filterable: true,
          enum_options: nil,
          ref: %{resource: ref.resource, relation: ref.relation, label_field: ref.label_field}
        }

      :error ->
        %{
          name: camelize(attr.name),
          type: type_name(attr.type),
          # FK 列走退化路径(无权限/白名单外)时 label 也要中文,兜底关系 description
          label: attr.description || rel_descriptions[attr.name] || to_string(attr.name),
          sortable: true,
          filterable: filterable?(attr.type),
          enum_options: enum_options(attr.type),
          ref: nil
        }
    end
  end

  # 关系 description 与权限无关,退化路径的列 label 也要有中文兜底
  defp rel_descriptions(module) do
    module
    |> Ash.Resource.Info.relationships()
    |> Enum.filter(&(&1.type == :belongs_to))
    |> Map.new(&{&1.source_attribute, &1.description})
  end

  # belongs_to → fk 元数据。fail-closed:目标资源不在白名单、或 actor 无目标资源 read 权限,
  # 都不产出 ref,该列退化为普通 uuid 列(string/不可筛),前端表单退 TextField。
  defp fk_refs(module, actor) do
    module_names = Map.new(@resources, fn {name, mod} -> {mod, name} end)

    module
    |> Ash.Resource.Info.relationships()
    |> Enum.filter(&(&1.type == :belongs_to))
    |> Enum.reduce(%{}, fn rel, acc ->
      with {:ok, resource_name} <- Map.fetch(module_names, rel.destination),
           true <- Authz.has_permission?(actor, "#{rel.destination.permission_prefix()}:read") do
        Map.put(acc, rel.source_attribute, %{
          resource: resource_name,
          relation: camelize(rel.name),
          label_field: camelize(display_field(rel.destination)),
          label: rel.description
        })
      else
        _ -> acc
      end
    end)
  end

  # 显示字段约定:资源实现 display_field/0 覆盖,默认 :name
  defp display_field(module) do
    if function_exported?(module, :display_field, 0), do: module.display_field(), else: :name
  end

  # AshGraphql 的 contains 筛选只对 string/ci_string 生成;uuid 与裸 atom(非枚举,无 values/0)
  # 若仍标 filterable,跨列搜索/该列筛选会拼出后端不存在的算子,导致整个查询报错。
  # type 映射仍按 string 处理(展示不受影响),sortable 也不变。
  defp filterable?(type), do: type not in [Ash.Type.UUID, Ash.Type.Atom]

  defp capabilities(module, actor) do
    prefix = module.permission_prefix()

    module.permission_actions()
    |> Enum.reject(&(&1 == "read"))
    |> Enum.filter(&Authz.has_permission?(actor, "#{prefix}:#{&1}"))
  end

  defp extended_actions(module) do
    if function_exported?(module, :grid_actions, 0), do: module.grid_actions(), else: []
  end

  defp destroy_mutation(module) do
    AshGraphql.Domain.Info.mutations(SynieCore)
    |> Enum.find(&(&1.resource == module and &1.type == :destroy))
    |> case do
      nil -> nil
      mutation -> camelize(mutation.name)
    end
  end

  defp camelize(name), do: name |> to_string() |> Absinthe.Utils.camelize(lower: true)

  defp type_name(type) do
    cond do
      enum_type?(type) ->
        "enum"

      type in [Ash.Type.Integer] ->
        "integer"

      type in [Ash.Type.Decimal, Ash.Type.Float] ->
        "decimal"

      type in [Ash.Type.Boolean] ->
        "boolean"

      type in [Ash.Type.Date] ->
        "date"

      type in [Ash.Type.UtcDatetime, Ash.Type.UtcDatetimeUsec, Ash.Type.NaiveDatetime] ->
        "datetime"

      true ->
        # string/ci_string/uuid/atom 及未识别类型都按 string 处理(展示与 contains 筛选均适用)
        "string"
    end
  end

  defp enum_type?(type) do
    is_atom(type) and Code.ensure_loaded?(type) and function_exported?(type, :values, 0)
  end

  defp enum_options(type) do
    if enum_type?(type) do
      Enum.map(type.values(), fn value ->
        %{value: to_string(value), label: enum_label(type, value)}
      end)
    end
  end

  defp enum_label(type, value) do
    if function_exported?(type, :description, 1) do
      type.description(value) || to_string(value)
    else
      to_string(value)
    end
  end
end
