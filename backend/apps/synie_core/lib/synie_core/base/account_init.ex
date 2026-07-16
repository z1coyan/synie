defmodule SynieCore.Base.AccountInit do
  @moduledoc """
  从模板初始化公司科目表(`Account` 的 `:init_from_template` 泛型动作实现)。

  目标公司必须尚无科目;动作整体在事务内,失败全回滚。逐条走 `:create`
  动作以便复用校验并留审计,一次性操作(百余条)性能足够。
  """

  use Ash.Resource.Actions.Implementation

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.{Account, AccountTemplates}

  @impl true
  def run(input, _opts, context) do
    company_id = input.arguments.company_id
    template = input.arguments.template

    with :ok <- check_company_access(context.actor, company_id),
         :ok <- check_empty(company_id) do
      count =
        template
        |> AccountTemplates.entries()
        |> Enum.reduce(%{}, fn entry, ids ->
          Map.put(ids, entry.code, create!(entry, ids, company_id, context.actor).id)
        end)
        |> map_size()

      {:ok, count}
    end
  end

  defp create!(entry, ids, company_id, actor) do
    Account
    |> Ash.Changeset.for_create(
      :create,
      %{
        # 模板保证父条目排在子条目之前,parent code 必已入 ids
        parent_id: entry.parent && Map.fetch!(ids, entry.parent),
        code: entry.code,
        name: entry.name,
        direction: entry.direction,
        is_group: entry.is_group,
        role: entry.role,
        company_id: company_id
      },
      actor: actor
    )
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

  defp check_empty(company_id) do
    exists? =
      Account
      |> Ash.Query.filter(company_id == ^company_id)
      |> Ash.exists?(authorize?: false)

    if exists?, do: invalid("该公司已有科目,不能重复初始化"), else: :ok
  end
end
