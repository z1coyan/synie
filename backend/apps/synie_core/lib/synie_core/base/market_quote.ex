defmodule SynieCore.Base.MarketQuote do
  @moduledoc """
  行情取价只读门面:按(品种, 价类, 时点)解析最近有效价点。

  供将来报价挂钩/库存估值调用;本期 UI 不直接暴露。
  """

  require Ash.Query

  alias SynieCore.Base.MarketInstrument
  alias SynieCore.Base.MarketPricePoint

  @doc """
  取价:≤ `at` 的最近一条未作废价点。

  - `price_kind` 为 nil 时用品种默认价类
  - 成功返回 `{:ok, price_point}`
  - 无有效价点 `{:error, :not_found}`
  - 品种不存在 `{:error, :instrument_not_found}`
  """
  @spec take(Ecto.UUID.t(), DateTime.t(), atom() | nil) ::
          {:ok, MarketPricePoint.t()}
          | {:error, :instrument_not_found | :not_found}
  def take(instrument_id, %DateTime{} = at, price_kind \\ nil) do
    with {:ok, instrument} <- load_instrument(instrument_id) do
      kind = price_kind || instrument.default_price_kind

      MarketPricePoint
      |> Ash.Query.filter(
        instrument_id == ^instrument_id and
          price_kind == ^kind and
          is_voided == false and
          observed_at <= ^at
      )
      |> Ash.Query.sort(observed_at: :desc)
      |> Ash.Query.limit(1)
      |> Ash.read_one(authorize?: false)
      |> case do
        {:ok, nil} -> {:error, :not_found}
        {:ok, point} -> {:ok, point}
        {:error, _} -> {:error, :not_found}
      end
    end
  end

  defp load_instrument(id) do
    case Ash.get(MarketInstrument, id, authorize?: false) do
      {:ok, inst} -> {:ok, inst}
      {:error, _} -> {:error, :instrument_not_found}
    end
  end
end
