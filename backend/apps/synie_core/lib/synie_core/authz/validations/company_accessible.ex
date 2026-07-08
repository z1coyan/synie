defmodule SynieCore.Authz.Validations.CompanyAccessible do
  @moduledoc """
  写入侧公司校验:changeset 的 `company_id` 必须在 actor 授权范围内。

  actor 为 nil 时放行:外部请求先经策略层拦截,能以 nil actor 到达此处的
  只有 `authorize?: false` 的受信内部调用(seeds、后台任务、测试夹具)。
  """

  use Ash.Resource.Validation

  alias SynieCore.Authz.Actor

  @impl true
  def validate(changeset, _opts, %{actor: actor}) do
    case actor do
      nil -> :ok
      %Actor{super_admin: true} -> :ok
      %Actor{all_companies: true} -> :ok
      %Actor{company_ids: ids} -> check_company(changeset, ids)
    end
  end

  defp check_company(changeset, ids) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if company_id in ids do
      :ok
    else
      {:error, field: :company_id, message: "无权在该公司下操作数据"}
    end
  end
end
