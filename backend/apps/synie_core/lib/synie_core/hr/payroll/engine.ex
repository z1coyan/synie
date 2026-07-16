defmodule SynieCore.Hr.Payroll.Engine do
  @moduledoc """
  工资单引擎:按月批量生成(考勤月汇总 + 员工档案快照)、单员工考勤快照、月度统计。

  内部读写一律 `authorize?: false` 受信路径(调用方动作级权限已校验,照
  `SynieCore.Hr.Attendance.Recompute` 先例);生成逐行走 Payroll `:create`
  并透传 actor,审计留痕不绕过(ADR)。
  """

  require Ash.Query

  alias SynieCore.Hr.{AttendanceDay, Employee, Payroll}
  alias SynieCore.Hr.Attendance.Rules

  @zero Decimal.new(0)

  @empty_snapshot %{
    workdays: @zero,
    attendance_days: 0,
    missing_days: 0,
    overtime_hours: @zero
  }

  @doc """
  按月批量生成工资单:考勤月汇总有行的员工每人一张,(员工, 月) 已存在跳过不覆盖。
  返回 `%{"created" => n, "skipped" => n}`。
  """
  def generate(%Date{} = first, month, actor) do
    snapshots = attendance_snapshots(first)

    existing =
      Payroll
      |> Ash.Query.filter(month == ^month)
      |> Ash.read!(authorize?: false)
      |> MapSet.new(& &1.employee_id)

    to_create = Map.drop(snapshots, MapSet.to_list(existing))

    employees =
      case Map.keys(to_create) do
        [] ->
          %{}

        ids ->
          Employee
          |> Ash.Query.filter(id in ^ids)
          |> Ash.read!(authorize?: false)
          |> Map.new(&{&1.id, &1})
      end

    Enum.each(to_create, fn {employee_id, snap} ->
      employee = Map.fetch!(employees, employee_id)

      Payroll
      |> Ash.Changeset.for_create(
        :create,
        %{
          employee_id: employee_id,
          month: month,
          workdays: snap.workdays,
          attendance_days: snap.attendance_days,
          missing_days: snap.missing_days,
          overtime_hours: snap.overtime_hours,
          daily_wage: employee.daily_wage || @zero,
          allowance: employee.monthly_allowance || @zero
        },
        actor: actor,
        authorize?: false
      )
      |> Ash.create!(authorize?: false)
    end)

    %{"created" => map_size(to_create), "skipped" => MapSet.size(existing)}
  end

  @doc "单员工当月考勤快照(refresh 用);无考勤行返回全零快照"
  def attendance_snapshot(%Date{} = first, employee_id) do
    first
    |> attendance_snapshots(employee_id)
    |> Map.get(employee_id, @empty_snapshot)
  end

  @doc """
  当月考勤快照:`%{employee_id => %{workdays, attendance_days, missing_days, overtime_hours}}`,
  无考勤行的员工不出现。月工日 = Σ正常工时 ÷ 8 + Σ奖励工日(考勤 ADR,与
  `Recompute.month_summary/1` 同式,此处保留 Decimal 供落库)。
  """
  def attendance_snapshots(%Date{} = first, employee_id \\ nil) do
    last = Date.end_of_month(first)

    query =
      AttendanceDay
      |> Ash.Query.filter(date >= ^first and date <= ^last)

    query =
      if employee_id,
        do: Ash.Query.filter(query, employee_id == ^employee_id),
        else: query

    query
    |> Ash.read!(authorize?: false)
    |> Enum.group_by(& &1.employee_id)
    |> Map.new(fn {id, rows} ->
      normal = sum(rows, :normal_hours)

      workdays =
        normal
        |> Decimal.div(Rules.full_day_hours())
        |> Decimal.add(sum(rows, :bonus_workday))

      {id,
       %{
         workdays: workdays,
         attendance_days: length(rows),
         missing_days: Enum.count(rows, &(&1.status == :missing)),
         overtime_hours: sum(rows, :overtime_hours)
       }}
    end)
  end

  @doc """
  月度统计(工资单列表页统计条):工资单数/未发放数/应发合计/实发合计。
  Decimal 一律转字符串(照 `month_summary` 先例)。
  """
  def month_stats(month) do
    payrolls =
      Payroll
      |> Ash.Query.filter(month == ^month)
      |> Ash.Query.load(:paid_total)
      |> Ash.read!(authorize?: false)

    payable = Enum.reduce(payrolls, @zero, &Decimal.add(&1.payable, &2))

    paid =
      Enum.reduce(payrolls, @zero, &Decimal.add(&1.paid_total || @zero, &2))

    %{
      "count" => length(payrolls),
      "pendingCount" => Enum.count(payrolls, &(&1.status == :pending)),
      "payableTotal" => Decimal.to_string(payable, :normal),
      "paidTotal" => Decimal.to_string(paid, :normal)
    }
  end

  @doc "解析 YYYY-MM 月份串为当月首日"
  def parse_month(month) when is_binary(month) do
    case Date.from_iso8601(month <> "-01") do
      {:ok, first} -> {:ok, first}
      _ -> :error
    end
  end

  def parse_month(_), do: :error

  defp sum(rows, field),
    do: Enum.reduce(rows, @zero, &Decimal.add(Map.fetch!(&1, field), &2))
end
