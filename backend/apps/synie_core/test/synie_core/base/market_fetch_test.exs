defmodule SynieCore.Base.MarketFetchTest do
  use ExUnit.Case, async: false

  require Ash.Query

  alias SynieCore.Base.Currency
  alias SynieCore.Base.MarketFetch
  alias SynieCore.Base.MarketFetch.Sessions
  alias SynieCore.Base.MarketFetch.ShfeClient
  alias SynieCore.Base.MarketFetch.SinaClient
  alias SynieCore.Base.MarketInstrument
  alias SynieCore.Base.MarketPricePoint
  alias SynieCore.Base.Unit

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    # 调度未启动;HTTP 桩按用例 stub
    :ok
  end

  defp currency! do
    n = System.unique_integer([:positive])
    a = rem(div(n, 26 * 26), 26)
    b = rem(div(n, 26), 26)
    c = rem(n, 26)
    iso = <<?A + a, ?A + b, ?A + c>>

    Currency
    |> Ash.Changeset.for_create(:create, %{name: "测币", iso_code: iso})
    |> Ash.create!(authorize?: false)
  end

  defp unit! do
    sym = "u#{System.unique_integer([:positive])}"

    Unit
    |> Ash.Changeset.for_create(:create, %{
      unit_type: :weight,
      is_base: false,
      name: "测吨",
      symbol: sym,
      ratio: Decimal.new(1)
    })
    |> Ash.create!(authorize?: false)
  end

  defp instrument!(attrs \\ %{}) do
    c = currency!()
    u = unit!()

    defaults = %{
      code: "I#{System.unique_integer([:positive])}",
      name: "测试品种",
      source_type: :exchange,
      default_price_kind: :settlement,
      fetch_enabled: true,
      external_last_code: "CU0",
      external_product_group: "cu",
      currency_id: c.id,
      unit_id: u.id
    }

    MarketInstrument
    |> Ash.Changeset.for_create(:create, Map.merge(defaults, attrs))
    |> Ash.create!(authorize?: false)
  end

  test "Sessions:日盘与结算窗口" do
    # 2026-07-17 周五 10:00 上海 = 02:00 UTC
    day = ~U[2026-07-17 02:00:00Z]
    assert Sessions.in_last_session?(day)
    refute Sessions.past_settlement_window?(day)

    # 15:30 上海 = 07:30 UTC
    settle_slot = ~U[2026-07-17 07:30:00Z]
    assert Sessions.settlement_attempt_slot?(settle_slot)
    assert Sessions.past_settlement_window?(settle_slot)

    # 周六
    sat = ~U[2026-07-18 07:30:00Z]
    refute Sessions.settlement_attempt_slot?(sat)

    at = Sessions.settlement_observed_at(~D[2026-07-17])
    assert at.hour == 7
    assert at.minute == 0
  end

  test "SinaClient 解析最新价" do
    body =
      ~s|var hq_str_nf_CU0="铜连续,010000,103100.000,103990.000,103000.000,0.000,103840.000,103880.000,103880.000,0.000,103720.000,11,1,183964.000,31080,沪,铜,2026-07-18,1";\n|

    Req.Test.stub(SinaClient, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("text/plain")
      |> Plug.Conn.send_resp(200, body)
    end)

    assert {:ok, %{price: price, as_of_date: "2026-07-18"}} = SinaClient.fetch_last("CU0")
    assert Decimal.eq?(price, Decimal.new("103880.000"))
  end

  test "ShfeClient 取持仓最大合约结算价" do
    payload = %{
      "report_date" => "20260717",
      "o_curinstrument" => [
        %{
          "PRODUCTGROUPID" => "cu",
          "DELIVERYMONTH" => "2608",
          "SETTLEMENTPRICE" => 103_810,
          "CLOSEPRICE" => 103_550,
          "OPENINTEREST" => 127_472,
          "VOLUME" => 63_668
        },
        %{
          "PRODUCTGROUPID" => "cu",
          "DELIVERYMONTH" => "2609",
          "SETTLEMENTPRICE" => 103_720,
          "CLOSEPRICE" => 103_370,
          "OPENINTEREST" => 180_125,
          "VOLUME" => 69_929
        }
      ]
    }

    Req.Test.stub(ShfeClient, fn conn ->
      Req.Test.json(conn, payload)
    end)

    assert {:ok, %{price: price, delivery_month: "2609", open_interest: 180_125}} =
             ShfeClient.fetch_settlement("cu", ~D[2026-07-17])

    assert Decimal.eq?(price, Decimal.new("103720"))
  end

  test "ShfeClient 404 → not_available" do
    Req.Test.stub(ShfeClient, fn conn ->
      Plug.Conn.send_resp(conn, 404, "not found")
    end)

    assert {:error, :not_available} = ShfeClient.fetch_settlement("cu", ~D[2026-07-18])
  end

  test "refresh 写入 last;结算窗口补 settlement 且不重复" do
    inst = instrument!()

    sina_body =
      ~s|var hq_str_nf_CU0="铜连续,010000,1,1,1,0,1,1,88888.000,0,1,1,1,1,1,沪,铜,2026-07-17,1";\n|

    shfe_payload = %{
      "o_curinstrument" => [
        %{
          "PRODUCTGROUPID" => "cu",
          "DELIVERYMONTH" => "2609",
          "SETTLEMENTPRICE" => 77_000,
          "CLOSEPRICE" => 76_000,
          "OPENINTEREST" => 100,
          "VOLUME" => 10
        }
      ]
    }

    Req.Test.stub(SinaClient, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("text/plain")
      |> Plug.Conn.send_resp(200, sina_body)
    end)

    Req.Test.stub(ShfeClient, fn conn ->
      Req.Test.json(conn, shfe_payload)
    end)

    # 周五 16:00 上海 = 08:00 UTC → 会补结算
    now = ~U[2026-07-17 08:00:00Z]

    assert {:ok, %{"items" => items}} =
             MarketFetch.refresh(instrument_id: inst.id, now: now, try_settlement: true)

    assert Enum.any?(items, &(&1["kind"] == "last" and &1["status"] == "ok"))
    assert Enum.any?(items, &(&1["kind"] == "settlement" and &1["status"] == "ok"))

    points =
      MarketPricePoint
      |> Ash.Query.filter(instrument_id == ^inst.id)
      |> Ash.read!(authorize?: false)

    assert length(points) == 2
    assert Enum.any?(points, &(&1.price_kind == :last and &1.source == :fetch))
    assert Enum.any?(points, &(&1.price_kind == :settlement and &1.source == :fetch))

    # 再刷:结算应 skip
    assert {:ok, %{"items" => items2}} =
             MarketFetch.refresh(instrument_id: inst.id, now: now, try_settlement: true)

    settle = Enum.find(items2, &(&1["kind"] == "settlement"))
    assert settle["status"] == "skipped"
  end

  test "generic action refresh 空 input 可调用(不因缺 instrumentId 崩溃)" do
    # 种子里可能已有 fetch_enabled 品种,桩 HTTP 避免出网
    Req.Test.stub(SinaClient, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("text/plain")
      |> Plug.Conn.send_resp(
        200,
        ~s|var hq_str_nf_CU0="x,0,1,1,1,0,1,1,100.000,0,1,1,1,1,1,x,x,2026-07-17,1";\n|
      )
    end)

    Req.Test.stub(ShfeClient, fn conn ->
      Plug.Conn.send_resp(conn, 404, "not found")
    end)

    assert {:ok, %{"items" => items, "count" => _}} =
             MarketPricePoint
             |> Ash.ActionInput.for_action(:refresh, %{})
             |> Ash.run_action(authorize?: false)

    assert is_list(items)
  end

  test "generic action refresh 指定未启用品种返回空" do
    inst = instrument!(%{fetch_enabled: false})

    assert {:ok, %{"items" => []}} =
             MarketPricePoint
             |> Ash.ActionInput.for_action(:refresh, %{instrument_id: inst.id})
             |> Ash.run_action(authorize?: false)
  end
end
