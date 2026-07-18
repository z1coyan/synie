defmodule SynieCore.Sales.QuotationLink do
  @moduledoc """
  常规订单行↔报价条目的链接校验与梯度套价:行构建期派生(`OrderItem.DeriveQuotation`)
  与订单审核复核(`Order.VerifyItems`)共用同一套判定,保证「建行怎么派、审核就怎么复」。

  链接有效性 = 报价单已审核 + 订单日期落在报价区间(含两端) + 公司/对手/币种与订单一致;
  梯度套价 = 起订量 ≤ 行数量的最高档价,低于首档起订量视为无报价(同 QuotationTier 语义)。
  全部受信内部读(authorize?: false),供 changeset 构建期与 before_action 复核使用。
  """

  require Ash.Query

  alias SynieCore.Sales.{Quotation, QuotationItem, QuotationTier}

  @doc "读报价条目及其报价单;任一不存在返回 :error。"
  @spec load_item(term()) :: {:ok, QuotationItem.t(), Quotation.t()} | :error
  def load_item(nil), do: :error

  def load_item(quotation_item_id) do
    with {:ok, %QuotationItem{} = item} <-
           Ash.get(QuotationItem, quotation_item_id, authorize?: false),
         {:ok, %Quotation{} = quotation} <-
           Ash.get(Quotation, item.quotation_id, authorize?: false) do
      {:ok, item, quotation}
    else
      _ -> :error
    end
  end

  @doc "链接有效性逐项判定;返回 :ok 或 {:error, 中文原因}。"
  @spec check(map(), Quotation.t()) :: :ok | {:error, String.t()}
  def check(order, quotation) do
    cond do
      quotation.status != :audited ->
        {:error, "报价单未审核或已作废"}

      Date.compare(order.order_date, quotation.quotation_date) == :lt ->
        {:error, "订单日期不在报价有效期内"}

      Date.compare(order.order_date, quotation.valid_until) == :gt ->
        {:error, "订单日期不在报价有效期内"}

      quotation.company_id != order.company_id ->
        {:error, "报价与订单公司不一致"}

      quotation.party_type != order.party_type or quotation.party_id != order.party_id ->
        {:error, "报价与订单对手不一致"}

      quotation.currency_id != order.currency_id ->
        {:error, "报价与订单币种不一致"}

      true ->
        :ok
    end
  end

  @doc "数量套档:起订量 ≤ 数量的最高档价;低于首档起订量返回 :error(无报价)。"
  @spec tier_price(term(), Decimal.t()) :: {:ok, Decimal.t()} | :error
  def tier_price(quotation_item_id, qty) do
    QuotationTier
    |> Ash.Query.filter(item_id == ^quotation_item_id)
    |> Ash.Query.sort(min_qty: :asc)
    |> Ash.read!(authorize?: false)
    |> Enum.filter(fn tier -> Decimal.compare(tier.min_qty, qty) != :gt end)
    |> List.last()
    |> case do
      nil -> :error
      tier -> {:ok, tier.price}
    end
  end
end
