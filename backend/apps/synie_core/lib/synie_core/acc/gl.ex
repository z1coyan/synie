defmodule SynieCore.Acc.GL do
  @moduledoc """
  总账过账模块:业务单据审核/作废统一经此读写分录,勿直接操作 `GlEntry`。

  `validate_entries/2` 返回 `{:error, msg}` 供单据动作转成用户可见校验错误;
  `post!/2` 内部再校验一遍(纵深防御,未来所有 voucher 共用)后批量插入,
  违规直接抛错——单据侧先调 validate_entries 的正常流程不应触发。
  调用方(单据的审核动作)自带事务,本模块不另开。
  """

  require Ash.Query

  alias SynieCore.Acc.GlEntry
  alias SynieCore.Base.Account

  @entry_keys [:account_id, :currency_id, :debit, :credit, :party_type, :party_id, :remarks]

  @doc """
  voucher_type → {来源单据资源, 中文标签}(GridMeta 多态 fk 反射用)。
  新单据接 GL(调 post!/cancel!)时必须在此注册,分录的来源单据列才能渲染成链接。
  """
  def voucher_resources do
    %{"acc.gl_journal" => {SynieCore.Acc.GlJournal, "凭证"}}
  end

  @doc "校验分录组:行数≥2、每行恰一边>0、借贷配平、对手成对、科目同公司且启用非汇总。"
  def validate_entries(company_id, entries) do
    with :ok <- check_count(entries),
         :ok <- check_sides(entries),
         :ok <- check_balance(entries),
         :ok <- check_party(entries) do
      check_accounts(company_id, entries)
    end
  end

  @doc """
  过账:voucher 需含 `voucher_type/voucher_id/voucher_no/company_id/posting_date`,
  entries 为含 `#{inspect(@entry_keys)}` 的 map 列表。
  """
  def post!(voucher, entries) do
    case validate_entries(voucher.company_id, entries) do
      :ok -> :ok
      {:error, msg} -> raise ArgumentError, "过账校验失败:#{msg}"
    end

    rows =
      Enum.map(entries, fn entry ->
        entry
        |> Map.take(@entry_keys)
        |> Map.merge(%{
          company_id: voucher.company_id,
          posting_date: voucher.posting_date,
          voucher_type: voucher.voucher_type,
          voucher_id: voucher.voucher_id,
          voucher_no: voucher.voucher_no
        })
      end)

    %Ash.BulkResult{status: :success} =
      Ash.bulk_create(rows, GlEntry, :create,
        authorize?: false,
        return_errors?: true,
        stop_on_error?: true
      )

    :ok
  end

  @doc "作废:标记某单据全部分录 `is_cancelled`。"
  def cancel!(voucher_type, voucher_id) do
    %Ash.BulkResult{status: :success} =
      GlEntry
      |> Ash.Query.filter(voucher_type == ^voucher_type and voucher_id == ^voucher_id)
      |> Ash.bulk_update(:mark_cancelled, %{},
        strategy: :atomic,
        authorize?: false,
        return_errors?: true
      )

    :ok
  end

  defp check_count(entries) when length(entries) >= 2, do: :ok
  defp check_count(_entries), do: {:error, "分录不少于两行"}

  defp check_sides(entries) do
    ok? =
      Enum.all?(entries, fn entry ->
        debit = dec(entry[:debit])
        credit = dec(entry[:credit])

        Decimal.compare(debit, 0) != :lt and Decimal.compare(credit, 0) != :lt and
          Decimal.compare(debit, 0) == :gt != (Decimal.compare(credit, 0) == :gt)
      end)

    if ok?, do: :ok, else: {:error, "每行借贷必须恰一边大于零"}
  end

  defp check_balance(entries) do
    if Decimal.equal?(sum(entries, :debit), sum(entries, :credit)),
      do: :ok,
      else: {:error, "借贷不平"}
  end

  defp check_party(entries) do
    ok? = Enum.all?(entries, &(is_nil(&1[:party_type]) == is_nil(&1[:party_id])))
    if ok?, do: :ok, else: {:error, "对手类型与对手必须同时填写"}
  end

  defp check_accounts(company_id, entries) do
    ids = entries |> Enum.map(& &1[:account_id]) |> Enum.uniq()

    accounts =
      Account
      |> Ash.Query.filter(id in ^ids)
      |> Ash.read!(authorize?: false)

    found = MapSet.new(accounts, & &1.id)

    cond do
      Enum.any?(ids, &(not MapSet.member?(found, &1))) -> {:error, "科目不存在"}
      Enum.any?(accounts, &(&1.company_id != company_id)) -> {:error, "科目必须属于单据公司"}
      Enum.any?(accounts, & &1.is_group) -> {:error, "汇总科目不能入账"}
      Enum.any?(accounts, &(not &1.active)) -> {:error, "停用科目不能入账"}
      true -> :ok
    end
  end

  defp sum(entries, key) do
    entries |> Enum.map(&dec(&1[key])) |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
  end

  defp dec(nil), do: Decimal.new(0)
  defp dec(value), do: Decimal.new(value)
end
