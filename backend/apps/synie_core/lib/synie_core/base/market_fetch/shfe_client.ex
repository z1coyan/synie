defmodule SynieCore.Base.MarketFetch.ShfeClient do
  @moduledoc """
  上期所公开日数据:按品种组取持仓量最大合约的结算价。

  `https://www.shfe.com.cn/data/tradedata/future/dailydata/kxYYYYMMDD.dat`
  可通过 `:synie_core, :market_fetch_shfe_req_options` 注入 Req 选项(测试桩)。
  """

  @base_url "https://www.shfe.com.cn/data/tradedata/future/dailydata/kx"

  @doc """
  取指定交易日、品种组的主力(持仓最大)结算价。

  `trade_date` 为 `~D[...]`。
  返回 `{:ok, %{price, delivery_month, close, open_interest, volume, report_date}}`
  或 `{:error, :not_available}`(非交易日/尚未发布)、`{:error, String.t()}`。
  """
  @spec fetch_settlement(String.t(), Date.t()) :: {:ok, map()} | {:error, :not_available | String.t()}
  def fetch_settlement(product_group, %Date{} = trade_date)
      when is_binary(product_group) do
    group = product_group |> String.trim() |> String.downcase()

    if group == "" do
      {:error, "外部品种组为空"}
    else
      ymd = Calendar.strftime(trade_date, "%Y%m%d")
      url = @base_url <> ymd <> ".dat"

      # 部分环境下 OTP TLS1.3 与上期所握手失败,优先 TLS1.2
      req =
        Req.new(
          [
            url: url,
            method: :get,
            headers: [
              {"user-agent",
               "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
              {"referer", "https://www.shfe.com.cn/"},
              {"accept", "application/json,text/plain,*/*"}
            ],
            connect_options: [
              transport_opts: [
                versions: [:"tlsv1.2"],
                verify: :verify_peer,
                cacerts: :public_key.cacerts_get()
              ]
            ],
            retry: false
          ] ++ Application.get_env(:synie_core, :market_fetch_shfe_req_options, [])
        )

      case Req.request(req) do
        {:ok, %Req.Response{status: 404}} ->
          {:error, :not_available}

        {:ok, %Req.Response{status: 200, body: body}} ->
          parse_body(body, group)

        {:ok, %Req.Response{status: status}} ->
          {:error, "上期所日数据 HTTP #{status}"}

        {:error, err} when is_exception(err) ->
          {:error, "上期所日数据网络错误:#{Exception.message(err)}"}

        {:error, other} ->
          {:error, "上期所日数据网络错误:#{inspect(other)}"}
      end
    end
  end

  defp parse_body(body, group) when is_map(body) do
    rows = Map.get(body, "o_curinstrument") || Map.get(body, :o_curinstrument) || []

    candidates =
      rows
      |> Enum.filter(fn row ->
        pg = row_get(row, "PRODUCTGROUPID") || row_get(row, "PRODUCTID") || ""
        month = row_get(row, "DELIVERYMONTH")
        settle = row_get(row, "SETTLEMENTPRICE")

        String.downcase(to_string(pg)) == group and
          is_binary(month) and String.trim(month) != "" and
          settle not in [nil, "", " "]
      end)

    case candidates do
      [] ->
        {:error, "上期所日数据无品种组 #{group} 的合约"}

      list ->
        best =
          Enum.max_by(list, fn row ->
            oi = row_get(row, "OPENINTEREST") || 0
            to_number(oi)
          end)

        case to_decimal(row_get(best, "SETTLEMENTPRICE"), "结算价") do
          {:ok, price} ->
            if Decimal.positive?(price) do
              {:ok,
               %{
                 price: price,
                 delivery_month: to_string(row_get(best, "DELIVERYMONTH")),
                 close: safe_decimal(row_get(best, "CLOSEPRICE")),
                 open_interest: to_number(row_get(best, "OPENINTEREST")),
                 volume: to_number(row_get(best, "VOLUME")),
                 report_date: row_get(body, "report_date") || row_get(body, "update_date")
               }}
            else
              {:error, "结算价无效"}
            end

          {:error, _} = err ->
            err
        end
    end
  end

  defp parse_body(body, group) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, map} -> parse_body(map, group)
      {:error, _} -> {:error, "上期所日数据 JSON 解析失败"}
    end
  end

  defp parse_body(_, _), do: {:error, "上期所日数据响应无效"}

  defp row_get(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, String.to_atom(key))
  end

  defp to_decimal(nil, label), do: {:error, "缺少#{label}"}

  defp to_decimal(v, _label) when is_number(v), do: {:ok, Decimal.new(to_string(v))}

  defp to_decimal(v, label) when is_binary(v) do
    case Decimal.parse(String.trim(v)) do
      {d, ""} -> {:ok, d}
      _ -> {:error, "#{label}无法解析:#{v}"}
    end
  end

  defp to_decimal(_, label), do: {:error, "#{label}类型无效"}

  defp safe_decimal(v) do
    case to_decimal(v, "x") do
      {:ok, d} -> d
      _ -> nil
    end
  end

  defp to_number(nil), do: 0
  defp to_number(v) when is_integer(v), do: v
  defp to_number(v) when is_float(v), do: trunc(v)

  defp to_number(v) when is_binary(v) do
    case Integer.parse(String.replace(v, ",", "")) do
      {n, _} -> n
      :error -> 0
    end
  end

  defp to_number(_), do: 0
end
