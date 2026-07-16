defmodule SynieCore.Hr.PayrollTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.Actor
  alias SynieCore.Hr.{AttendanceDay, Employee, EmployeeLoan, Payroll, PayrollPayment}
  alias SynieCore.Hr.Payroll.Engine

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp employee!(attrs) do
    Employee
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{code: "E#{System.unique_integer([:positive])}", name: "测试员工"}, attrs)
    )
    |> Ash.create!(authorize?: false)
  end

  defp day!(employee, date, attrs) do
    AttendanceDay
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          employee_id: employee.id,
          date: date,
          normal_hours: Decimal.new(8),
          overtime_hours: Decimal.new(0),
          bonus_workday: Decimal.new(0),
          status: :ok
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp payroll!(employee, attrs) do
    Payroll
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{employee_id: employee.id, month: "2026-06"}, attrs)
    )
    |> Ash.create!(authorize?: false)
  end

  defp payment!(payroll, attrs) do
    PayrollPayment
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{payroll_id: payroll.id, paid_on: ~D[2026-07-05], amount: Decimal.new(100)},
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp loan!(employee, attrs) do
    EmployeeLoan
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          employee_id: employee.id,
          kind: :borrow,
          occurred_on: ~D[2026-06-01],
          amount: Decimal.new(500)
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp reload(payroll), do: Ash.get!(Payroll, payroll.id, authorize?: false)

  defp actor(permissions) do
    %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(permissions)}
  end

  test "generate 按考勤月汇总建单并快照员工档案,已存在跳过不覆盖" do
    employee = employee!(%{daily_wage: Decimal.new(150), monthly_allowance: Decimal.new(300)})
    day!(employee, ~D[2026-06-01], %{})

    day!(employee, ~D[2026-06-02], %{
      overtime_hours: Decimal.new(4),
      bonus_workday: Decimal.new("0.5"),
      status: :missing
    })

    assert %{"created" => 1, "skipped" => 0} =
             Engine.generate(~D[2026-06-01], "2026-06", nil)

    [payroll] = Ash.read!(Payroll, authorize?: false)
    assert payroll.month == "2026-06"
    # 月工日 = 16/8 + 0.5
    assert Decimal.equal?(payroll.workdays, Decimal.new("2.5"))
    assert payroll.attendance_days == 2
    assert payroll.missing_days == 1
    assert Decimal.equal?(payroll.overtime_hours, Decimal.new(4))
    assert Decimal.equal?(payroll.daily_wage, Decimal.new(150))
    assert Decimal.equal?(payroll.allowance, Decimal.new(300))
    # 基本工资 = 2.5×150,应发 = 375+300
    assert Decimal.equal?(payroll.base_amount, Decimal.new(375))
    assert Decimal.equal?(payroll.payable, Decimal.new(675))
    assert payroll.status == :pending

    # 手工调整后重复生成不覆盖
    payroll
    |> Ash.Changeset.for_update(:update, %{bonus: Decimal.new(100)})
    |> Ash.update!(authorize?: false)

    assert %{"created" => 0, "skipped" => 1} =
             Engine.generate(~D[2026-06-01], "2026-06", nil)

    assert Decimal.equal?(reload(payroll).bonus, Decimal.new(100))
  end

  test "应发 = 工日×日薪 + 补贴 + 奖金 − 罚款 − 借款抵扣,改单自动重算" do
    employee = employee!(%{})

    payroll =
      payroll!(employee, %{
        workdays: Decimal.new("21.5625"),
        daily_wage: Decimal.new(160),
        allowance: Decimal.new(200),
        bonus: Decimal.new(50),
        fine: Decimal.new(30),
        loan_deduction: Decimal.new(100)
      })

    # 21.5625×160 = 3450.00(round 2)
    assert Decimal.equal?(payroll.base_amount, Decimal.new(3450))
    assert Decimal.equal?(payroll.payable, Decimal.new(3570))

    updated =
      payroll
      |> Ash.Changeset.for_update(:update, %{fine: Decimal.new(0)})
      |> Ash.update!(authorize?: false)

    assert Decimal.equal?(updated.payable, Decimal.new(3600))
  end

  test "首笔发放翻转已发放并判别类型,补发追加,金额去规范化可聚合" do
    employee = employee!(%{})
    payroll = payroll!(employee, %{workdays: Decimal.new(10), daily_wage: Decimal.new(100)})

    first = payment!(payroll, %{amount: Decimal.new(900)})
    assert first.kind == :normal
    assert first.employee_id == employee.id
    assert first.month == "2026-06"
    assert reload(payroll).status == :paid

    second = payment!(payroll, %{amount: Decimal.new(100)})
    assert second.kind == :supplement

    loaded = Ash.get!(Payroll, payroll.id, load: [:paid_total], authorize?: false)
    assert Decimal.equal?(loaded.paid_total, Decimal.new(1000))
  end

  test "已发放工资单禁改禁删,发放记录全删自动翻回待发放" do
    employee = employee!(%{})
    payroll = payroll!(employee, %{workdays: Decimal.new(1), daily_wage: Decimal.new(100)})
    payment = payment!(payroll, %{})

    assert_raise Ash.Error.Invalid, fn ->
      payroll
      |> Ash.Changeset.for_update(:update, %{bonus: Decimal.new(1)})
      |> Ash.update!(authorize?: false)
    end

    assert_raise Ash.Error.Invalid, fn ->
      payroll |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    end

    :ok = payment |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    assert reload(payroll).status == :pending

    # 翻回后可改可删
    payroll
    |> Ash.Changeset.for_update(:update, %{bonus: Decimal.new(1)})
    |> Ash.update!(authorize?: false)

    :ok = payroll |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
  end

  test "发放金额不能为零,负数冲回允许" do
    employee = employee!(%{})
    payroll = payroll!(employee, %{workdays: Decimal.new(1), daily_wage: Decimal.new(100)})

    assert_raise Ash.Error.Invalid, fn ->
      payment!(payroll, %{amount: Decimal.new(0)})
    end

    payment!(payroll, %{amount: Decimal.new(200)})
    refund = payment!(payroll, %{amount: Decimal.new(-50)})
    assert refund.kind == :supplement

    loaded = Ash.get!(Payroll, payroll.id, load: [:paid_total], authorize?: false)
    assert Decimal.equal?(loaded.paid_total, Decimal.new(150))
  end

  test "借款抵扣联动:发放生成台账归还行,回退删除;余额不足拒发" do
    employee = employee!(%{})
    loan!(employee, %{amount: Decimal.new(500)})

    payroll =
      payroll!(employee, %{
        workdays: Decimal.new(10),
        daily_wage: Decimal.new(100),
        loan_deduction: Decimal.new(200)
      })

    payment = payment!(payroll, %{amount: Decimal.new(800)})

    assert Decimal.equal?(EmployeeLoan.balance(employee.id), Decimal.new(300))

    auto =
      EmployeeLoan
      |> Ash.read!(authorize?: false)
      |> Enum.find(&(&1.payroll_id == payroll.id))

    assert auto.kind == :repay
    assert Decimal.equal?(auto.amount, Decimal.new(200))
    assert auto.occurred_on == payment.paid_on

    # 自动行禁手改手删
    assert_raise Ash.Error.Invalid, fn ->
      auto
      |> Ash.Changeset.for_update(:update, %{amount: Decimal.new(1)})
      |> Ash.update!(authorize?: false)
    end

    assert_raise Ash.Error.Invalid, fn ->
      auto |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    end

    # 删除发放记录:翻回待发放并删联动归还行,余额恢复
    :ok = payment |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    assert reload(payroll).status == :pending
    assert Decimal.equal?(EmployeeLoan.balance(employee.id), Decimal.new(500))

    # 抵扣超余额拒发
    over =
      payroll
      |> Ash.Changeset.for_update(:update, %{loan_deduction: Decimal.new(600)})
      |> Ash.update!(authorize?: false)

    assert_raise Ash.Error.Invalid, fn -> payment!(over, %{amount: Decimal.new(400)}) end
    assert reload(payroll).status == :pending
  end

  test "pay_remaining 一键发放:锁内按未发差额计价,无差额拒绝" do
    employee = employee!(%{})
    payroll = payroll!(employee, %{workdays: Decimal.new(10), daily_wage: Decimal.new(100)})

    pay_remaining = fn ->
      PayrollPayment
      |> Ash.Changeset.for_create(:pay_remaining, %{
        payroll_id: payroll.id,
        paid_on: ~D[2026-07-05]
      })
      |> Ash.create!(authorize?: false)
    end

    paid = pay_remaining.()
    assert Decimal.equal?(paid.amount, Decimal.new(1000))
    assert paid.kind == :normal
    assert reload(payroll).status == :paid

    # 已无差额再发被拒(防过期差额重复发放)
    assert_raise Ash.Error.Invalid, fn -> pay_remaining.() end

    # 部分发放后一键补齐:金额=剩余差额,类型=补发
    :ok = paid |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    payment!(payroll, %{amount: Decimal.new(400)})

    supplement = pay_remaining.()
    assert Decimal.equal?(supplement.amount, Decimal.new(600))
    assert supplement.kind == :supplement
  end

  test "补发不再校验借款余额,也不再生成归还行" do
    employee = employee!(%{})
    loan!(employee, %{amount: Decimal.new(300)})

    payroll =
      payroll!(employee, %{
        workdays: Decimal.new(10),
        daily_wage: Decimal.new(100),
        loan_deduction: Decimal.new(300)
      })

    payment!(payroll, %{amount: Decimal.new(700)})
    assert Decimal.equal?(EmployeeLoan.balance(employee.id), Decimal.new(0))

    # 已发放后补发:余额已为零也不拦、不重复生成归还行
    payment!(payroll, %{amount: Decimal.new(50)})

    repays =
      EmployeeLoan
      |> Ash.read!(authorize?: false)
      |> Enum.count(&(&1.payroll_id == payroll.id))

    assert repays == 1
  end

  test "refresh 重取考勤与员工档案快照,仅待发放可用" do
    employee = employee!(%{daily_wage: Decimal.new(100), monthly_allowance: Decimal.new(0)})
    day!(employee, ~D[2026-06-01], %{})
    Engine.generate(~D[2026-06-01], "2026-06", nil)

    [payroll] = Ash.read!(Payroll, authorize?: false)
    assert Decimal.equal?(payroll.workdays, Decimal.new(1))

    # 补卡后考勤重算多出一天,日薪也调了
    day!(employee, ~D[2026-06-02], %{})

    employee
    |> Ash.Changeset.for_update(:update, %{daily_wage: Decimal.new(120)})
    |> Ash.update!(authorize?: false)

    refreshed =
      payroll
      |> Ash.Changeset.for_update(:refresh, %{})
      |> Ash.update!(authorize?: false)

    assert Decimal.equal?(refreshed.workdays, Decimal.new(2))
    assert Decimal.equal?(refreshed.daily_wage, Decimal.new(120))
    assert Decimal.equal?(refreshed.payable, Decimal.new(240))

    payment!(payroll, %{})

    assert_raise Ash.Error.Invalid, fn ->
      payroll |> Ash.Changeset.for_update(:refresh, %{}) |> Ash.update!(authorize?: false)
    end
  end

  test "(员工, 月) 唯一" do
    employee = employee!(%{})
    payroll!(employee, %{})

    assert_raise Ash.Error.Invalid, fn -> payroll!(employee, %{}) end
  end

  test "月份格式必须为 YYYY-MM" do
    employee = employee!(%{})

    assert_raise Ash.Error.Invalid, fn -> payroll!(employee, %{month: "2026-13"}) end
    assert_raise Ash.Error.Invalid, fn -> payroll!(employee, %{month: "202606"}) end
  end

  test "month_stats 出月度应发/实发合计" do
    employee_a = employee!(%{})
    employee_b = employee!(%{})

    payroll_a =
      payroll!(employee_a, %{workdays: Decimal.new(10), daily_wage: Decimal.new(100)})

    payroll!(employee_b, %{workdays: Decimal.new(20), daily_wage: Decimal.new(100)})

    payment!(payroll_a, %{amount: Decimal.new(600)})

    stats = Engine.month_stats("2026-06")
    assert stats["count"] == 2
    assert stats["pendingCount"] == 1
    assert stats["payableTotal"] == "3000.00"
    assert stats["paidTotal"] == "600"
  end

  test "借款余额汇总按员工聚合" do
    employee = employee!(%{code: "E0001", name: "张三"})
    loan!(employee, %{amount: Decimal.new(500)})
    loan!(employee, %{kind: :repay, amount: Decimal.new(100), occurred_on: ~D[2026-06-15]})

    assert [row] = EmployeeLoan.balances_summary()
    assert row["employeeName"] == "张三"
    assert row["borrowed"] == "500"
    assert row["repaid"] == "100"
    assert row["balance"] == "400"
  end

  test "台账金额必须大于零" do
    employee = employee!(%{})

    assert_raise Ash.Error.Invalid, fn -> loan!(employee, %{amount: Decimal.new(0)}) end
    assert_raise Ash.Error.Invalid, fn -> loan!(employee, %{amount: Decimal.new(-10)}) end
  end

  test "权限:有码可读,无码被拒;前缀与动作声明" do
    employee = employee!(%{})
    payroll!(employee, %{})

    assert [_] = Ash.read!(Payroll, actor: actor(["hr.payroll:read"]))
    assert_raise Ash.Error.Forbidden, fn -> Ash.read!(Payroll, actor: actor([])) end

    assert Payroll.permission_prefix() == "hr.payroll"
    assert Payroll.permission_actions() == ~w(create read update delete)
    assert PayrollPayment.permission_prefix() == "hr.payroll_payment"
    assert PayrollPayment.permission_actions() == ~w(create read delete)
    assert EmployeeLoan.permission_prefix() == "hr.employee_loan"
    assert EmployeeLoan.permission_actions() == ~w(create read update delete)
  end
end
