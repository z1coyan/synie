defmodule SynieCore.Hr.EmployeeTest do
  use ExUnit.Case, async: true

  alias SynieCore.Hr.Employee

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp employee!(attrs) do
    Employee
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  test "创建员工:全字段" do
    emp =
      employee!(%{
        code: "E0001",
        name: "张三",
        attendance_no: "AT-01",
        id_number: "110101199001011234",
        household_registration: "北京市东城区",
        phone: "13800000000",
        current_address: "上海市浦东新区",
        daily_wage: "300.5",
        monthly_allowance: "800"
      })

    assert emp.code == "E0001"
    assert emp.name == "张三"
    assert Decimal.eq?(emp.daily_wage, Decimal.new("300.5"))
    assert Decimal.eq?(emp.monthly_allowance, Decimal.new("800"))
  end

  test "参保类型:原子险种多选任意组合,默认空" do
    emp = employee!(%{code: "EI01", name: "张三"})
    assert emp.insurance_types == []

    emp2 =
      employee!(%{
        code: "EI02",
        name: "李四",
        insurance_types: [:social_injury, :housing_fund, :commercial_injury]
      })

    assert emp2.insurance_types == [:social_injury, :housing_fund, :commercial_injury]

    updated =
      emp2
      |> Ash.Changeset.for_update(:update, %{insurance_types: [:social_pension]})
      |> Ash.update!(authorize?: false)

    assert updated.insurance_types == [:social_pension]
  end

  test "员工编号唯一" do
    employee!(%{code: "E0001", name: "张三"})

    assert_raise Ash.Error.Invalid, ~r/员工编号已存在/, fn ->
      employee!(%{code: "E0001", name: "李四"})
    end
  end

  test "身份证号唯一,未填不受限" do
    employee!(%{code: "E0001", name: "张三", id_number: "110101199001011234"})

    assert_raise Ash.Error.Invalid, ~r/身份证号已存在/, fn ->
      employee!(%{code: "E0002", name: "李四", id_number: "110101199001011234"})
    end

    # 身份证号留空的员工可以有多个
    employee!(%{code: "E0003", name: "王五"})
    employee!(%{code: "E0004", name: "赵六"})
  end

  test "考勤机编号唯一,未填不受限" do
    employee!(%{code: "E0001", name: "张三", attendance_no: "1"})

    assert_raise Ash.Error.Invalid, ~r/考勤机编号已存在/, fn ->
      employee!(%{code: "E0002", name: "李四", attendance_no: "1"})
    end

    employee!(%{code: "E0003", name: "王五"})
    employee!(%{code: "E0004", name: "赵六"})
  end

  test "编号留空且未配置编号规则时报错提示" do
    assert_raise Ash.Error.Invalid, ~r/未配置启用的编号规则/, fn ->
      employee!(%{name: "张三"})
    end
  end

  test "日薪/月补贴不能为负数" do
    assert_raise Ash.Error.Invalid, ~r/日薪不能为负数/, fn ->
      employee!(%{code: "E0001", name: "张三", daily_wage: "-1"})
    end

    assert_raise Ash.Error.Invalid, ~r/月补贴不能为负数/, fn ->
      employee!(%{code: "E0002", name: "李四", monthly_allowance: "-1"})
    end
  end

  test "资源声明了权限前缀" do
    assert Employee.permission_prefix() == "hr.employee"
    assert "create" in Employee.permission_actions()
  end
end
