defmodule SynieCore.Inv.WarehouseSeed do
  @moduledoc """
  初始化公司默认仓库(`Warehouse` 的 `:seed_defaults` 泛型动作实现)。

  幂等:该公司已有任意仓库则直接返回 0(不报错)。动作整体在事务内,失败全回滚。
  逐条走 `:create` 动作以便复用校验并留审计。建三仓:根「{code} - 所有仓库」
  (非叶子)下挂「{code} - 默认仓库」「{code} - 在途」两个叶子仓。
  """

  use Ash.Resource.Actions.Implementation

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Company
  alias SynieCore.Inv.Warehouse

  @impl true
  def run(input, _opts, context) do
    company_id = input.arguments.company_id

    with :ok <- check_company_access(context.actor, company_id) do
      if seeded?(company_id) do
        {:ok, 0}
      else
        company = Ash.get!(Company, company_id, authorize?: false)

        root =
          create!(
            %{name: "#{company.code} - 所有仓库", is_leaf: false, company_id: company_id},
            context.actor
          )

        for name <- ["#{company.code} - 默认仓库", "#{company.code} - 在途"] do
          create!(
            %{name: name, is_leaf: true, company_id: company_id, parent_id: root.id},
            context.actor
          )
        end

        {:ok, 3}
      end
    end
  end

  defp create!(attrs, actor) do
    Warehouse
    |> Ash.Changeset.for_create(:create, attrs, actor: actor)
    |> Ash.create!(authorize?: false)
  end

  # 预期业务错误用 InvalidChanges(而非裸字符串),否则 Ash 视作未预期错误并打整段 stacktrace
  defp invalid(msg), do: {:error, Ash.Error.Changes.InvalidChanges.exception(message: msg)}

  # 写侧公司权限,与 CompanyAccessible 同口径(泛型动作没有 changeset,校验挂不上)
  defp check_company_access(nil, _company_id), do: :ok
  defp check_company_access(%Actor{super_admin: true}, _company_id), do: :ok
  defp check_company_access(%Actor{all_companies: true}, _company_id), do: :ok

  defp check_company_access(%Actor{company_ids: ids}, company_id) do
    if company_id in ids, do: :ok, else: invalid("无权在该公司下操作数据")
  end

  defp seeded?(company_id) do
    Warehouse
    |> Ash.Query.filter(company_id == ^company_id)
    |> Ash.exists?(authorize?: false)
  end
end
