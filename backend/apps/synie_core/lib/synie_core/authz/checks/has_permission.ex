defmodule SynieCore.Authz.Checks.HasPermission do
  @moduledoc """
  通用功能权限 check:由资源的 `permission_prefix/0` 与动作名派生权限码,
  与 actor 权限集(含通配)匹配。

  动作码映射:`:destroy` → `"delete"`;其余动作码即动作名
  (`:read` → `"read"`、`:batch_delete` → `"batch_delete"`、`:audit` → `"audit"`)。
  资源未声明 `permission_prefix/0` 时恒拒绝(fail-closed)。
  """

  use Ash.Policy.SimpleCheck

  alias SynieCore.Authz

  @impl true
  def describe(_opts), do: "actor 拥有当前资源动作的权限码"

  @impl true
  def match?(actor, %{resource: resource, action: action}, _opts) do
    Code.ensure_loaded?(resource) and
      function_exported?(resource, :permission_prefix, 0) and
      Authz.has_permission?(actor, resource.permission_prefix() <> ":" <> action_code(action))
  end

  defp action_code(%{name: :destroy}), do: "delete"
  defp action_code(%{name: name}), do: to_string(name)
end
