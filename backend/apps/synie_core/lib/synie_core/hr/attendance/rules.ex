defmodule SynieCore.Hr.Attendance.Rules do
  @moduledoc """
  考勤计算规则(纯函数,常量集中于此)。规则见
  docs/adr/2026-07-15-attendance-daily-calc.md,ADR 拍板不设配置表:

    * 12:00 切分上下午桶(<12:00 上午,≥12:00 下午),桶内最早卡=上班、最晚卡=下班
      (min/max 天然吸收考勤机连按);
    * 段工时 30 分钟向下取整,上下午各自取整;
    * 上午封顶 4h(早来不算),下午超 4h 部分=加班工时,正常工时日封顶 8h;
    * 单日加班(取整后)≥3.5h 额外奖励 0.5 工日(日封顶,不满为 0);
    * 桶内单卡=缺卡(该段计 0 并标异常),桶内无卡=无出勤(不是异常);
    * 全天无卡不生成行(`compute_day([])` 返回 nil)。

  输入输出均为本地时刻;UTC↔本地转换沿用 .dat 导入的固定偏移约定
  (`:attendance_import_utc_offset_minutes`,默认 480 即 UTC+8,不引 tzdata)。
  """

  @split_second 12 * 3600
  @round_seconds 30 * 60
  # 工时以半小时为最小单位建账:4h 封顶=8 单位,奖励阈值 3.5h=7 单位
  @half_day_units 8
  @bonus_threshold_units 7
  @full_day_hours Decimal.new(8)
  @bonus_workday Decimal.new("0.5")
  @zero Decimal.new(0)

  @doc "本地时区固定偏移(分),与 .dat 导入解析共用同一配置键"
  def utc_offset_minutes,
    do: Application.get_env(:synie_core, :attendance_import_utc_offset_minutes, 480)

  @doc "标准工日小时数(月工日 = Σ正常工时 ÷ 8 + Σ奖励工日)"
  def full_day_hours, do: @full_day_hours

  @doc "UTC 时刻 → 本地日期"
  def local_date(%DateTime{} = utc), do: utc |> shift_local() |> DateTime.to_date()

  @doc "UTC 时刻 → 本地钟点"
  def local_time(%DateTime{} = utc), do: utc |> shift_local() |> DateTime.to_time()

  @doc "本地日期 → 对应的 UTC 区间 [起, 止)"
  def day_range_utc(%Date{} = date) do
    start_utc =
      date
      |> NaiveDateTime.new!(~T[00:00:00])
      |> DateTime.from_naive!("Etc/UTC")
      |> DateTime.add(-utc_offset_minutes() * 60, :second)

    {start_utc, DateTime.add(start_utc, 86_400, :second)}
  end

  @doc """
  计算一天:输入该员工当日全部卡的本地钟点(真实打卡+补卡合并,顺序不限),
  输出日考勤字段 map(四段时刻/正常工时/加班工时/奖励工日/状态);
  空列表返回 nil(全天无卡不生成行)。
  """
  def compute_day([]), do: nil

  def compute_day(times) when is_list(times) do
    {morning, afternoon} = Enum.split_with(times, &(second_of_day(&1) < @split_second))
    {m_in, m_out} = min_max(morning)
    {a_in, a_out} = min_max(afternoon)

    m_units = morning |> span_units(m_in, m_out) |> min(@half_day_units)
    a_units = span_units(afternoon, a_in, a_out)
    ot_units = max(a_units - @half_day_units, 0)

    %{
      morning_in: m_in,
      morning_out: m_out,
      afternoon_in: a_in,
      afternoon_out: a_out,
      normal_hours: units_to_hours(m_units + min(a_units, @half_day_units)),
      overtime_hours: units_to_hours(ot_units),
      bonus_workday: if(ot_units >= @bonus_threshold_units, do: @bonus_workday, else: @zero),
      status: if(length(morning) == 1 or length(afternoon) == 1, do: :missing, else: :ok)
    }
  end

  # Time 结构禁止走结构比较(microsecond 字段序位于 minute 前),按钟点秒数比较
  defp min_max([]), do: {nil, nil}
  defp min_max(times), do: Enum.min_max_by(times, &second_of_day/1)

  defp span_units([], _t_in, _t_out), do: 0

  defp span_units(_times, t_in, t_out),
    do: div(second_of_day(t_out) - second_of_day(t_in), @round_seconds)

  defp second_of_day(%Time{hour: h, minute: m, second: s}), do: h * 3600 + m * 60 + s

  defp units_to_hours(units), do: units |> Decimal.new() |> Decimal.div(2)

  defp shift_local(utc), do: DateTime.add(utc, utc_offset_minutes() * 60, :second)
end
