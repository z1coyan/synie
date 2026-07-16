defmodule SynieCore.Acc.ArApReport do
  @moduledoc """
  应收应付报表(GlEntry `:ar_ap_report` 泛型动作实现)。

  纯 GL 时点余额口径(docs/adr/2026-07-16-ar-ap-report.md):截至日前(含)未作废
  分录,按挂了科目角色的科目圈定范围,对手×角色轧差;各角色按自然方向出正数,
  反向余额为负数。存量无对手行汇总为「未指定对手」兜底行(party 全空),
  列合计恒等于圈定科目的账面余额。全零对手行不出。

  返回 map(经 GraphQL 为 json 标量):
  `asOf`、`roleAccounts`(角色→科目清单,前端下钻圈科目用)、`rows`(对手行,
  六角色余额 + netReceivable/netPayable,Decimal 一律转字符串照聚合 action 先例)。
  """

  use Ash.Resource.Actions.Implementation

  require Ash.Query

  alias SynieCore.Acc.GlEntry
  alias SynieCore.Acc.PartyType
  alias SynieCore.Authz.Actor
  alias SynieCore.Base.{Account, AccountRole}

  @impl true
  def run(input, _opts, context) do
    company_id = input.arguments.company_id
    as_of = input.arguments.as_of

    with :ok <- check_company_access(context.actor, company_id) do
      {:ok, build(company_id, as_of)}
    end
  end

  defp build(company_id, as_of) do
    accounts =
      Account
      |> Ash.Query.filter(company_id == ^company_id and not is_nil(role))
      |> Ash.read!(authorize?: false)

    role_by_account = Map.new(accounts, &{&1.id, &1.role})

    balances =
      company_id
      |> read_entries(as_of, Map.keys(role_by_account))
      |> Enum.group_by(&{&1.party_type, &1.party_id})
      |> Enum.map(fn {party, entries} -> {party, sum_roles(entries, role_by_account)} end)
      |> Enum.reject(fn {_party, sums} -> Enum.all?(sums, fn {_role, v} -> zero?(v) end) end)

    labels = party_labels(Enum.map(balances, fn {party, _} -> party end))

    rows =
      balances
      |> Enum.map(fn {{party_type, party_id}, sums} ->
        row(party_type, party_id, sums, labels)
      end)
      |> Enum.sort_by(&{is_nil(&1["partyId"]), &1["partyLabel"]})

    %{
      "asOf" => Date.to_iso8601(as_of),
      "roleAccounts" => role_accounts(accounts),
      "rows" => rows
    }
  end

  defp read_entries(_company_id, _as_of, []), do: []

  defp read_entries(company_id, as_of, account_ids) do
    GlEntry
    |> Ash.Query.filter(
      company_id == ^company_id and posting_date <= ^as_of and is_cancelled == false and
        account_id in ^account_ids
    )
    |> Ash.read!(authorize?: false)
  end

  # 对手在各角色下的余额:按角色自然方向轧差(debit 角色=借−贷,credit 角色=贷−借)
  defp sum_roles(entries, role_by_account) do
    Map.new(AccountRole.values(), fn role ->
      balance =
        entries
        |> Enum.filter(&(role_by_account[&1.account_id] == role))
        |> Enum.reduce(Decimal.new(0), fn e, acc ->
          case AccountRole.natural_direction(role) do
            :debit -> acc |> Decimal.add(e.debit) |> Decimal.sub(e.credit)
            :credit -> acc |> Decimal.add(e.credit) |> Decimal.sub(e.debit)
          end
        end)

      {role, balance}
    end)
  end

  defp row(party_type, party_id, sums, labels) do
    net_receivable =
      sums[:unbilled_receivable]
      |> Decimal.add(sums[:receivable])
      |> Decimal.sub(sums[:advance_received])

    net_payable =
      sums[:unbilled_payable]
      |> Decimal.add(sums[:payable])
      |> Decimal.sub(sums[:advance_paid])

    %{
      "partyType" => party_type && Atom.to_string(party_type),
      "partyId" => party_id,
      "partyLabel" => labels[{party_type, party_id}] || "未指定对手",
      "balances" =>
        Map.new(sums, fn {role, v} -> {camelize(role), Decimal.to_string(v, :normal)} end),
      "netReceivable" => Decimal.to_string(net_receivable, :normal),
      "netPayable" => Decimal.to_string(net_payable, :normal)
    }
  end

  # 角色→挂载科目清单(报表页脚注与下钻圈科目共用)
  defp role_accounts(accounts) do
    accounts
    |> Enum.group_by(& &1.role)
    |> Map.new(fn {role, list} ->
      {camelize(role),
       list
       |> Enum.sort_by(& &1.code)
       |> Enum.map(&%{"id" => &1.id, "code" => &1.code, "name" => &1.name})}
    end)
  end

  # 对手名称回查:按类型分组批量读主数据(照 EmployeeLoan.balances 先例)
  defp party_labels(parties) do
    parties
    |> Enum.reject(fn {type, id} -> is_nil(type) or is_nil(id) end)
    |> Enum.group_by(fn {type, _id} -> type end, fn {_type, id} -> id end)
    |> Enum.flat_map(fn {type, ids} ->
      PartyType.party_resources()[type]
      |> Ash.Query.filter(id in ^ids)
      |> Ash.read!(authorize?: false)
      |> Enum.map(&{{type, &1.id}, &1.name})
    end)
    |> Map.new()
  end

  defp zero?(value), do: Decimal.compare(value, 0) == :eq

  defp camelize(role) do
    [head | rest] = role |> Atom.to_string() |> String.split("_")
    Enum.join([head | Enum.map(rest, &String.capitalize/1)])
  end

  # 泛型动作没有 changeset,公司数据权限手动检查(照 AccountInit 先例,与 CompanyScope 同口径)
  defp check_company_access(nil, _company_id), do: :ok
  defp check_company_access(%Actor{super_admin: true}, _company_id), do: :ok
  defp check_company_access(%Actor{all_companies: true}, _company_id), do: :ok

  defp check_company_access(%Actor{company_ids: ids}, company_id) do
    if company_id in ids do
      :ok
    else
      {:error, Ash.Error.Changes.InvalidChanges.exception(message: "无权查看该公司数据")}
    end
  end
end
