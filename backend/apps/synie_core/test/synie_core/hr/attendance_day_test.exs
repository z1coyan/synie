defmodule SynieCore.Hr.AttendanceDayTest do
  # 改全局 storage 配置,不能 async(照 AttendanceImportTest 先例)
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Files
  alias SynieCore.Hr.{AttendanceCorrection, AttendanceDay, AttendanceImport, Employee}
  alias SynieCore.Hr.Attendance.Recompute

  require Ash.Query

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_att_day_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(base, "objects"))

    SynieCore.Files.StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{
      name: "test_local",
      label: "测试本地",
      kind: :local,
      root: Path.join(base, "objects")
    })
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)

    on_exit(fn -> File.rm_rf!(base) end)

    actor =
      actor_with!(
        ~w(sys.file:create sys.file:read hr.attendance_punch:* hr.attendance_day:* hr.attendance_correction:*)
      )

    employee =
      Employee
      |> Ash.Changeset.for_create(:create, %{code: "E0001", name: "张三", attendance_no: "1"})
      |> Ash.create!(authorize?: false)

    %{base: base, actor: actor, employee: employee}
  end

  defp actor_with!(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  defp import!(ctx, content) do
    path = Path.join(ctx.base, "#{System.unique_integer([:positive])}_attlog.dat")
    File.write!(path, content)
    {:ok, %{file: file}} = Files.upload(ctx.actor, %{path: path, filename: "attlog.dat"})

    record =
      AttendanceImport
      |> Ash.Changeset.for_create(:create, %{file_id: file.id}, actor: ctx.actor)
      |> Ash.create!()

    record
    |> Ash.Changeset.for_update(:import, %{auto_create_employees: false}, actor: ctx.actor)
    |> Ash.update!()
  end

  defp day_of(employee, date) do
    AttendanceDay
    |> Ash.Query.filter(employee_id == ^employee.id and date == ^date)
    |> Ash.read_one!(authorize?: false)
  end

  defp correction!(ctx, date, times) do
    AttendanceCorrection
    |> Ash.Changeset.for_create(
      :create,
      %{employee_id: ctx.employee.id, date: date, times: times},
      actor: ctx.actor
    )
    |> Ash.create!()
  end

  defp assert_dec(actual, expected),
    do: assert(Decimal.eq?(actual, Decimal.new(expected)), "期望 #{expected},实得 #{actual}")

  test "导入执行自动生成日考勤(本地日归属含跨 UTC 日)", ctx do
    import!(ctx, """
    1\t2026-07-01 07:58:00
    1\t2026-07-01 11:32:00
    1\t2026-07-01 13:01:00
    1\t2026-07-01 17:29:00
    1\t2026-07-02 13:00:00
    1\t2026-07-02 20:35:00
    """)

    normal = day_of(ctx.employee, ~D[2026-07-01])
    assert normal.morning_in == ~T[07:58:00]
    assert normal.afternoon_out == ~T[17:29:00]
    assert_dec(normal.normal_hours, "7.5")
    assert_dec(normal.overtime_hours, "0")
    assert normal.status == :ok

    overtime = day_of(ctx.employee, ~D[2026-07-02])
    assert overtime.morning_in == nil
    assert_dec(overtime.normal_hours, "4")
    assert_dec(overtime.overtime_hours, "3.5")
    assert_dec(overtime.bonus_workday, "0.5")
  end

  test "补卡单增改删即时重算当天(与真实卡合并取 min/max)", ctx do
    import!(ctx, """
    1\t2026-07-03 08:00:00
    1\t2026-07-03 11:30:00
    """)

    before = day_of(ctx.employee, ~D[2026-07-03])
    assert_dec(before.normal_hours, "3.5")
    assert before.status == :ok

    correction = correction!(ctx, ~D[2026-07-03], [~T[17:30:00], ~T[13:00:00]])
    # 规整:排序去重截秒
    assert correction.times == [~T[13:00:00], ~T[17:30:00]]

    added = day_of(ctx.employee, ~D[2026-07-03])
    assert added.afternoon_in == ~T[13:00:00]
    assert_dec(added.normal_hours, "7.5")
    assert_dec(added.overtime_hours, "0.5")

    correction
    |> Ash.Changeset.for_update(:update, %{times: [~T[13:00:00]]}, actor: ctx.actor)
    |> Ash.update!()

    # 下午只剩单卡=缺卡
    updated = day_of(ctx.employee, ~D[2026-07-03])
    assert updated.status == :missing
    assert_dec(updated.normal_hours, "3.5")

    Ash.destroy!(correction, actor: ctx.actor)

    removed = day_of(ctx.employee, ~D[2026-07-03])
    assert removed.afternoon_in == nil
    assert_dec(removed.normal_hours, "3.5")
    assert removed.status == :ok
  end

  test "纯补卡日生成行;撤销批次后有补卡的天重写、无卡的天清行", ctx do
    record =
      import!(ctx, """
      1\t2026-07-06 08:00:00
      1\t2026-07-06 11:30:00
      1\t2026-07-07 08:00:00
      1\t2026-07-07 11:30:00
      """)

    correction!(ctx, ~D[2026-07-07], [~T[13:00:00], ~T[17:00:00]])
    correction!(ctx, ~D[2026-07-08], [~T[08:30:00], ~T[11:30:00]])

    # 纯补卡(2026-07-08 无真实卡)也生成行
    pure = day_of(ctx.employee, ~D[2026-07-08])
    assert_dec(pure.normal_hours, "3")

    Ash.destroy!(record, actor: ctx.actor)

    # 无补卡的 07-06 行清掉;07-07 剩补卡重写(打卡已级联删)
    assert day_of(ctx.employee, ~D[2026-07-06]) == nil
    remained = day_of(ctx.employee, ~D[2026-07-07])
    assert remained.morning_in == nil
    assert_dec(remained.normal_hours, "4")
  end

  test "recalc 区间重算兜底:补正被人为删掉的行,清理孤儿行", ctx do
    import!(ctx, """
    1\t2026-07-09 08:00:00
    1\t2026-07-09 11:30:00
    """)

    # 人为删行 + 人为造孤儿行
    day_of(ctx.employee, ~D[2026-07-09]) |> Ash.destroy!(authorize?: false)

    AttendanceDay
    |> Ash.Changeset.for_create(:create, %{
      employee_id: ctx.employee.id,
      date: ~D[2026-07-10],
      normal_hours: Decimal.new(8),
      overtime_hours: Decimal.new(0),
      bonus_workday: Decimal.new(0),
      status: :ok
    })
    |> Ash.create!(authorize?: false)

    count =
      AttendanceDay
      |> Ash.ActionInput.for_action(
        :recalc,
        %{date_from: ~D[2026-07-09], date_to: ~D[2026-07-10]},
        actor: ctx.actor
      )
      |> Ash.run_action!()

    assert count == 2
    assert_dec(day_of(ctx.employee, ~D[2026-07-09]).normal_hours, "3.5")
    assert day_of(ctx.employee, ~D[2026-07-10]) == nil
  end

  test "月汇总:工日在月层核算 = Σ正常工时÷8 + Σ奖励工日", ctx do
    import!(ctx, """
    1\t2026-07-01 07:58:00
    1\t2026-07-01 11:32:00
    1\t2026-07-01 13:01:00
    1\t2026-07-01 17:29:00
    1\t2026-07-02 13:00:00
    1\t2026-07-02 20:35:00
    1\t2026-07-03 08:00:00
    """)

    assert [row] = Recompute.month_summary(~D[2026-07-01])
    assert row["employeeId"] == ctx.employee.id
    assert row["employeeName"] == "张三"
    assert row["days"] == 3
    assert row["missingDays"] == 1
    # 11.5 正常工时 ÷ 8 + 0.5 奖励 = 1.9375
    assert row["normalHours"] == "11.5"
    assert row["overtimeHours"] == "3.5"
    assert row["bonusWorkdays"] == "0.5"
    assert row["workdays"] == "1.9375"
  end

  test "权限 fail-closed:无码不可读日考勤、不可重算、不可建补卡", ctx do
    nobody = actor_with!(~w(hr.attendance_punch:read))

    assert_raise Ash.Error.Forbidden, fn ->
      AttendanceDay |> Ash.Query.for_read(:read, %{}, actor: nobody) |> Ash.read!()
    end

    assert_raise Ash.Error.Forbidden, fn ->
      AttendanceDay
      |> Ash.ActionInput.for_action(
        :recalc,
        %{date_from: ~D[2026-07-01], date_to: ~D[2026-07-02]},
        actor: nobody
      )
      |> Ash.run_action!()
    end

    assert_raise Ash.Error.Forbidden, fn ->
      AttendanceCorrection
      |> Ash.Changeset.for_create(
        :create,
        %{employee_id: ctx.employee.id, date: ~D[2026-07-01], times: [~T[08:00:00]]},
        actor: nobody
      )
      |> Ash.create!()
    end
  end
end
