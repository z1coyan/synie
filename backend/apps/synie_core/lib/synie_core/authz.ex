defmodule SynieCore.Authz do
  @moduledoc "权限领域服务:actor 构建与权限判定。"

  require Ash.Query

  alias SynieCore.Authz.{Actor, Permission, Role, RolePermission, UserCompany, UserRole}

  @doc """
  为用户构建请求期 actor,加载权限集(仅启用角色)与授权公司。

  内部读取使用 `authorize?: false`:此时 actor 尚未建立,
  且这些系统表本身受权限保护,属于受信内部路径。
  """
  @spec build_actor(SynieCore.Accounts.User.t()) :: Actor.t()
  def build_actor(user) do
    %Actor{
      user_id: user.id,
      username: to_string(user.username),
      super_admin: user.super_admin,
      all_companies: user.all_companies,
      permissions: load_permissions(user.id),
      company_ids: load_company_ids(user.id)
    }
  end

  @doc "判断 actor 是否拥有权限码(超级管理员恒真;nil actor 恒假)。"
  @spec has_permission?(Actor.t() | nil, String.t()) :: boolean()
  def has_permission?(%Actor{super_admin: true}, _code), do: true
  def has_permission?(%Actor{permissions: perms}, code), do: Permission.matches?(perms, code)
  def has_permission?(nil, _code), do: false

  # ponytail: 每请求 4 条索引查询构建 actor,量大后换 ETS 缓存(key: user_id + 版本号)。
  defp load_permissions(user_id) do
    role_ids =
      UserRole
      |> Ash.Query.filter(user_id == ^user_id)
      |> Ash.read!(authorize?: false)
      |> Enum.map(& &1.role_id)

    enabled_ids =
      Role
      |> Ash.Query.filter(id in ^role_ids and enabled == true)
      |> Ash.read!(authorize?: false)
      |> Enum.map(& &1.id)

    RolePermission
    |> Ash.Query.filter(role_id in ^enabled_ids)
    |> Ash.read!(authorize?: false)
    |> MapSet.new(& &1.permission)
  end

  defp load_company_ids(user_id) do
    UserCompany
    |> Ash.Query.filter(user_id == ^user_id)
    |> Ash.read!(authorize?: false)
    |> Enum.map(& &1.company_id)
  end
end
