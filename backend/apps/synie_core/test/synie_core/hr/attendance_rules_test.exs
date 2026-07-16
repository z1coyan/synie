defmodule SynieCore.Hr.AttendanceRulesTest do
  use ExUnit.Case, async: true

  alias SynieCore.Hr.Attendance.Rules

  defp assert_dec(actual, expected),
    do: assert(Decimal.eq?(actual, Decimal.new(expected)), "期望 #{expected},实得 #{actual}")

  test "标准四卡日:上下午各自 30 分钟向下取整" do
    day = Rules.compute_day([~T[07:58:00], ~T[11:32:00], ~T[13:01:00], ~T[17:29:00]])

    assert day.morning_in == ~T[07:58:00]
    assert day.morning_out == ~T[11:32:00]
    assert day.afternoon_in == ~T[13:01:00]
    assert day.afternoon_out == ~T[17:29:00]
    # 上午 3h34m→3.5h,下午 4h28m→4h;若合计取整会得 8h,分段取整是 7.5h
    assert_dec(day.normal_hours, "7.5")
    assert_dec(day.overtime_hours, "0")
    assert_dec(day.bonus_workday, "0")
    assert day.status == :ok
  end

  test "上午封顶 4h:早来不算工时也不算加班,正常工时日封顶 8h" do
    day = Rules.compute_day([~T[06:30:00], ~T[11:35:00], ~T[13:00:00], ~T[17:00:00]])

    assert_dec(day.normal_hours, "8")
    assert_dec(day.overtime_hours, "0")
    assert day.status == :ok
  end

  test "下午超 4h 部分=加班;满 3.5h 奖励 0.5 工日" do
    day = Rules.compute_day([~T[08:00:00], ~T[11:30:00], ~T[13:00:00], ~T[20:35:00]])

    # 下午 7h35m→7.5h:4h 正常 + 3.5h 加班,恰达奖励阈值
    assert_dec(day.normal_hours, "7.5")
    assert_dec(day.overtime_hours, "3.5")
    assert_dec(day.bonus_workday, "0.5")
  end

  test "加班不满 3.5h 无奖励;超 3.5h 也只奖 0.5(日封顶)" do
    almost = Rules.compute_day([~T[13:00:00], ~T[20:25:00]])
    # 下午 7h25m→7h:加班 3h,不满阈值
    assert_dec(almost.overtime_hours, "3")
    assert_dec(almost.bonus_workday, "0")

    long = Rules.compute_day([~T[13:00:00], ~T[23:00:00]])
    # 下午 10h:加班 6h,奖励仍封顶 0.5
    assert_dec(long.overtime_hours, "6")
    assert_dec(long.bonus_workday, "0.5")
  end

  test "桶内单卡=缺卡:该段计 0 并标异常,另一段照算" do
    day = Rules.compute_day([~T[07:30:00], ~T[13:00:00], ~T[17:00:00]])

    assert day.morning_in == ~T[07:30:00]
    assert day.morning_out == ~T[07:30:00]
    assert_dec(day.normal_hours, "4")
    assert day.status == :missing
  end

  test "半天班(桶内无卡)是无出勤不是缺卡" do
    day = Rules.compute_day([~T[13:00:00], ~T[17:00:00]])

    assert day.morning_in == nil
    assert day.morning_out == nil
    assert_dec(day.normal_hours, "4")
    assert day.status == :ok
  end

  test "只上下午的人同规则:下午超 4h 也算加班(ADR 接受推论)" do
    day = Rules.compute_day([~T[13:00:00], ~T[20:30:00]])

    assert_dec(day.normal_hours, "4")
    assert_dec(day.overtime_hours, "3.5")
    assert_dec(day.bonus_workday, "0.5")
  end

  test "连按考勤机被 min/max 天然吸收,不算缺卡" do
    day =
      Rules.compute_day([~T[07:30:00], ~T[07:30:05], ~T[11:30:00], ~T[13:00:00], ~T[17:00:00]])

    assert day.morning_in == ~T[07:30:00]
    assert day.morning_out == ~T[11:30:00]
    assert_dec(day.normal_hours, "8")
    assert day.status == :ok
  end

  test "12:00 整点归下午桶" do
    day = Rules.compute_day([~T[12:00:00], ~T[17:00:00]])

    assert day.morning_in == nil
    assert day.afternoon_in == ~T[12:00:00]
    # 下午 5h:4h 正常 + 1h 加班
    assert_dec(day.normal_hours, "4")
    assert_dec(day.overtime_hours, "1")
  end

  test "全天无卡不生成行" do
    assert Rules.compute_day([]) == nil
  end

  test "UTC↔本地按固定偏移 +08 转换;跨日卡归属本地日" do
    assert Rules.local_date(~U[2026-07-14 23:30:00Z]) == ~D[2026-07-15]
    assert Rules.local_time(~U[2026-07-14 23:30:00Z]) == ~T[07:30:00]

    {start_utc, end_utc} = Rules.day_range_utc(~D[2026-07-15])
    assert start_utc == ~U[2026-07-14 16:00:00Z]
    assert end_utc == ~U[2026-07-15 16:00:00Z]
  end
end
