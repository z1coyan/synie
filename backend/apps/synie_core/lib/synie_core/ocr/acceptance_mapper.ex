defmodule SynieCore.Ocr.AcceptanceMapper do
  @moduledoc """
  RecognizeBankAcceptance 返回(Data 解码后)→ 承兑接收表单草稿字段。
  票面键为票面草稿 billDraft 的 snake_case 键(见 acceptance/-transaction-drawer.tsx);
  子票区间(subDraftNumber)解析为交易段字段 sub_start/sub_end/amount(金额 =
  (止 − 起 + 1) / 100,分为最小单位),由前端回填交易表单而非票面草稿。
  无子票区间时按整票退化:起 = 1,金额 = 票面金额(totalAmount)。
  票据包金额不再单独映射——承兑均来源于接收,原包金额业务上不关心。
  该接口只识别银行承兑汇票,bill_kind 恒 BANK_ACCEPTANCE。识别不出的键整体省略。
  """

  import SynieCore.Ocr.InvoiceMapper, only: [amount: 1, date: 1, reject_nils: 1, text: 1]

  @doc "映射主入口;兼容返回带/不带 data 嵌套层两种形态。"
  @spec map(map()) :: map()
  def map(%{"data" => data}) when is_map(data), do: map_fields(data)
  def map(data) when is_map(data), do: map_fields(data)

  defp map_fields(d) do
    %{
      "bill_no" => text(d["draftNumber"]),
      "issue_date" => date(d["issueDate"]),
      "due_date" => date(d["validToDate"]),
      "acceptance_date" => date(d["acceptanceDate"]),
      "transferable" => transferable(d["assignability"]),
      "drawer_name" => text(d["issuerName"]),
      "drawer_account" => text(d["issuerAccountNumber"]),
      "drawer_bank_name" => text(d["issuerAccountBank"]),
      "payee_name" => text(d["payeeName"]),
      "payee_account" => text(d["payeeAccountNumber"]),
      "payee_bank_name" => text(d["payeeAccountBank"]),
      "acceptor_name" => text(d["acceptorName"]),
      "acceptor_account" => text(d["acceptorAccountNumber"]),
      "acceptor_bank_name" => text(d["acceptorAccountBank"]),
      "acceptor_bank_no" => text(d["acceptorBankNumber"])
    }
    |> reject_nils()
    |> put_kind()
    |> Map.merge(segment(d))
  end

  # 票面任一字段识别到才断言种类,空结果不带 bill_kind
  defp put_kind(m) when map_size(m) == 0, do: m
  defp put_kind(m), do: Map.put(m, "bill_kind", "BANK_ACCEPTANCE")

  defp transferable(v) when is_binary(v), do: not String.contains?(v, "不")
  defp transferable(_), do: nil

  # 子票区间 → 段三字段;区间缺失/不合法时退化整票(起 = 1,金额 = 票面金额)。
  # 两条路径都同时给出 sub_end,与前端 recalcSeg 勾稽公式一致(止 = 起 + 金额×100 − 1)
  defp segment(d) do
    case parse_range(d["subDraftNumber"]) do
      {start, stop} ->
        %{
          "sub_start" => start,
          "sub_end" => stop,
          "amount" => cents_to_amount(stop - start + 1)
        }

      nil ->
        whole_bill_segment(amount(d["totalAmount"]))
    end
  end

  defp whole_bill_segment(nil), do: %{}

  defp whole_bill_segment(total) do
    cents =
      total |> Decimal.new() |> Decimal.mult(100) |> Decimal.round(0) |> Decimal.to_integer()

    if cents >= 1 do
      %{"sub_start" => 1, "sub_end" => cents, "amount" => total}
    else
      %{}
    end
  rescue
    # amount/1 只保证剩下数字/点/负号,仍可能拼不成合法 Decimal(如多个小数点)
    Decimal.Error -> %{}
  end

  # 区间串取前两段数字(兼容 1-1000000 / 00000001~01000000 / 1至1000000 等分隔),
  # 单个数字视为单张子票(起 = 止)
  defp parse_range(v) when is_binary(v) do
    case Regex.scan(~r/\d+/, v) |> List.flatten() |> Enum.map(&String.to_integer/1) do
      [start, stop | _] when start >= 1 and stop >= start -> {start, stop}
      [only] when only >= 1 -> {only, only}
      _ -> nil
    end
  end

  defp parse_range(_), do: nil

  defp cents_to_amount(cents) do
    cents |> Decimal.new() |> Decimal.div(100) |> Decimal.round(2) |> Decimal.to_string(:normal)
  end
end
