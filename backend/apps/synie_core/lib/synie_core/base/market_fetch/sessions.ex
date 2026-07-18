defmodule SynieCore.Base.MarketFetch.Sessions do
  @moduledoc """
  上海时区(固定 UTC+8,无夏令时)交易时段与结算窗口判断。

  - 日盘:09:00–15:05
  - 夜盘:21:00–次日 02:35(覆盖铜铝夜盘至 01:00 与银至 02:30)
  - 结算尝试:工作日 15:30 / 16:00 / 16:30 / 17:00
  """

  # 与 bank_import 一致:国内无夏令时,固定 +8,不引入 tz 数据库依赖
  @utc_offset_seconds 8 * 3600

  @doc "上海墙钟 DateTime(在 UTC 上加 8 小时,仅比较 hour/minute/date 用,不引入 tz 库)。"
  def now_shanghai(utc \\ DateTime.utc_now()) do
    DateTime.add(utc, @utc_offset_seconds, :second)
  end

  @doc "是否处于可拉最新价的交易时段(日盘或夜盘)。"
  def in_last_session?(utc \\ DateTime.utc_now()) do
    sh = now_shanghai(utc)
    minutes = sh.hour * 60 + sh.minute

    day? = minutes >= 9 * 60 and minutes < 15 * 60 + 5
    night? = minutes >= 21 * 60 or minutes < 2 * 60 + 35

    day? or night?
  end

  @doc """
  人类可读的定时规则说明(供界面展示,与调度实现一致)。
  `interval_minutes` 取 30/60/120。
  """
  def schedule_description(interval_minutes \\ 60, schedule_enabled \\ true, settlement_enabled \\ true) do
    interval = if interval_minutes in [30, 60, 120], do: interval_minutes, else: 60

    last =
      if schedule_enabled do
        "交易时段(日盘约 09:00–15:00、有色夜盘约 21:00–次日 02:30,上海时区)每 #{interval} 分钟拉最新价"
      else
        "定时拉取已关闭(仅可手动刷新)"
      end

    settle =
      cond do
        not schedule_enabled -> nil
        settlement_enabled -> "工作日约 15:30 起自动补拉结算价(失败会在 16:00/16:30/17:00 重试)"
        true -> "结算自动补拉已关闭"
      end

    [last, settle] |> Enum.reject(&is_nil/1) |> Enum.join("；")
  end

  @doc "是否处于日终结算拉取尝试点(工作日固定时刻)。"
  def settlement_attempt_slot?(utc \\ DateTime.utc_now()) do
    sh = now_shanghai(utc)

    if Date.day_of_week(DateTime.to_date(sh)) in [6, 7] do
      false
    else
      {sh.hour, sh.minute} in [{15, 30}, {16, 0}, {16, 30}, {17, 0}]
    end
  end

  @doc "是否已过当日日盘结算窗口起点(15:30 上海)。"
  def past_settlement_window?(utc \\ DateTime.utc_now()) do
    sh = now_shanghai(utc)
    minutes = sh.hour * 60 + sh.minute
    minutes >= 15 * 60 + 30
  end

  @doc "结算价点观测时刻:交易日 15:00 上海 → UTC。"
  def settlement_observed_at(%Date{} = trade_date) do
    # 15:00 上海 = 07:00 UTC
    DateTime.new!(trade_date, ~T[07:00:00], "Etc/UTC")
    |> DateTime.truncate(:second)
  end

  @doc "上海日历日。"
  def shanghai_date(utc \\ DateTime.utc_now()) do
    utc |> now_shanghai() |> DateTime.to_date()
  end

  @doc "结算所属交易日:日终任务在日盘后跑,用上海日历日。"
  def settlement_trade_date(utc \\ DateTime.utc_now()) do
    shanghai_date(utc)
  end
end
