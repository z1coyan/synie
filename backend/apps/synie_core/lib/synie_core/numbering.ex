defmodule SynieCore.Numbering do
  @moduledoc """
  单据自动取号入口。规则/计数器资源见 `SynieCore.Numbering.Rule` / `Counter`。

      Numbering.next("acc.gl_journal", company_id: journal.company_id, date: journal.date)
      #=> {:ok, "JA-202607-0001"}

  计数器递增走 PG upsert 原子操作(并发安全、无锁),不过 Ash 不审计——取号本身不留痕,
  单据落库失败会跳号,序号允许有洞(不做回收);页面调整当前值走 Ash update 有审计。
  """

  require Ash.Query

  alias SynieCore.Numbering.Rule

  @doc """
  按规则取下一个编号。opts:

  - `:company_id` — 公司 id,规则按公司计数或模板含 `{company}` 时必传
  - `:date` — 取号日期(决定周期与日期 token),默认当天
  """
  @spec next(String.t(), keyword()) :: {:ok, String.t()} | {:error, :no_rule | String.t()}
  def next(code, opts \\ []) do
    date = opts[:date] || Date.utc_today()

    with {:ok, rule} <- fetch_rule(code),
         {:ok, company_code} <- resolve_company(rule, opts[:company_id]) do
      seq = bump(rule.id, scope_key(company_code, rule.reset_period, date))
      {:ok, render(rule, seq, date, company_code)}
    end
  end

  @spec next!(String.t(), keyword()) :: String.t()
  def next!(code, opts \\ []) do
    case next(code, opts) do
      {:ok, no} -> no
      {:error, reason} -> raise ArgumentError, "取号失败(#{code}): #{inspect(reason)}"
    end
  end

  defp fetch_rule(code) do
    Rule
    |> Ash.Query.filter(code == ^code and enabled == true)
    |> Ash.read_one(authorize?: false)
    |> case do
      {:ok, %Rule{} = rule} -> {:ok, rule}
      _ -> {:error, :no_rule}
    end
  end

  defp resolve_company(rule, company_id) do
    needs? = rule.per_company or String.contains?(rule.format, "{company}")

    cond do
      not needs? ->
        {:ok, nil}

      is_nil(company_id) ->
        {:error, "编号规则 #{rule.code} 按公司取号,缺少公司"}

      true ->
        case Ash.get(SynieCore.Base.Company, company_id, authorize?: false) do
          {:ok, %{code: code}} when is_binary(code) and code != "" -> {:ok, code}
          _ -> {:error, "编号规则 #{rule.code} 按公司取号,公司不存在或无编码"}
        end
    end
  end

  defp scope_key(company_code, period, date) do
    period_part =
      case period do
        :never -> ""
        :yearly -> Calendar.strftime(date, "%Y")
        :monthly -> Calendar.strftime(date, "%Y%m")
        :daily -> Calendar.strftime(date, "%Y%m%d")
      end

    "#{company_code || "-"}|#{period_part}"
  end

  # PG upsert:不存在则插 value=1,存在则原子 +1,RETURNING 拿到本次序号
  defp bump(rule_id, scope_key) do
    now = DateTime.utc_now()

    {1, [%{value: value}]} =
      SynieCore.Repo.insert_all(
        "sys_numbering_counter",
        [
          %{
            id: Ecto.UUID.bingenerate(),
            rule_id: Ecto.UUID.dump!(rule_id),
            scope_key: scope_key,
            value: 1,
            inserted_at: now,
            updated_at: now
          }
        ],
        on_conflict: [inc: [value: 1], set: [updated_at: now]],
        conflict_target: [:rule_id, :scope_key],
        returning: [:value]
      )

    value
  end

  defp render(rule, seq, date, company_code) do
    rule.format
    |> String.replace("{company}", company_code || "")
    |> String.replace("{YYYY}", Calendar.strftime(date, "%Y"))
    |> String.replace("{YY}", Calendar.strftime(date, "%y"))
    |> String.replace("{MM}", Calendar.strftime(date, "%m"))
    |> String.replace("{DD}", Calendar.strftime(date, "%d"))
    |> String.replace("{seq}", seq |> Integer.to_string() |> String.pad_leading(rule.seq_padding, "0"))
  end
end
