defmodule SynieCore.Hr.AttendanceImportTest do
  # 改全局 storage 配置,不能 async(照 BankImportTest 先例)
  use ExUnit.Case, async: false

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Files
  alias SynieCore.Hr.AttendanceImport
  alias SynieCore.Hr.AttendancePunch
  alias SynieCore.Hr.Employee
  alias SynieCore.Numbering

  require Ash.Query

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_att_import_#{System.unique_integer([:positive])}")
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

    %{base: base, actor: actor_with!(~w(sys.file:create sys.file:read hr.attendance_punch:*))}
  end

  defp actor_with!(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  defp employee!(attrs) do
    Employee
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # 员工编号规则:自动建员工的 code 走 AutoNumber
  defp numbering_rule! do
    Numbering.Rule
    |> Ash.Changeset.for_create(
      :create,
      %{
        resource: "hr.employee",
        name: "员工编号",
        per_company: false,
        segments: [%{"type" => "text", "value" => "E"}, %{"type" => "seq", "padding" => 4}]
      },
      authorize?: false
    )
    |> Ash.create!()
  end

  defp upload!(ctx, content, filename \\ "attlog.dat") do
    path = Path.join(ctx.base, "#{System.unique_integer([:positive])}_#{filename}")
    File.write!(path, content)
    {:ok, %{file: file}} = Files.upload(ctx.actor, %{path: path, filename: filename})
    file.id
  end

  defp create_import!(ctx, content) do
    AttendanceImport
    |> Ash.Changeset.for_create(:create, %{file_id: upload!(ctx, content)}, actor: ctx.actor)
    |> Ash.create!()
  end

  defp run_import(record, actor, auto_create? \\ false) do
    record
    |> Ash.Changeset.for_update(:import, %{auto_create_employees: auto_create?}, actor: actor)
    |> Ash.update()
  end

  defp punches_of(record) do
    AttendancePunch
    |> Ash.Query.filter(import_id == ^record.id)
    |> Ash.Query.sort(punched_at: :asc)
    |> Ash.read!(authorize?: false)
  end

  test "create 即解析出摘要预览,暂存行不落库", ctx do
    employee!(%{code: "E1", name: "张三", attendance_no: "1"})

    record =
      create_import!(ctx, """
      1\t2026-07-01 08:00:00
      1\t2026-07-01 08:00:00
      1\t2026-07-01 18:00:00
      8801\t2026-07-01 08:01:00
      8801\t2026-07-01 18:01:00
      8802\t2026-07-01 08:02:00
      坏行
      """)

    assert record.status == :parsed
    assert record.total_rows == 7
    assert record.bad_rows == 1
    assert record.dup_rows == 1
    assert record.matched_rows == 2
    assert record.unmatched_rows == 3
    assert record.unmatched_detail == "8801×2、8802×1"
    # 暂存行不落库:解析预览阶段打卡表零写入
    assert punches_of(record) == []
  end

  test "全坏行文件置 failed 并留原因,不 raise", ctx do
    record = create_import!(ctx, "garbage\nmore\n")

    assert record.status == :failed
    assert record.error =~ "未解析到有效打卡行"
  end

  test "同文件(sha256)重复建批次被拒", ctx do
    content = "1\t2026-07-01 08:00:00\n"
    create_import!(ctx, content)

    assert_raise Ash.Error.Invalid, ~r/已存在相同文件的导入批次/, fn ->
      create_import!(ctx, content)
    end
  end

  test "执行导入:已匹配行直写打卡表,未匹配行跳过计数,状态 imported", ctx do
    emp = employee!(%{code: "E1", name: "张三", attendance_no: "1"})

    record =
      create_import!(ctx, """
      1\t2026-07-01 08:00:00
      1\t2026-07-01 18:00:00
      8801\t2026-07-01 08:01:00
      """)

    {:ok, done} = run_import(record, ctx.actor)

    assert done.status == :imported
    assert done.imported_count == 2
    assert done.skipped_unmatched_rows == 1
    assert done.skipped_existing_rows == 0
    assert done.auto_created_count == 0
    assert done.imported_at != nil

    assert [p1, p2] = punches_of(done)
    assert p1.employee_id == emp.id
    assert p1.attendance_no == "1"
    # +08 本地时间转 UTC 存
    assert p1.punched_at == ~U[2026-07-01 00:00:00Z]
    assert p2.punched_at == ~U[2026-07-01 10:00:00Z]
  end

  test "重叠区间重导幂等:库中已存在的 (员工,时刻) 静默跳过", ctx do
    employee!(%{code: "E1", name: "张三", attendance_no: "1"})

    first = create_import!(ctx, "1\t2026-07-01 08:00:00\n1\t2026-07-01 18:00:00\n")
    {:ok, _} = run_import(first, ctx.actor)

    # 第二个文件与第一个区间重叠(多一行新打卡;内容不同故 sha 防重不拦)
    second = create_import!(ctx, "1\t2026-07-01 08:00:00\n1\t2026-07-02 08:00:00\n")
    {:ok, done} = run_import(second, ctx.actor)

    assert done.imported_count == 1
    assert done.skipped_existing_rows == 1
    assert length(punches_of(done)) == 1

    assert AttendancePunch
           |> Ash.Query.filter(attendance_no == "1")
           |> Ash.count!(authorize?: false) == 3
  end

  test "勾选自动建员工:缺员工按编号补建(姓名[未知]、code 走编号规则)", ctx do
    numbering_rule!()
    employee!(%{code: "E1", name: "张三", attendance_no: "1"})

    actor =
      actor_with!(~w(sys.file:create sys.file:read hr.attendance_punch:* hr.employee:create))

    record =
      create_import!(ctx, """
      1\t2026-07-01 08:00:00
      8801\t2026-07-01 08:01:00
      8801\t2026-07-01 18:01:00
      """)

    {:ok, done} = run_import(record, actor, true)

    assert done.auto_created_count == 1
    assert done.imported_count == 3
    assert done.skipped_unmatched_rows == 0

    created =
      Employee |> Ash.Query.filter(attendance_no == "8801") |> Ash.read_one!(authorize?: false)

    assert created.name == "[未知]"
    assert created.code =~ ~r/^E\d{4}$/
  end

  test "无员工新增权限勾选自动建被拒,fail-closed", ctx do
    numbering_rule!()

    record = create_import!(ctx, "8801\t2026-07-01 08:01:00\n")

    assert {:error, %Ash.Error.Invalid{} = err} = run_import(record, ctx.actor, true)
    assert Exception.message(err) =~ "无权自动创建员工"
    # 事务回滚:员工与打卡都没建
    assert Employee |> Ash.Query.filter(attendance_no == "8801") |> Ash.count!(authorize?: false) ==
             0
  end

  test "未配置员工编号规则时自动建报可读错误", ctx do
    actor =
      actor_with!(~w(sys.file:create sys.file:read hr.attendance_punch:* hr.employee:create))

    record = create_import!(ctx, "8801\t2026-07-01 08:01:00\n")

    assert {:error, err} = run_import(record, actor, true)
    assert Exception.message(err) =~ "自动创建员工失败"
    assert Exception.message(err) =~ "编号规则"
  end

  test "仅 parsed 态可执行:已导入批次再执行被拒", ctx do
    employee!(%{code: "E1", name: "张三", attendance_no: "1"})
    record = create_import!(ctx, "1\t2026-07-01 08:00:00\n")
    {:ok, done} = run_import(record, ctx.actor)

    assert {:error, err} = run_import(done, ctx.actor)
    assert Exception.message(err) =~ "仅「已解析」状态的批次可执行导入"
  end

  test "删除批次即整批撤销:打卡库级联删,任何状态可删", ctx do
    employee!(%{code: "E1", name: "张三", attendance_no: "1"})
    record = create_import!(ctx, "1\t2026-07-01 08:00:00\n1\t2026-07-01 18:00:00\n")
    {:ok, done} = run_import(record, ctx.actor)
    assert length(punches_of(done)) == 2

    done
    |> Ash.Changeset.for_destroy(:destroy, %{}, actor: ctx.actor)
    |> Ash.destroy!()

    assert AttendancePunch |> Ash.Query.filter(true) |> Ash.count!(authorize?: false) == 0
  end

  test "权限 fail-closed:无 import 码不能建批次", ctx do
    actor = actor_with!(~w(sys.file:create sys.file:read))
    file_id = upload!(ctx, "1\t2026-07-01 08:00:00\n")

    assert_raise Ash.Error.Forbidden, fn ->
      AttendanceImport
      |> Ash.Changeset.for_create(:create, %{file_id: file_id}, actor: actor)
      |> Ash.create!()
    end
  end

  test "资源声明了权限前缀,批次复用打卡的 import 码" do
    assert AttendancePunch.permission_prefix() == "hr.attendance_punch"
    assert AttendancePunch.permission_actions() == ~w(read import)
    assert AttendanceImport.permission_prefix() == "hr.attendance_punch"
    assert AttendanceImport.permission_actions() == []
  end
end
