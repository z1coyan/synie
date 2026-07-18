defmodule SynieCore.Base.MarketFetchSettingsTest do
  use ExUnit.Case, async: false

  alias SynieCore.Base.MarketFetch.Sessions
  alias SynieCore.Sys.Setting

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "market_fetch_config 默认值" do
    cfg = Setting.market_fetch_config()
    assert cfg.schedule_enabled == true
    assert cfg.last_interval_minutes == 60
    assert cfg.settlement_enabled == true
  end

  test "更新间隔仅允许 30/60/120" do
    setting = Setting.get()
    assert setting

    assert {:ok, updated} =
             setting
             |> Ash.Changeset.for_update(:update, %{market_fetch_last_interval_minutes: 30})
             |> Ash.update(authorize?: false)

    assert updated.market_fetch_last_interval_minutes == 30

    assert {:error, _} =
             updated
             |> Ash.Changeset.for_update(:update, %{market_fetch_last_interval_minutes: 15})
             |> Ash.update(authorize?: false)
  end

  test "record_market_fetch! 写回摘要" do
    Setting.record_market_fetch!("测试摘要 ok")
    cfg = Setting.market_fetch_config()
    assert cfg.last_summary == "测试摘要 ok"
    assert cfg.last_run_at
  end

  test "schedule_description 随开关变化" do
    assert Sessions.schedule_description(60, true, true) =~ "60 分钟"
    assert Sessions.schedule_description(30, false, true) =~ "已关闭"
    assert Sessions.schedule_description(60, true, false) =~ "结算自动补拉已关闭"
  end
end
