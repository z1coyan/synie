defmodule SynieCore.Ocr.InvoiceMapper do
  @moduledoc """
  RecognizeInvoice 返回(Data 解码后)→ 发票创建抽屉表单字段。
  键为 GraphQL camelCase 字段名;金额纯数字字符串、日期 yyyy-mm-dd;
  识别不出的键整体省略——前端 patchValues 才不会把已填内容清空。
  """

  @doc "映射主入口;兼容返回带/不带 data 嵌套层两种形态。"
  @spec map(map()) :: map()
  def map(%{"data" => data}) when is_map(data), do: map_fields(data)
  def map(data) when is_map(data), do: map_fields(data)

  defp map_fields(d) do
    %{
      "invoiceCode" => text(d["invoiceCode"]),
      "invoiceNo" => text(d["invoiceNumber"]),
      "invoiceDate" => date(d["invoiceDate"]),
      "invoiceKind" => kind(d["invoiceType"]),
      "sellerName" => text(d["sellerName"]),
      "sellerTaxNo" => text(d["sellerTaxNumber"]),
      "sellerAddressPhone" => text(d["sellerContactInfo"]),
      "sellerBankAccount" => text(d["sellerBankAccountInfo"]),
      "buyerName" => text(d["purchaserName"]),
      "buyerTaxNo" => text(d["purchaserTaxNumber"]),
      "buyerAddressPhone" => text(d["purchaserContactInfo"]),
      "buyerBankAccount" => text(d["purchaserBankAccountInfo"]),
      "netTotal" => amount(d["invoiceAmountPreTax"]),
      "taxTotal" => amount(d["invoiceTax"]),
      "grossTotal" => amount(d["totalAmount"]),
      "issuer" => text(d["drawer"]),
      "reviewer" => text(d["reviewer"]),
      "payee" => text(d["recipient"]),
      "remarks" => text(d["remarks"]),
      "items" => items(d["invoiceDetails"])
    }
    |> reject_nils()
  end

  defp items(list) when is_list(list) and list != [] do
    Enum.map(list, fn row ->
      %{
        "name" => text(row["itemName"]),
        "model" => text(row["specification"]),
        "unit" => text(row["unit"]),
        "quantity" => amount(row["quantity"]),
        "price" => amount(row["unitPrice"]),
        "net_amount" => amount(row["amount"]),
        "tax_rate" => text(row["taxRate"]),
        "tax_amount" => amount(row["tax"])
      }
      |> reject_nils()
    end)
  end

  defp items(_), do: nil

  # 发票种类按关键词归类:数电 > 电子 > 纸质;专用/普通二分
  defp kind(t) when is_binary(t) do
    special? = String.contains?(t, "专用")

    cond do
      String.contains?(t, "数电") ->
        if special?, do: "DIGITAL_SPECIAL", else: "DIGITAL_NORMAL"

      String.contains?(t, "电子") ->
        if special?, do: "ELECTRONIC_SPECIAL", else: "ELECTRONIC_NORMAL"

      true ->
        if special?, do: "SPECIAL", else: "NORMAL"
    end
  end

  defp kind(_), do: nil

  @doc false
  def text(v) when is_binary(v) do
    case String.trim(v) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  def text(_), do: nil

  @doc false
  # 金额清洗:去 ¥、千分位逗号、空白,保留数字与小数点/负号
  def amount(v) when is_number(v), do: to_string(v)

  def amount(v) when is_binary(v) do
    case String.replace(v, ~r/[^0-9.\-]/u, "") do
      "" -> nil
      cleaned -> cleaned
    end
  end

  def amount(_), do: nil

  @doc false
  # 日期归一:2026年07月01日 / 2026-07-01 / 2026/07/01 / 20260701 → 2026-07-01
  def date(v) when is_binary(v) do
    digits =
      case Regex.scan(~r/\d+/, v) |> List.flatten() do
        [<<_::binary-size(4)>> = y, m, d | _] -> {y, m, d}
        [<<y::binary-size(4), m::binary-size(2), d::binary-size(2)>>] -> {y, m, d}
        _ -> nil
      end

    with {y, m, d} <- digits,
         {year, ""} <- Integer.parse(y),
         {month, ""} <- Integer.parse(m),
         {day, ""} <- Integer.parse(d),
         {:ok, parsed} <- Date.new(year, month, day) do
      Date.to_iso8601(parsed)
    else
      _ -> nil
    end
  end

  def date(_), do: nil

  @doc false
  def reject_nils(map), do: Map.reject(map, fn {_k, v} -> is_nil(v) end)
end
