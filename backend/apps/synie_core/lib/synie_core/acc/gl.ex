defmodule SynieCore.Acc.GL do
  @moduledoc """
  总账过账模块:业务单据审核/作废统一经此读写分录,勿直接操作 `GlEntry`。

  `validate_entries/2,3` 返回 `{:error, msg}` 供单据动作转成用户可见校验错误;
  `post!/2,3` 内部再校验一遍(纵深防御,未来所有 voucher 共用)后批量插入,
  违规直接抛错——单据侧先调 validate_entries 的正常流程不应触发。
  调用方(单据的审核动作)自带事务,本模块不另开。

  `post!/3` 的 `opts[:allow_negative]` 默认 false,行为与 `post!/2` 完全一致;
  仅 `reverse!/3` 内部生成红字组时放行负数。`reverse!/3` 是通用红冲能力:
  原有效分录组(未作废、未红冲、非红字)取负生成新组并标记 `is_reversal`,
  原组标记 `is_reversed`——供各单据(如发票)的"红冲"动作复用。
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
    %{
      "acc.gl_journal" => {SynieCore.Acc.GlJournal, "凭证"},
      "acc.vat_invoice" => {SynieCore.Acc.VatInvoice, "增值税发票"},
      "acc.bill_transaction" => {SynieCore.Acc.BillTransaction, "承兑交易"}
    }
  end

  @doc """
  校验分录组:行数≥2、每行恰一边非零(默认恰一边大于零,`opts[:allow_negative]`
  放行负数)、借贷配平、对手成对、科目同公司且启用非汇总、挂科目角色的科目
  必须填对手(应收应付报表按对手归属,见 docs/adr/2026-07-16-ar-ap-report.md)。
  """
  def validate_entries(company_id, entries, opts \\ []) do
    with :ok <- check_count(entries),
         :ok <- check_sides(entries, Keyword.get(opts, :allow_negative, false)),
         :ok <- check_balance(entries),
         :ok <- check_party(entries) do
      check_accounts(company_id, entries)
    end
  end

  @doc """
  过账:voucher 需含 `voucher_type/voucher_id/voucher_no/company_id/posting_date`,
  entries 为含 `#{inspect(@entry_keys)}` 的 map 列表(可选 `:is_reversal` 标记红字行)。
  `opts[:allow_negative]` 默认 false 时行为与旧版 `post!/2` 完全一致。
  """
  def post!(voucher, entries, opts \\ []) do
    case validate_entries(voucher.company_id, entries, opts) do
      :ok -> :ok
      {:error, msg} -> raise ArgumentError, "过账校验失败:#{msg}"
    end

    rows =
      Enum.map(entries, fn entry ->
        entry
        |> Map.take(@entry_keys ++ [:is_reversal])
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

  @doc "红冲:原有效分录组取负生成红字组(is_reversal),原组标记 is_reversed(已红冲)。"
  def reverse!(voucher_type, voucher_id, posting_date) do
    originals =
      GlEntry
      |> Ash.Query.filter(
        voucher_type == ^voucher_type and voucher_id == ^voucher_id and
          is_cancelled == false and is_reversed == false and is_reversal == false
      )
      |> Ash.read!(authorize?: false)

    if originals == [], do: raise(ArgumentError, "该单据没有可红冲的分录")

    [first | _] = originals

    red_entries =
      Enum.map(originals, fn e ->
        %{
          account_id: e.account_id,
          currency_id: e.currency_id,
          debit: Decimal.negate(e.debit),
          credit: Decimal.negate(e.credit),
          party_type: e.party_type,
          party_id: e.party_id,
          is_reversal: true,
          remarks: if(e.remarks, do: "红冲:#{e.remarks}", else: "红冲")
        }
      end)

    :ok =
      post!(
        %{
          voucher_type: voucher_type,
          voucher_id: voucher_id,
          voucher_no: first.voucher_no,
          company_id: first.company_id,
          posting_date: posting_date
        },
        red_entries,
        allow_negative: true
      )

    %Ash.BulkResult{status: :success} =
      GlEntry
      |> Ash.Query.filter(id in ^Enum.map(originals, & &1.id))
      |> Ash.bulk_update(:mark_reversed, %{},
        strategy: :atomic,
        authorize?: false,
        return_errors?: true
      )

    :ok
  end

  defp check_count(entries) when length(entries) >= 2, do: :ok
  defp check_count(_entries), do: {:error, "分录不少于两行"}

  defp check_sides(entries, allow_negative?) do
    ok? =
      Enum.all?(entries, fn entry ->
        debit = dec(entry[:debit])
        credit = dec(entry[:credit])

        # 显式拆两个布尔量再异或比较,避免链式 != 的运算优先级读起来费解
        # (mix format 会把纯冗余的分组括号吃掉,故用具名变量而非加括号来提升可读性)
        debit_nonzero? = Decimal.compare(debit, 0) != :eq
        credit_nonzero? = Decimal.compare(credit, 0) != :eq
        single_sided = debit_nonzero? != credit_nonzero?

        if allow_negative? do
          single_sided
        else
          single_sided and Decimal.compare(debit, 0) != :lt and
            Decimal.compare(credit, 0) != :lt
        end
      end)

    if ok? do
      :ok
    else
      {:error, if(allow_negative?, do: "每行借贷必须恰一边非零", else: "每行借贷必须恰一边大于零")}
    end
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
      true -> check_role_party(accounts, entries)
    end
  end

  # 挂了科目角色的科目(应收/应付类往来科目)分录必须带对手,否则应收应付报表无法归属。
  # 红字行豁免:红冲拷贝原行,存量无对手行的红字组与原组在报表兜底行里正好对冲归零
  defp check_role_party(accounts, entries) do
    role_names = accounts |> Enum.filter(& &1.role) |> Map.new(&{&1.id, &1.name})

    missing =
      Enum.find(entries, fn entry ->
        Map.has_key?(role_names, entry[:account_id]) and is_nil(entry[:party_id]) and
          entry[:is_reversal] != true
      end)

    case missing do
      nil -> :ok
      entry -> {:error, "往来科目「#{role_names[entry[:account_id]]}」的分录必须填写对手"}
    end
  end

  defp sum(entries, key) do
    entries |> Enum.map(&dec(&1[key])) |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
  end

  defp dec(nil), do: Decimal.new(0)
  defp dec(value), do: Decimal.new(value)
end
