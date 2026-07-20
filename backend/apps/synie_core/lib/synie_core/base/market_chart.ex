defmodule SynieCore.Base.MarketChart do
  @moduledoc """
  行情页图区只读投影:可绘图品种列表 + 多品种时序。

  挂在 `MarketPricePoint` 的 generic action 上,权限复用 `base.market_price:read`,
  不要求 `market_instrument:read`(与行情页拼装约定一致)。
  """

  require Ash.Query

  alias SynieCore.Base.MarketInstrument
  alias SynieCore.Base.MarketPricePoint

  @max_series 6

  @doc "启用品种轻量列表(chips 用),按编码排序。"
  @spec chart_instruments() :: [map()]
  def chart_instruments do
    MarketInstrument
    |> Ash.Query.filter(active == true)
    |> Ash.Query.load([:currency, :unit])
    |> Ash.Query.sort(code: :asc)
    |> Ash.read!(authorize?: false)
    |> Enum.map(&instrument_row/1)
  end

  @doc """
  多品种 × 价类 × 时间窗时序。

  - 仅未作废点;观测时刻闭区间
  - 勾选 ≤ #{@max_series};须同一币种+计量单位
  - 每个请求的品种都返回 series 骨架(无点则 points 空)
  """
  @spec price_series([Ecto.UUID.t()], atom(), DateTime.t(), DateTime.t()) ::
          {:ok, map()} | {:error, term()}
  def price_series(instrument_ids, price_kind, %DateTime{} = from, %DateTime{} = to)
      when is_list(instrument_ids) and is_atom(price_kind) do
    ids = instrument_ids |> Enum.uniq() |> Enum.reject(&is_nil/1)

    cond do
      ids == [] ->
        {:ok, pack_series([], price_kind, from, to, %{})}

      length(ids) > @max_series ->
        {:error,
         Ash.Error.Changes.InvalidArgument.exception(
           field: :instrument_ids,
           message: "最多同时对比 #{@max_series} 个品种"
         )}

      DateTime.compare(from, to) == :gt ->
        {:error,
         Ash.Error.Changes.InvalidArgument.exception(
           field: :to,
           message: "结束时间不能早于开始时间"
         )}

      true ->
        instruments =
          MarketInstrument
          |> Ash.Query.filter(id in ^ids)
          |> Ash.Query.load([:currency, :unit])
          |> Ash.read!(authorize?: false)

        found = Map.new(instruments, &{&1.id, &1})
        missing = Enum.reject(ids, &Map.has_key?(found, &1))

        cond do
          missing != [] ->
            {:error,
             Ash.Error.Changes.InvalidArgument.exception(
               field: :instrument_ids,
               message: "部分行情品种不存在"
             )}

          not same_scale?(instruments) ->
            {:error,
             Ash.Error.Changes.InvalidArgument.exception(
               field: :instrument_ids,
               message: "勾选品种必须同一币种与计量单位,无法同图对比"
             )}

          true ->
            points =
              MarketPricePoint
              |> Ash.Query.filter(
                instrument_id in ^ids and
                  price_kind == ^price_kind and
                  is_voided == false and
                  observed_at >= ^from and
                  observed_at <= ^to
              )
              |> Ash.Query.sort(observed_at: :asc)
              |> Ash.read!(authorize?: false)

            by_inst = Enum.group_by(points, & &1.instrument_id)
            # 保持请求顺序
            ordered = Enum.map(ids, &Map.fetch!(found, &1))
            {:ok, pack_series(ordered, price_kind, from, to, by_inst)}
        end
    end
  end

  def price_series(_, _, _, _) do
    {:error,
     Ash.Error.Changes.InvalidArgument.exception(
       field: :instrument_ids,
       message: "参数无效"
     )}
  end

  defp same_scale?([]), do: true

  defp same_scale?([first | rest]) do
    Enum.all?(rest, fn i ->
      i.currency_id == first.currency_id and i.unit_id == first.unit_id
    end)
  end

  defp pack_series(instruments, price_kind, from, to, by_inst) do
    %{
      "priceKind" => to_string(price_kind),
      "from" => DateTime.to_iso8601(from),
      "to" => DateTime.to_iso8601(to),
      "series" =>
        Enum.map(instruments, fn inst ->
          instrument_row(inst)
          |> Map.put(
            "points",
            by_inst
            |> Map.get(inst.id, [])
            |> Enum.map(fn p ->
              %{
                "observedAt" => DateTime.to_iso8601(p.observed_at),
                "price" => Decimal.to_string(p.price, :normal)
              }
            end)
          )
        end)
    }
  end

  defp instrument_row(i) do
    %{
      "id" => i.id,
      "instrumentId" => i.id,
      "code" => i.code,
      "name" => i.name,
      "currencyId" => i.currency_id,
      "unitId" => i.unit_id,
      "currencyCode" => currency_code(i),
      "unitName" => unit_name(i),
      "defaultPriceKind" => to_string(i.default_price_kind)
    }
  end

  defp currency_code(%{currency: %{iso_code: code}}), do: code
  defp currency_code(_), do: nil

  defp unit_name(%{unit: %{name: name}}), do: name
  defp unit_name(_), do: nil
end
