defmodule SynieCore.Authz.Permission do
  @moduledoc """
  权限码工具。格式:`域.资源:动作`,如 `sales.order:audit`。

  匹配支持通配:`sales.order:*`(该资源全部动作)、`sales.*`(该域全部资源的全部动作)、
  `*`(全域全部权限,仅内部种子使用——如内置 admin 角色,界面不写通配授权)。
  """

  @default_actions ~w(create delete update read print import export batch_delete batch_update batch_print)

  @doc "默认动作集。资源可在 `permission_actions/0` 中增删。"
  @spec default_actions() :: [String.t()]
  def default_actions, do: @default_actions

  @doc "判断权限集(具体码或通配码)是否覆盖给定的具体权限码。"
  @spec matches?(Enumerable.t(), String.t()) :: boolean()
  def matches?(permissions, code) do
    Enum.any?(candidates(code), &(&1 in permissions))
  end

  # "sales.order:audit" 的候选:自身、"sales.order:*"、"sales.*"、"*"
  defp candidates(code) do
    case String.split(code, ":", parts: 2) do
      [prefix, _action] -> [code, prefix <> ":*" | domain_wildcard(prefix) ++ ["*"]]
      _ -> [code, "*"]
    end
  end

  defp domain_wildcard(prefix) do
    case String.split(prefix, ".", parts: 2) do
      [domain, _rest] -> [domain <> ".*"]
      _ -> []
    end
  end
end
