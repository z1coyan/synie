defmodule SynieCore.Base.MarketFetch.Scheduler do
  @moduledoc """
  进程内行情拉取调度:每分钟对齐检查,读 `sys_setting` 配置。

  - 定时总开关关 → 不跑
  - 最新价:交易时段内按配置间隔(30/60/120 分)触发
  - 结算:配置允许时,工作日 15:30/16:00/16:30/17:00 尝试

  测试/禁用: `config :synie_core, market_fetch_scheduler: false`
  """

  use GenServer
  require Logger

  alias SynieCore.Base.MarketFetch
  alias SynieCore.Base.MarketFetch.Sessions
  alias SynieCore.Sys.Setting

  @tick_ms 60_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :tick, 5_000)
    {:ok, %{last_last_slot: nil, last_settlement_slot: nil}}
  end

  @impl true
  def handle_info(:tick, state) do
    state = maybe_run(state)
    Process.send_after(self(), :tick, @tick_ms)
    {:noreply, state}
  end

  defp maybe_run(state) do
    cfg = Setting.market_fetch_config()

    if cfg.schedule_enabled do
      now = DateTime.utc_now() |> DateTime.truncate(:second)
      sh = Sessions.now_shanghai(now)
      state = maybe_last(state, now, sh, cfg.last_interval_minutes)

      if cfg.settlement_enabled do
        maybe_settlement(state, now, sh)
      else
        state
      end
    else
      state
    end
  end

  defp maybe_last(state, now, sh, interval_minutes) do
    interval = normalize_interval(interval_minutes)
    total_mins = sh.hour * 60 + sh.minute
    # 对齐到间隔槽,并在槽内第 0–1 分钟触发(与 tick 容差)
    slot_start = div(total_mins, interval) * interval
    in_window? = total_mins - slot_start <= 1
    slot_key = {DateTime.to_date(sh), slot_start}

    if in_window? and state.last_last_slot != slot_key and Sessions.in_last_session?(now) do
      Logger.info("market_fetch scheduler: lasts interval=#{interval} at #{inspect(sh)}")

      {:ok, %{"items" => items}} = MarketFetch.refresh_lasts(now: now, force: true)
      log_items("last", items)

      %{state | last_last_slot: slot_key}
    else
      state
    end
  end

  defp maybe_settlement(state, now, sh) do
    slot = {sh.hour, sh.minute}

    if Sessions.settlement_attempt_slot?(now) and
         state.last_settlement_slot != {DateTime.to_date(sh), slot} do
      Logger.info("market_fetch scheduler: settlements at #{inspect(sh)}")

      {:ok, %{"items" => items}} = MarketFetch.refresh_settlements(now: now, force: true)
      log_items("settlement", items)

      %{state | last_settlement_slot: {DateTime.to_date(sh), slot}}
    else
      state
    end
  end

  defp normalize_interval(n) when n in [30, 60, 120], do: n
  defp normalize_interval(_), do: 60

  defp log_items(label, items) do
    Enum.each(items, fn i ->
      code = i["code"] || i[:code]
      status = i["status"] || i[:status]
      message = i["message"] || i[:message]

      Logger.info(
        "market_fetch #{label} #{code} #{status}" <>
          if(message, do: " #{message}", else: "")
      )
    end)
  end
end
