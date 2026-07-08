defmodule SynieCore.Audit.Track do
  @moduledoc """
  通用审计 change:after_action 中 diff 旧值(`changeset.data`)与动作结果,
  经 `SynieCore.Audit.Log` 的 `:record` 动作同事务写入审计日志。

  - 覆盖全部属性(含非 public),仅跳过主键与时间戳
  - `sensitive? true` 属性记 `"[FILTERED]"`
  - update 无实际变更(no-op)不落日志
  - actor 以动作实际执行时的为准(即便只传给 create!/update!/destroy!,未传给 for_create/for_update/for_destroy 也能取到)
  - 接入方式见 `SynieCore.Audit.Fragment`
  """

  use Ash.Resource.Change

  alias SynieCore.Authz.Actor

  @skip_attrs [:id, :inserted_at, :updated_at]
  @filtered "[FILTERED]"

  @impl true
  def change(changeset, _opts, context) do
    Ash.Changeset.after_action(changeset, fn changeset, result ->
      write_log(changeset, result, context)
      {:ok, result}
    end)
  end

  defp write_log(changeset, result, context) do
    action_type = changeset.action_type
    changes = build_changes(action_type, changeset, result)

    if action_type == :update and changes == %{} do
      :ok
    else
      # 删除动作的属性取值来源是删除前数据
      source = if action_type == :destroy, do: changeset.data, else: result
      current_actor = actor(changeset, context)

      SynieCore.Audit.Log
      |> Ash.Changeset.for_create(:record, %{
        resource: resource_name(changeset.resource),
        record_id: result.id,
        record_label: record_label(changeset.resource, source),
        action_type: to_string(action_type),
        action_name: to_string(changeset.action.name),
        actor_id: actor_id(current_actor),
        actor_name: actor_name(current_actor),
        company_id: company_id(changeset.resource, source),
        changes: changes
      })
      # 受信内部路径:审计写入不做权限检查
      |> Ash.create!(authorize?: false)

      :ok
    end
  end

  # after_action 回调里闭包捕获的 context.actor 是构造 changeset 那一刻的快照;
  # 若 actor 是后来才传给 create!/update!/destroy! 的(未经过 for_create/for_update/
  # for_destroy),该快照仍是 nil。changeset.context.private.actor 由 Ash 在真正
  # 执行动作时用最终 opts 刷新过,因此以它为准,兜底才用闭包里的 context.actor。
  defp actor(changeset, context) do
    get_in(changeset.context, [:private, :actor]) || context.actor
  end

  defp build_changes(:create, changeset, result) do
    collect(changeset.resource, fn attr ->
      case Map.get(result, attr.name) do
        nil -> nil
        value -> %{"to" => dump(attr, value)}
      end
    end)
  end

  defp build_changes(:update, changeset, result) do
    collect(changeset.resource, fn attr ->
      old = Map.get(changeset.data, attr.name)
      new = Map.get(result, attr.name)

      if old != new do
        %{"from" => dump(attr, old), "to" => dump(attr, new)}
      end
    end)
  end

  defp build_changes(:destroy, changeset, _result) do
    collect(changeset.resource, fn attr ->
      case Map.get(changeset.data, attr.name) do
        nil -> nil
        value -> %{"from" => dump(attr, value)}
      end
    end)
  end

  defp collect(resource, fun) do
    resource
    |> Ash.Resource.Info.attributes()
    |> Enum.reject(&(&1.name in @skip_attrs))
    |> Enum.reduce(%{}, fn attr, acc ->
      case fun.(attr) do
        nil -> acc
        entry -> Map.put(acc, to_string(attr.name), entry)
      end
    end)
  end

  defp dump(%{sensitive?: true}, _value), do: @filtered
  defp dump(_attr, value), do: normalize(value)

  # jsonb 可编码值:标量直存,常见结构转字符串,兜底 inspect
  defp normalize(v) when is_binary(v) or is_number(v) or is_boolean(v) or is_nil(v), do: v
  defp normalize(%Ash.CiString{} = v), do: to_string(v)
  defp normalize(%Decimal{} = v), do: Decimal.to_string(v)
  defp normalize(%DateTime{} = v), do: DateTime.to_iso8601(v)
  defp normalize(%NaiveDateTime{} = v), do: NaiveDateTime.to_iso8601(v)
  defp normalize(%Date{} = v), do: Date.to_iso8601(v)
  defp normalize(%_{} = v), do: inspect(v)
  defp normalize(v) when is_atom(v), do: to_string(v)
  defp normalize(v) when is_list(v), do: Enum.map(v, &normalize/1)

  defp normalize(v) when is_map(v),
    do: Map.new(v, fn {k, val} -> {to_string(k), normalize(val)} end)

  # resource 标识用 GraphQL type 名(与前端天然对齐),无 graphql 扩展时退回表名
  defp resource_name(resource) do
    case AshGraphql.Resource.Info.type(resource) do
      nil -> AshPostgres.DataLayer.Info.table(resource)
      type -> to_string(type)
    end
  end

  defp record_label(resource, source) do
    if Ash.Resource.Info.attribute(resource, :name) do
      case Map.get(source, :name) do
        nil -> nil
        label -> to_string(label)
      end
    end
  end

  defp company_id(resource, source) do
    if Ash.Resource.Info.attribute(resource, :company_id) do
      Map.get(source, :company_id)
    end
  end

  defp actor_id(%Actor{user_id: id}), do: id
  defp actor_id(_), do: nil

  defp actor_name(%Actor{username: name}) when not is_nil(name), do: to_string(name)
  defp actor_name(_), do: nil
end
