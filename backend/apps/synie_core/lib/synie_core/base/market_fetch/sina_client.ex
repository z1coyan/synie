defmodule SynieCore.Base.MarketFetch.SinaClient do
  @moduledoc """
  新浪期货公开行情串:主连最新价。

  `https://hq.sinajs.cn/list=nf_CU0` 等;字段为 GBK CSV。
  可通过 `:synie_core, :market_fetch_sina_req_options` 注入 Req 选项(测试桩)。
  """

  @base_url "https://hq.sinajs.cn/list="

  @doc """
  按主连代码(如 `CU0`)取最新价。

  返回 `{:ok, %{price: Decimal.t(), name: String.t(), as_of_date: String.t() | nil}}`
  """
  @spec fetch_last(String.t()) :: {:ok, map()} | {:error, String.t()}
  def fetch_last(code) when is_binary(code) do
    code = String.trim(code)

    if code == "" do
      {:error, "外部最新价代码为空"}
    else
      symbol = normalize_symbol(code)
      url = @base_url <> symbol

      req =
        Req.new(
          [
            url: url,
            method: :get,
            headers: [
              {"user-agent",
               "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
              {"referer", "https://finance.sina.com.cn"}
            ],
            decode_body: false,
            connect_options: [
              transport_opts: [
                versions: [:"tlsv1.2"],
                verify: :verify_peer,
                cacerts: :public_key.cacerts_get()
              ]
            ],
            retry: false
          ] ++ Application.get_env(:synie_core, :market_fetch_sina_req_options, [])
        )

      case Req.request(req) do
        {:ok, %Req.Response{status: 200, body: body}} ->
          parse_body(body, symbol)

        {:ok, %Req.Response{status: status}} ->
          {:error, "新浪行情 HTTP #{status}"}

        {:error, err} when is_exception(err) ->
          {:error, "新浪行情网络错误:#{Exception.message(err)}"}

        {:error, other} ->
          {:error, "新浪行情网络错误:#{inspect(other)}"}
      end
    end
  end

  defp normalize_symbol("nf_" <> _ = s), do: s
  defp normalize_symbol(code), do: "nf_" <> code

  defp parse_body(body, symbol) when is_binary(body) do
    text = decode_text(body)

    case Regex.run(~r/hq_str_#{Regex.escape(symbol)}="([^"]*)"/, text) do
      [_, ""] ->
        {:error, "新浪行情无数据(#{symbol})"}

      [_, payload] ->
        parts = String.split(payload, ",")

        case field_decimal(parts, 8, "最新价") do
          {:ok, price} ->
            if Decimal.positive?(price) do
              {:ok,
               %{
                 price: price,
                 name: Enum.at(parts, 0) || symbol,
                 as_of_date: blank_to_nil(Enum.at(parts, 17))
               }}
            else
              {:error, "新浪最新价无效"}
            end

          {:error, _} = err ->
            err
        end

      nil ->
        {:error, "新浪行情解析失败(#{symbol})"}
    end
  end

  defp parse_body(_, _), do: {:error, "新浪行情响应无效"}

  defp decode_text(body) when is_binary(body) do
    # 价位字段是 ASCII;不依赖系统 GBK 编码表。若 body 已是 UTF-8 中文名亦可整串匹配。
    body
  end

  defp field_decimal(parts, idx, label) do
    case Enum.at(parts, idx) do
      nil ->
        {:error, "新浪行情缺少#{label}"}

      raw ->
        case Decimal.parse(String.trim(raw)) do
          {d, ""} -> {:ok, d}
          _ -> {:error, "新浪#{label}无法解析:#{raw}"}
        end
    end
  end

  defp blank_to_nil(nil), do: nil
  defp blank_to_nil(""), do: nil
  defp blank_to_nil(s), do: s
end
