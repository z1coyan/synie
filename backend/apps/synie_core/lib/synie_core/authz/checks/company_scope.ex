defmodule SynieCore.Authz.Checks.CompanyScope do
  @moduledoc """
  公司维度数据权限(filter check):读取/更新/删除自动限制在
  actor 授权公司范围内。fail-closed:无 actor 或无授权 → 空集。

  仅适用于带 `company_id` 属性的资源;`super_admin` 与 `all_companies` 不受限。
  后续新增数据维度(如部门)时,新写一个同形态的 check,不改本模块。
  """

  use Ash.Policy.FilterCheck

  import Ash.Expr

  alias SynieCore.Authz.Actor

  @impl true
  def describe(_opts), do: "限制在 actor 授权公司范围内"

  @impl true
  def filter(%Actor{super_admin: true}, _authorizer, _opts), do: expr(true)
  def filter(%Actor{all_companies: true}, _authorizer, _opts), do: expr(true)
  def filter(%Actor{company_ids: ids}, _authorizer, _opts), do: expr(company_id in ^ids)
  def filter(_actor, _authorizer, _opts), do: expr(false)
end
