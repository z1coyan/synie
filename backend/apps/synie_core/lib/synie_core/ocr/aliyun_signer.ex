defmodule SynieCore.Ocr.AliyunSigner do
  @moduledoc """
  阿里云 OpenAPI V3 签名(ACS3-HMAC-SHA256),用于 ocr-api 等 RPC 风格接口的
  POST + 二进制 body 调用(CanonicalURI 恒为 "/",无查询参数)。
  时间与 nonce 可由调用方经 opts 注入,便于测试对拍。
  """

  @algorithm "ACS3-HMAC-SHA256"

  @doc """
  构造带签名的请求头。返回 `[{name, value}]`,含 `authorization`;
  头名全小写、按 ASCII 升序(参与签名的顺序即发送顺序)。
  """
  @spec headers(String.t(), String.t(), String.t(), binary(), map(), keyword()) ::
          [{String.t(), String.t()}]
  def headers(host, action, version, body, creds, opts \\ []) do
    date = Keyword.get_lazy(opts, :date, &utc_now/0)
    nonce = Keyword.get_lazy(opts, :nonce, &random_nonce/0)
    payload_hash = hex_sha256(body)

    signed = [
      {"content-type", "application/octet-stream"},
      {"host", host},
      {"x-acs-action", action},
      {"x-acs-content-sha256", payload_hash},
      {"x-acs-date", date},
      {"x-acs-signature-nonce", nonce},
      {"x-acs-version", version}
    ]

    canonical = canonical_request("POST", "/", "", signed, payload_hash)
    string_to_sign = @algorithm <> "\n" <> hex_sha256(canonical)

    signature =
      :crypto.mac(:hmac, :sha256, creds.access_key_secret, string_to_sign)
      |> Base.encode16(case: :lower)

    authorization =
      "#{@algorithm} Credential=#{creds.access_key_id}," <>
        "SignedHeaders=#{signed_names(signed)},Signature=#{signature}"

    signed ++ [{"authorization", authorization}]
  end

  @doc """
  V3 CanonicalRequest。CanonicalHeaders 每行以 \\n 结尾(与 SignedHeaders 之间
  因此隔一个空行),整体各段再以 \\n 连接——与 AWS SigV4 同构,勿"修掉"空行。
  """
  @spec canonical_request(String.t(), String.t(), String.t(), [{String.t(), String.t()}], String.t()) ::
          String.t()
  def canonical_request(method, uri, query, headers, payload_hash) do
    canonical_headers = Enum.map_join(headers, fn {k, v} -> "#{k}:#{v}\n" end)
    Enum.join([method, uri, query, canonical_headers, signed_names(headers), payload_hash], "\n")
  end

  defp signed_names(headers), do: Enum.map_join(headers, ";", &elem(&1, 0))

  defp hex_sha256(data), do: :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)

  defp utc_now do
    DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  end

  defp random_nonce, do: :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower)
end
