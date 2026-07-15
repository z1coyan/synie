defmodule SynieCore.Ocr.AliyunClientTest do
  use ExUnit.Case, async: true

  alias SynieCore.Ocr.AliyunClient

  @creds %{access_key_id: "ak", access_key_secret: "sk"}

  test "200 + Data JSON 串 → 解码后的 map" do
    Req.Test.stub(AliyunClient, fn conn ->
      # 签名头应随请求带出
      assert [_ | _] = Plug.Conn.get_req_header(conn, "authorization")
      assert ["RecognizeInvoice"] = Plug.Conn.get_req_header(conn, "x-acs-action")

      Req.Test.json(conn, %{
        "RequestId" => "req-1",
        "Data" => Jason.encode!(%{"data" => %{"invoiceNumber" => "12345678"}})
      })
    end)

    assert {:ok, %{"data" => %{"invoiceNumber" => "12345678"}}} =
             AliyunClient.recognize("RecognizeInvoice", <<1, 2, 3>>, @creds)
  end

  test "阿里云错误码 → 带 Code/Message 的中文错误" do
    Req.Test.stub(AliyunClient, fn conn ->
      conn
      |> Plug.Conn.put_status(400)
      |> Req.Test.json(%{"Code" => "invalidImage", "Message" => "image is invalid"})
    end)

    assert {:error, msg} = AliyunClient.recognize("RecognizeInvoice", <<1>>, @creds)
    assert msg =~ "invalidImage"
    assert msg =~ "image is invalid"
  end

  test "非 JSON/缺 Data 的 200 → 明确错误" do
    Req.Test.stub(AliyunClient, fn conn ->
      Req.Test.json(conn, %{"RequestId" => "req-2"})
    end)

    assert {:error, msg} = AliyunClient.recognize("RecognizeInvoice", <<1>>, @creds)
    assert msg =~ "Data"
  end

  test "网络错误 → 中文网络错误信息" do
    Req.Test.stub(AliyunClient, fn conn ->
      Req.Test.transport_error(conn, :econnrefused)
    end)

    assert {:error, msg} = AliyunClient.recognize("RecognizeInvoice", <<1>>, @creds)
    assert msg =~ "网络"
  end
end
