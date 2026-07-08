defmodule SynieCore.Authz.Registry do
  @moduledoc """
  权限点目录:从代码派生(遍历域内声明了 `permission_prefix/0` 的资源),
  不入库。供角色配置界面渲染权限树,以及把通配授权展开为具体码下发前端。
  """

  alias SynieCore.Authz.{Actor, Permission}

  # ponytail: 目前只有一个域;拆多域时把这里改成遍历域列表即可。
  @domains [SynieCore]

  @doc "权限组列表:[%{prefix, actions}]。"
  @spec catalog() :: [%{prefix: String.t(), actions: [String.t()]}]
  def catalog do
    @domains
    |> Enum.flat_map(&Ash.Domain.Info.resources/1)
    |> Enum.filter(&permission_source?/1)
    |> Enum.map(&%{prefix: &1.permission_prefix(), actions: &1.permission_actions()})
  end

  @doc "全部具体权限码。"
  @spec all_codes() :: [String.t()]
  def all_codes do
    for %{prefix: prefix, actions: actions} <- catalog(), action <- actions do
      prefix <> ":" <> action
    end
  end

  @doc "actor 实际生效的具体权限码(通配已展开;super_admin 得到全部)。"
  @spec granted_codes(Actor.t()) :: [String.t()]
  def granted_codes(%Actor{super_admin: true}), do: all_codes()

  def granted_codes(%Actor{permissions: perms}) do
    Enum.filter(all_codes(), &Permission.matches?(perms, &1))
  end

  defp permission_source?(module) do
    Code.ensure_loaded?(module) and function_exported?(module, :permission_prefix, 0)
  end
end
