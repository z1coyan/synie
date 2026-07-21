defmodule SynieCore.Authz.RolePermissionSync do
  @moduledoc """
  角色授权整组同步(`RolePermission` 的 `:sync` 泛型动作实现)。

  以目标权限码列表为准,事务内 diff 增删;只同步当前权限目录(Registry.catalog)
  内的具体码——存量中的通配码(`资源:*`/`域.*`/`*`)与目录外码原样保留。
  目标码必须全部在目录内,否则整笔拒绝。内置角色由 BuiltinRoleGuard 兜底拒写,
  这里提前查一次以在写入前报错。动作整体在事务内,失败全回滚。
  """

  use Ash.Resource.Actions.Implementation

  require Ash.Query

  alias SynieCore.Authz.{Registry, Role, RolePermission}

  @impl true
  def run(input, _opts, context) do
    role_id = input.arguments.role_id
    target = Enum.uniq(input.arguments.permissions)
    catalog = MapSet.new(Registry.all_codes())

    with :ok <- check_codes(target, catalog),
         :ok <- check_builtin(role_id) do
      existing = for_role(role_id)
      existing_codes = Enum.map(existing, & &1.permission)

      # 只有「目录内的具体码」参与 diff;通配码与目录外码不动
      to_delete =
        Enum.filter(
          existing,
          &(MapSet.member?(catalog, &1.permission) and &1.permission not in target)
        )

      to_add = Enum.filter(target, &(&1 not in existing_codes))

      Enum.each(to_delete, &destroy!(&1, context.actor))
      Enum.each(to_add, &create!(role_id, &1, context.actor))

      {:ok, for_role(role_id) |> Enum.map(& &1.permission) |> Enum.sort()}
    end
  end

  defp for_role(role_id) do
    RolePermission
    |> Ash.Query.filter(role_id == ^role_id)
    |> Ash.read!(authorize?: false)
  end

  defp destroy!(grant, actor) do
    grant
    |> Ash.Changeset.for_destroy(:destroy, %{}, actor: actor)
    |> Ash.destroy!(authorize?: false)
  end

  defp create!(role_id, permission, actor) do
    RolePermission
    |> Ash.Changeset.for_create(:create, %{role_id: role_id, permission: permission},
      actor: actor
    )
    |> Ash.create!(authorize?: false)
  end

  defp check_codes(target, catalog) do
    case Enum.reject(target, &MapSet.member?(catalog, &1)) do
      [] -> :ok
      bad -> invalid("权限码不在权限目录内:#{Enum.join(bad, ", ")}")
    end
  end

  # 与 BuiltinRoleGuard 同口径,提前报错避免部分写入后才被守卫拦下
  defp check_builtin(role_id) do
    if Role
       |> Ash.Query.filter(id == ^role_id and builtin == true)
       |> Ash.exists?(authorize?: false) do
      invalid("内置角色的授权不可增删")
    else
      :ok
    end
  end

  # 预期业务错误用 InvalidChanges(而非裸字符串),否则 Ash 视作未预期错误并打整段 stacktrace
  defp invalid(msg), do: {:error, Ash.Error.Changes.InvalidChanges.exception(message: msg)}
end
