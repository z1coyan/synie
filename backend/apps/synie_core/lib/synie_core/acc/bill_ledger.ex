defmodule SynieCore.Acc.BillLedger do
  @moduledoc """
  承兑持有库存引擎:以票据为单位,把该票全部已审核交易按(发生日期, 审核时间)重放,
  逐笔校验子票段合法性并整建 acc_bill_holding。

  不自带事务与锁竞态防护:调用方(交易 audit/void 动作)须在事务内先经 FOR UPDATE
  锁交易行,本模块再锁票据行,同票所有审核/作废串行化。`replay!/1` 必须在调用方
  动作事务内调用——本模块不开启自己的事务。
  """

  require Ash.Query

  alias SynieCore.Acc.{Bill, BillHolding, BillTransaction}

  @consume_types [:endorse, :settle, :discount, :reallocate]

  @doc "重放该票全链并重建持有段;任何一笔不合法 raise ArgumentError(中文,带单号),事务回滚。"
  def replay!(bill_id) do
    bill = lock_bill!(bill_id)

    txs =
      BillTransaction
      |> Ash.Query.filter(bill_id == ^bill_id and status == :audited)
      |> Ash.Query.sort([:occurred_on, :audited_at])
      |> Ash.read!(authorize?: false)

    segs = Enum.reduce(txs, [], &apply_tx(&2, &1))
    rebuild!(bill, segs)
    :ok
  end

  # ── 折叠 ──────────────────────────────────────────────
  # seg = %{company_id, bank_account_id, sub_start, sub_end, acquired_on, source_id}

  defp apply_tx(segs, %{transaction_type: :receive} = tx) do
    conflict = Enum.find(segs, &ranges_overlap?(&1, tx))

    if conflict do
      raise ArgumentError,
            "承兑库存校验失败:交易 #{label(tx)} 接收段 #{tx.sub_start}-#{tx.sub_end} 与现有持有段 " <>
              "#{conflict.sub_start}-#{conflict.sub_end} 重叠(同一子票段不可能被两方同时持有)"
    end

    [new_seg(tx, tx.bank_account_id) | segs]
  end

  defp apply_tx(segs, %{transaction_type: type} = tx) when type in @consume_types do
    {touched, rest} =
      Enum.split_with(segs, fn s ->
        s.company_id == tx.company_id and s.bank_account_id == tx.bank_account_id and
          ranges_overlap?(s, tx)
      end)

    assert_covered!(touched, tx)

    remainders =
      Enum.flat_map(touched, fn s ->
        left = if s.sub_start < tx.sub_start, do: [%{s | sub_end: tx.sub_start - 1}], else: []
        right = if s.sub_end > tx.sub_end, do: [%{s | sub_start: tx.sub_end + 1}], else: []
        left ++ right
      end)

    added = if type == :reallocate, do: [new_seg(tx, tx.to_bank_account_id)], else: []
    added ++ remainders ++ rest
  end

  defp new_seg(tx, account_id) do
    %{
      company_id: tx.company_id,
      bank_account_id: account_id,
      sub_start: tx.sub_start,
      sub_end: tx.sub_end,
      acquired_on: tx.occurred_on,
      source_id: tx.id
    }
  end

  defp ranges_overlap?(a, b), do: a.sub_start <= b.sub_end and b.sub_start <= a.sub_end

  # touched 的并集必须无缝覆盖 [tx.sub_start, tx.sub_end]
  defp assert_covered!(touched, tx) do
    cursor =
      touched
      |> Enum.sort_by(& &1.sub_start)
      |> Enum.reduce(tx.sub_start, fn s, cursor ->
        if s.sub_start > cursor do
          raise ArgumentError,
                "承兑库存校验失败:交易 #{label(tx)} 的子票段 #{cursor}-#{s.sub_start - 1} " <>
                  "在该公司该账户于 #{tx.occurred_on} 并未持有"
        end

        max(cursor, s.sub_end + 1)
      end)

    if cursor <= tx.sub_end do
      raise ArgumentError,
            "承兑库存校验失败:交易 #{label(tx)} 的子票段 #{cursor}-#{tx.sub_end} " <>
              "在该公司该账户于 #{tx.occurred_on} 并未持有"
    end
  end

  # 报错里的交易标识:有单号用单号,否则「发生日期+类型中文」
  defp label(tx) do
    tx.doc_no ||
      "#{tx.occurred_on} #{SynieCore.Acc.BillTransactionType.description(tx.transaction_type)}"
  end

  # ── 重建 ──────────────────────────────────────────────
  defp rebuild!(bill, segs) do
    BillHolding
    |> Ash.Query.filter(bill_id == ^bill.id)
    |> Ash.bulk_destroy!(:destroy, %{}, authorize?: false, return_errors?: true)

    rows =
      Enum.map(segs, fn s ->
        %{
          company_id: s.company_id,
          bank_account_id: s.bank_account_id,
          bill_id: bill.id,
          bill_no: bill.bill_no,
          sub_start: s.sub_start,
          sub_end: s.sub_end,
          amount: Decimal.div(Decimal.new(s.sub_end - s.sub_start + 1), 100),
          due_date: bill.due_date,
          acquired_on: s.acquired_on,
          source_transaction_id: s.source_id
        }
      end)

    %Ash.BulkResult{status: :success} =
      Ash.bulk_create(rows, BillHolding, :rebuild, authorize?: false, return_errors?: true)
  end

  # 票据粒度锁:FOR UPDATE 锁住票据行本身,照 gl_journal.ex 的 lock_journal 写法——
  # 仅在调用方动作的 before_action 钩子内(即动作事务内)调用才有效,锁持有到事务提交,
  # 借此串行化同票的全部审核/作废(replay! 不自带事务,契约见 moduledoc)
  defp lock_bill!(bill_id) do
    case Bill
         |> Ash.Query.filter(id == ^bill_id)
         |> Ash.Query.lock("FOR UPDATE")
         |> Ash.read_one!(authorize?: false) do
      nil -> raise ArgumentError, "承兑库存校验失败:票据 #{bill_id} 不存在"
      bill -> bill
    end
  end
end
