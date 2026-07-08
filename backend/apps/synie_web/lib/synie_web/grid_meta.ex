defmodule SynieWeb.GridMeta do
  @moduledoc """
  数据表格元数据:列定义反射 + 当前 actor 能力集 + 扩展动作描述符。

  资源必须在 @resources 白名单注册(信任边界,不做动态模块查找)。
  capabilities 只驱动前端按钮显隐,真正的权限校验在服务端 Ash policy。
  """

  alias SynieCore.Authz

  @resources %{
    "sysRoles" => SynieCore.Authz.Role
  }

  @spec resolve(String.t(), Authz.Actor.t() | nil) :: {:ok, map()} | {:error, String.t()}
  def resolve(resource_name, actor) do
    case Map.fetch(@resources, resource_name) do
      {:ok, module} -> {:ok, build(module, actor)}
      :error -> {:error, "未知的表格资源: #{resource_name}"}
    end
  end

  def resources, do: @resources

  defp build(module, actor) do
    %{
      columns: module |> Ash.Resource.Info.public_attributes() |> Enum.map(&column/1),
      capabilities: capabilities(module, actor),
      extended_actions: extended_actions(module),
      destroy_mutation: destroy_mutation(module)
    }
  end

  defp column(attr) do
    %{
      name: camelize(attr.name),
      type: type_name(attr.type),
      label: attr.description || to_string(attr.name),
      sortable: true,
      filterable: true,
      enum_options: enum_options(attr.type)
    }
  end

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
