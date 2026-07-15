defmodule SynieCore.Ocr.AcceptanceMapper do
  @moduledoc """
  RecognizeBankAcceptance 返回(Data 解码后)→ 承兑接收票面草稿字段。
  键为票面草稿 billDraft 的 snake_case 键(见 acceptance/-transaction-drawer.tsx);
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
      "face_amount" => amount(d["totalAmount"]),
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
  end

  # 票面任一字段识别到才断言种类,空结果不带 bill_kind
  defp put_kind(m) when map_size(m) == 0, do: m
  defp put_kind(m), do: Map.put(m, "bill_kind", "BANK_ACCEPTANCE")

  defp transferable(v) when is_binary(v), do: not String.contains?(v, "不")
  defp transferable(_), do: nil
end
