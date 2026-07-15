defmodule SynieCore.Ocr.AliyunClient do
  @moduledoc """
  阿里云 OCR(ocr-api,版本 2021-07-07)HTTP 客户端:V3 签名 + 图片二进制 body。
  `:synie_core, :ocr_req_options` 可注入 Req 选项(测试注入 Req.Test plug 不出网)。
  """

  alias SynieCore.Ocr.AliyunSigner

  @host "ocr-api.cn-hangzhou.aliyuncs.com"
  @version "2021-07-07"

  @spec recognize(String.t(), binary(), map()) :: {:ok, map()} | {:error, String.t()}
  def recognize(action, image_binary, creds) do
    # host 参与签名但不显式发送(Finch 按 URL 自动带 Host,同值;显式再带会重复)
    headers =
      @host
      |> AliyunSigner.headers(action, @version, image_binary, creds)
      |> Enum.reject(fn {k, _} -> k == "host" end)

    req =
      Req.new(
        [
          url: "https://#{@host}/",
          method: :post,
          headers: headers,
          body: image_binary,
          retry: false
        ] ++ Application.get_env(:synie_core, :ocr_req_options, [])
      )

    case Req.request(req) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        decode_data(body)

      {:ok, %Req.Response{body: %{"Code" => code} = body}} ->
        {:error, "阿里云 OCR 调用失败(#{code}):#{body["Message"] || "未知错误"}"}

      {:ok, %Req.Response{status: status}} ->
        {:error, "阿里云 OCR 调用失败(HTTP #{status})"}

      {:error, err} when is_exception(err) ->
        {:error, "阿里云 OCR 网络错误:#{Exception.message(err)}"}

      {:error, other} ->
        {:error, "阿里云 OCR 网络错误:#{inspect(other)}"}
    end
  end

  defp decode_data(%{"Data" => data}) when is_binary(data) do
    case Jason.decode(data) do
      {:ok, decoded} when is_map(decoded) -> {:ok, decoded}
      _ -> {:error, "阿里云 OCR 返回的 Data 无法解析"}
    end
  end

  defp decode_data(%{"Data" => data}) when is_map(data), do: {:ok, data}
  defp decode_data(_body), do: {:error, "阿里云 OCR 返回缺少 Data 字段"}
end
