defmodule SynieCore.Hr.Attendance.Recompute do
  @moduledoc """
  日考勤重算引擎:输入受影响的 {employee_id, 本地日期} 集合,重取该日全部
  真实打卡+补卡虚拟卡合并计算(`Rules.compute_day/1`),结果 upsert 进
  `hr_attendance_day`;算不出行(全天无卡)则删除既有派生行。幂等:同输入
  重算结果一致,重复执行无副作用。

  全程 `authorize?: false` 内部路径:调用方(导入执行/撤销、补卡增删、区间
  重算 action)已做动作级权限;通常在调用方动作事务内执行,整体成败一致。
  """

  require Ash.Query

  alias SynieCore.Hr.{AttendanceCorrection, AttendanceDay, AttendancePunch, Employee}
  alias SynieCore.Hr.Attendance.Rules

  @doc "重算给定 (员工, 本地日) 集合,返回重算天数"
  def recompute([]), do: 0

  def recompute(pairs) when is_list(pairs) do
    pairs = Enum.uniq(pairs)

    times_by_pair =
      Map.merge(punch_times(pairs), correction_times(pairs), fn _pair, a, b -> a ++ b end)

    {rows, empty_pairs} =
      Enum.reduce(pairs, {[], []}, fn {employee_id, date} = pair, {rows, empty} ->
        case Rules.compute_day(Map.get(times_by_pair, pair, [])) do
          nil ->
            {rows, [pair | empty]}

          day ->
            {[Map.merge(day, %{employee_id: employee_id, date: date}) | rows], empty}
        end
      end)

    upsert_days(rows)
    delete_days(empty_pairs)
    length(pairs)
  end

  @doc "按本地日期区间全量重算:打卡∪补卡∪既有日考勤行涉及的 (员工, 日) 都算(孤儿行顺带清理)"
  def recalc_range(%Date{} = from, %Date{} = to) do
    {start_utc, _} = Rules.day_range_utc(from)
    {_, end_utc} = Rules.day_range_utc(to)

    punch_pairs =
      AttendancePunch
      |> Ash.Query.filter(punched_at >= ^start_utc and punched_at < ^end_utc)
      |> Ash.read!(authorize?: false)
      |> Enum.map(&{&1.employee_id, Rules.local_date(&1.punched_at)})

    correction_pairs =
      AttendanceCorrection
      |> Ash.Query.filter(date >= ^from and date <= ^to)
      |> Ash.read!(authorize?: false)
      |> Enum.map(&{&1.employee_id, &1.date})

    day_pairs =
      AttendanceDay
      |> Ash.Query.filter(date >= ^from and date <= ^to)
      |> Ash.read!(authorize?: false)
      |> Enum.map(&{&1.employee_id, &1.date})

    recompute(punch_pairs ++ correction_pairs ++ day_pairs)
  end

  @doc """
  月汇总(供工资):输入当月首日,按员工聚合当月日考勤。工日在月层核算
  (= Σ正常工时 ÷ 8 + Σ奖励工日,ADR),日工日只是展示派生不落库。
  Decimal 一律转字符串,避免 JSON 编码歧义。
  """
  def month_summary(%Date{} = first) do
    last = Date.end_of_month(first)

    days =
      AttendanceDay
      |> Ash.Query.filter(date >= ^first and date <= ^last)
      |> Ash.read!(authorize?: false)

    employees =
      case days do
        [] ->
          %{}

        days ->
          ids = days |> Enum.map(& &1.employee_id) |> Enum.uniq()

          Employee
          |> Ash.Query.filter(id in ^ids)
          |> Ash.read!(authorize?: false)
          |> Map.new(&{&1.id, &1})
      end

    days
    |> Enum.group_by(& &1.employee_id)
    |> Enum.map(fn {employee_id, rows} ->
      normal = sum(rows, :normal_hours)
      overtime = sum(rows, :overtime_hours)
      bonus = sum(rows, :bonus_workday)
      workdays = normal |> Decimal.div(Rules.full_day_hours()) |> Decimal.add(bonus)
      employee = employees[employee_id]

      %{
        "employeeId" => employee_id,
        "employeeCode" => employee && employee.code,
        "employeeName" => employee && employee.name,
        "days" => length(rows),
        "missingDays" => Enum.count(rows, &(&1.status == :missing)),
        "normalHours" => Decimal.to_string(normal, :normal),
        "overtimeHours" => Decimal.to_string(overtime, :normal),
        "bonusWorkdays" => Decimal.to_string(bonus, :normal),
        "workdays" => Decimal.to_string(workdays, :normal)
      }
    end)
    |> Enum.sort_by(&{&1["employeeCode"] || "", &1["employeeName"] || ""})
  end

  defp sum(rows, field),
    do: Enum.reduce(rows, Decimal.new(0), &Decimal.add(Map.fetch!(&1, field), &2))

  # 打卡按 (员工集, UTC 跨度) 一次取回,内存归组到精确 (员工, 日) 对
  defp punch_times(pairs) do
    employee_ids = pairs |> Enum.map(&elem(&1, 0)) |> Enum.uniq()
    dates = pairs |> Enum.map(&elem(&1, 1)) |> Enum.uniq()
    {start_utc, _} = dates |> Enum.min(Date) |> Rules.day_range_utc()
    {_, end_utc} = dates |> Enum.max(Date) |> Rules.day_range_utc()
    pair_set = MapSet.new(pairs)

    AttendancePunch
    |> Ash.Query.filter(
      employee_id in ^employee_ids and punched_at >= ^start_utc and punched_at < ^end_utc
    )
    |> Ash.read!(authorize?: false)
    |> Enum.reduce(%{}, fn punch, acc ->
      pair = {punch.employee_id, Rules.local_date(punch.punched_at)}

      if MapSet.member?(pair_set, pair),
        do:
          Map.update(
            acc,
            pair,
            [Rules.local_time(punch.punched_at)],
            &[
              Rules.local_time(punch.punched_at) | &1
            ]
          ),
        else: acc
    end)
  end

  defp correction_times(pairs) do
    employee_ids = pairs |> Enum.map(&elem(&1, 0)) |> Enum.uniq()
    dates = pairs |> Enum.map(&elem(&1, 1)) |> Enum.uniq()
    pair_set = MapSet.new(pairs)

    AttendanceCorrection
    |> Ash.Query.filter(employee_id in ^employee_ids and date in ^dates)
    |> Ash.read!(authorize?: false)
    |> Enum.reduce(%{}, fn correction, acc ->
      pair = {correction.employee_id, correction.date}

      if MapSet.member?(pair_set, pair),
        do: Map.update(acc, pair, correction.times, &(correction.times ++ &1)),
        else: acc
    end)
  end

  defp upsert_days([]), do: :ok

  defp upsert_days(rows) do
    %Ash.BulkResult{status: :success} =
      Ash.bulk_create(rows, AttendanceDay, :create,
        authorize?: false,
        return_errors?: true,
        stop_on_error?: true
      )

    :ok
  end

  defp delete_days([]), do: :ok

  defp delete_days(pairs) do
    employee_ids = pairs |> Enum.map(&elem(&1, 0)) |> Enum.uniq()
    dates = pairs |> Enum.map(&elem(&1, 1)) |> Enum.uniq()
    pair_set = MapSet.new(pairs)

    AttendanceDay
    |> Ash.Query.filter(employee_id in ^employee_ids and date in ^dates)
    |> Ash.read!(authorize?: false)
    |> Enum.filter(&MapSet.member?(pair_set, {&1.employee_id, &1.date}))
    |> Enum.each(&Ash.destroy!(&1, authorize?: false))
  end
end
