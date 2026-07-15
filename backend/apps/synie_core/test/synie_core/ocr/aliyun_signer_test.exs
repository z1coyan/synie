defmodule SynieCore.Ocr.AliyunSignerTest do
  use ExUnit.Case, async: true

  alias SynieCore.Ocr.AliyunSigner

  @creds %{access_key_id: "testAccessKeyId", access_key_secret: "testSecret"}
  @date "2026-07-15T00:00:00Z"
  @nonce "fixednonce123"
  # sha256("abc") 的十六进制
  @abc_sha256 "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

  test "canonical_request 按 V3 规范拼装(头部升序、尾随换行、空查询串)" do
    headers = [
      {"content-type", "application/octet-stream"},
      {"host", "ocr-api.cn-hangzhou.aliyuncs.com"},
      {"x-acs-action", "RecognizeInvoice"},
      {"x-acs-content-sha256", @abc_sha256},
      {"x-acs-date", @date},
      {"x-acs-signature-nonce", @nonce},
      {"x-acs-version", "2021-07-07"}
    ]

    expected =
      Enum.join(
        [
          "POST",
          "/",
          "",
          "content-type:application/octet-stream\n" <>
            "host:ocr-api.cn-hangzhou.aliyuncs.com\n" <>
            "x-acs-action:RecognizeInvoice\n" <>
            "x-acs-content-sha256:#{@abc_sha256}\n" <>
            "x-acs-date:#{@date}\n" <>
            "x-acs-signature-nonce:#{@nonce}\n" <>
            "x-acs-version:2021-07-07\n",
          "content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
          @abc_sha256
        ],
        "\n"
      )

    assert AliyunSigner.canonical_request("POST", "/", "", headers, @abc_sha256) == expected
  end

  test "headers/6 产出全套请求头与正确签名" do
    headers =
      AliyunSigner.headers(
        "ocr-api.cn-hangzhou.aliyuncs.com",
        "RecognizeInvoice",
        "2021-07-07",
        "abc",
        @creds,
        date: @date,
        nonce: @nonce
      )

    map = Map.new(headers)

    assert map["x-acs-content-sha256"] == @abc_sha256
    assert map["x-acs-date"] == @date
    assert map["x-acs-signature-nonce"] == @nonce
    assert map["host"] == "ocr-api.cn-hangzhou.aliyuncs.com"
    assert map["content-type"] == "application/octet-stream"

    # 用文档公式独立复算签名对拍(HMAC-SHA256 → 小写 hex)
    signed_names =
      "content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version"

    canonical =
      AliyunSigner.canonical_request(
        "POST",
        "/",
        "",
        headers |> Enum.reject(fn {k, _} -> k == "authorization" end),
        @abc_sha256
      )

    string_to_sign =
      "ACS3-HMAC-SHA256\n" <> (:crypto.hash(:sha256, canonical) |> Base.encode16(case: :lower))

    signature =
      :crypto.mac(:hmac, :sha256, @creds.access_key_secret, string_to_sign)
      |> Base.encode16(case: :lower)

    assert map["authorization"] ==
             "ACS3-HMAC-SHA256 Credential=testAccessKeyId,SignedHeaders=#{signed_names},Signature=#{signature}"
  end

  test "缺省 date/nonce 自动生成且格式合法" do
    headers = AliyunSigner.headers("h", "A", "V", "", @creds)
    map = Map.new(headers)
    assert map["x-acs-date"] =~ ~r/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    assert map["x-acs-signature-nonce"] =~ ~r/^[0-9a-f]{32}$/
  end
end
