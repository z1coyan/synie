defmodule SynieCore.Hr.PayrollStatus do
  @moduledoc "工资单状态:待发放/已发放,由发放记录驱动翻转,不可手改。"

  use Ash.Type.Enum, values: [pending: "待发放", paid: "已发放"]

  def graphql_type(_), do: :hr_payroll_status
end

defmodule SynieCore.Hr.PayrollPending do
  @moduledoc "校验工资单处于待发放态(修改/删除的前提,构建期预检)。"
  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :pending,
      do: :ok,
      else: {:error, message: "仅待发放工资单可修改或删除,差错请走补发"}
  end
end

defmodule SynieCore.Hr.Payroll do
  @moduledoc """
  月工资单,对应 `hr_payroll` 表。(员工, 月) 唯一的薪资快照单据,
  决策见 docs/adr/2026-07-16-payroll.md。

  应发 = 工日×日薪(基本工资,四舍五入到分)+ 补贴 + 奖金 − 罚款 − 借款抵扣;
  `base_amount`/`payable` 持久落库、随改单自动重算,不可手填。工日/加班/缺卡
  快照自考勤月汇总,日薪/补贴快照自员工档案;`generate` 按月批量建单(已存在
  跳过不覆盖),`refresh` 重取快照,均见 `SynieCore.Hr.Payroll.Engine`。

  状态由发放记录驱动:首笔发放翻转已发放、发放记录全删翻回待发放
  (`mark_paid`/`mark_pending` 仅发放联动的内部路径调用)。待发放可改可删,
  已发放全字段锁死,差错走补发不回头改单。实发合计 = 发放记录 sum 聚合列。
  全局不挂公司(照 hr 域先例)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "hr_payroll"
    repo SynieCore.Repo

    custom_indexes do
      # 列表/统计按月筛;(employee_id, month) 唯一索引由 identity 生成
      index [:month]
    end
  end

  graphql do
    type :hr_payroll
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 衍生动作复用既有码不新设权限点:批量生成=批量新增、重取快照=改单、月统计=读
    policy action(:generate) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    policy action(:refresh) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end

    policy action(:month_stats) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    # 状态翻转仅由发放记录联动(authorize?: false 内部路径);策略留作纵深防御,归口改单码
    policy action([:mark_paid, :mark_pending]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end

    policy action([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "hr.payroll"
  def permission_label, do: "工资单"
  def permission_actions, do: ~w(create read update delete)

  # refresh 复用 update 码(见 policies),不走 grid_actions(其 key 必须是独立权限码);
  # 前端在工资单页自定义行动作按 update capability 门控
  def display_field, do: :month

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    create :create do
      # 手工单入口(无考勤员工的特批发薪);批量生成走 :generate
      accept [
        :employee_id,
        :month,
        :workdays,
        :attendance_days,
        :missing_days,
        :overtime_hours,
        :daily_wage,
        :allowance,
        :bonus,
        :fine,
        :loan_deduction,
        :remarks
      ]

      change fn changeset, _context -> __MODULE__.derive_amounts(changeset) end
    end

    update :update do
      # 员工与月份是单据身份不可改;错了删单重建
      accept [
        :workdays,
        :attendance_days,
        :missing_days,
        :overtime_hours,
        :daily_wage,
        :allowance,
        :bonus,
        :fine,
        :loan_deduction,
        :remarks
      ]

      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Hr.PayrollPending, []}

      change fn changeset, _context ->
        changeset
        |> __MODULE__.derive_amounts()
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发发放后改单"竞态(照承兑交易先例)
          case __MODULE__.lock_and_ensure(cs, :pending, "仅待发放工资单可修改或删除,差错请走补发") do
            {:ok, _locked, cs} -> cs
            {:error, cs} -> cs
          end
        end)
      end
    end

    update :refresh do
      accept []
      require_atomic? false

      validate {SynieCore.Hr.PayrollPending, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_and_ensure(cs, :pending, "仅待发放工资单可重取快照") do
            {:ok, locked, cs} -> __MODULE__.apply_snapshot(cs, locked)
            {:error, cs} -> cs
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Hr.PayrollPending, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:关闭"并发发放后删单"竞态;已发放单先删发放记录翻回待发放
          case __MODULE__.lock_and_ensure(cs, :pending, "仅待发放工资单可修改或删除,差错请走补发") do
            {:ok, _locked, cs} -> cs
            {:error, cs} -> cs
          end
        end)
      end
    end

    update :mark_paid do
      # 仅发放记录联动调用(见 PayrollPayment),不注册 GraphQL
      accept []
      require_atomic? false

      change fn changeset, _context ->
        Ash.Changeset.force_change_attribute(changeset, :status, :paid)
      end
    end

    update :mark_pending do
      accept []
      require_atomic? false

      change fn changeset, _context ->
        Ash.Changeset.force_change_attribute(changeset, :status, :pending)
      end
    end

    action :generate, :map do
      description "按月批量生成工资单:考勤月汇总有行的员工每人一张,已存在的 (员工, 月) 跳过不覆盖"

      argument :month, :string, allow_nil?: false
      transaction? true

      run fn input, context ->
        month = input.arguments.month

        case SynieCore.Hr.Payroll.Engine.parse_month(month) do
          {:ok, first} ->
            {:ok, SynieCore.Hr.Payroll.Engine.generate(first, month, context.actor)}

          :error ->
            {:error,
             Ash.Error.Changes.InvalidArgument.exception(
               field: :month,
               message: "月份格式应为 YYYY-MM"
             )}
        end
      end
    end

    action :month_stats, :map do
      description "月度薪资统计(列表统计条):工资单数/未发放数/应发合计/实发合计"

      argument :month, :string, allow_nil?: false

      run fn input, _context ->
        month = input.arguments.month

        case SynieCore.Hr.Payroll.Engine.parse_month(month) do
          {:ok, _first} ->
            {:ok, SynieCore.Hr.Payroll.Engine.month_stats(month)}

          :error ->
            {:error,
             Ash.Error.Changes.InvalidArgument.exception(
               field: :month,
               message: "月份格式应为 YYYY-MM"
             )}
        end
      end
    end
  end

  validations do
    validate match(:month, ~r/^\d{4}-(0[1-9]|1[0-2])$/), message: "月份格式应为 YYYY-MM"

    validate compare(:workdays, greater_than_or_equal_to: 0), message: "工日不能为负数"
    validate compare(:attendance_days, greater_than_or_equal_to: 0), message: "出勤天数不能为负数"
    validate compare(:missing_days, greater_than_or_equal_to: 0), message: "缺卡天数不能为负数"
    validate compare(:overtime_hours, greater_than_or_equal_to: 0), message: "加班工时不能为负数"
    validate compare(:daily_wage, greater_than_or_equal_to: 0), message: "日薪不能为负数"
    validate compare(:allowance, greater_than_or_equal_to: 0), message: "补贴不能为负数"
    validate compare(:bonus, greater_than_or_equal_to: 0), message: "奖金不能为负数"
    validate compare(:fine, greater_than_or_equal_to: 0), message: "罚款不能为负数"
    validate compare(:loan_deduction, greater_than_or_equal_to: 0), message: "借款抵扣不能为负数"
  end

  attributes do
    uuid_primary_key :id

    attribute :month, :string do
      allow_nil? false
      public? true
      constraints max_length: 7
      description "月份"
    end

    attribute :workdays, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "月工日"
    end

    attribute :attendance_days, :integer do
      allow_nil? false
      default 0
      public? true
      description "出勤天数"
    end

    attribute :missing_days, :integer do
      allow_nil? false
      default 0
      public? true
      description "缺卡天数"
    end

    attribute :overtime_hours, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "加班工时"
    end

    attribute :daily_wage, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "日薪"
    end

    attribute :base_amount, :decimal do
      allow_nil? false
      default Decimal.new(0)
      writable? false
      public? true
      description "基本工资"
    end

    attribute :allowance, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "补贴"
    end

    attribute :bonus, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "奖金"
    end

    attribute :fine, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "罚款"
    end

    attribute :loan_deduction, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "借款抵扣"
    end

    attribute :payable, :decimal do
      allow_nil? false
      default Decimal.new(0)
      writable? false
      public? true
      description "应发工资"
    end

    attribute :status, SynieCore.Hr.PayrollStatus do
      allow_nil? false
      writable? false
      default :pending
      public? true
      description "状态"
    end

    attribute :remarks, :string do
      public? true
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :employee, SynieCore.Hr.Employee do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "员工"
    end

    has_many :payments, SynieCore.Hr.PayrollPayment do
      destination_attribute :payroll_id
      sort paid_on: :asc
      public? true
      description "发放记录"
    end
  end

  aggregates do
    sum :paid_total, :payments, :amount do
      public? true
      description "实发合计"
    end
  end

  identities do
    identity :unique_employee_month, [:employee_id, :month], message: "该员工当月的工资单已存在"
  end

  @doc false
  # 应发 = round(工日×日薪, 2) + 补贴 + 奖金 − 罚款 − 借款抵扣;create/update/refresh 共用
  def derive_amounts(changeset) do
    base =
      changeset
      |> get_decimal(:workdays)
      |> Decimal.mult(get_decimal(changeset, :daily_wage))
      |> Decimal.round(2)

    payable =
      base
      |> Decimal.add(get_decimal(changeset, :allowance))
      |> Decimal.add(get_decimal(changeset, :bonus))
      |> Decimal.sub(get_decimal(changeset, :fine))
      |> Decimal.sub(get_decimal(changeset, :loan_deduction))

    changeset
    |> Ash.Changeset.force_change_attribute(:base_amount, base)
    |> Ash.Changeset.force_change_attribute(:payable, payable)
  end

  @doc false
  # 工资单粒度锁:FOR UPDATE 锁单据行;仅在 before_action 钩子内调用才有效——
  # 锁持有到事务提交,借此串行化改/删/重取快照/发放/删发放(照承兑交易先例)
  def lock(id) do
    __MODULE__
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 权威复检共用:事务内 FOR UPDATE 重读工资单,状态不符则挂错(中文)
  def lock_and_ensure(changeset, expected_status, error_message) do
    case lock(changeset.data.id) do
      {:ok, %{status: ^expected_status} = locked} ->
        {:ok, locked, changeset}

      _ ->
        {:error, Ash.Changeset.add_error(changeset, message: error_message)}
    end
  end

  @doc false
  # refresh:按当前考勤月汇总与员工档案重取快照并重算金额(在 before_action 内调用)
  def apply_snapshot(changeset, locked) do
    {:ok, first} = SynieCore.Hr.Payroll.Engine.parse_month(locked.month)
    snap = SynieCore.Hr.Payroll.Engine.attendance_snapshot(first, locked.employee_id)
    employee = Ash.get!(SynieCore.Hr.Employee, locked.employee_id, authorize?: false)
    zero = Decimal.new(0)

    changeset
    |> Ash.Changeset.force_change_attribute(:workdays, snap.workdays)
    |> Ash.Changeset.force_change_attribute(:attendance_days, snap.attendance_days)
    |> Ash.Changeset.force_change_attribute(:missing_days, snap.missing_days)
    |> Ash.Changeset.force_change_attribute(:overtime_hours, snap.overtime_hours)
    |> Ash.Changeset.force_change_attribute(:daily_wage, employee.daily_wage || zero)
    |> Ash.Changeset.force_change_attribute(:allowance, employee.monthly_allowance || zero)
    |> derive_amounts()
  end

  defp get_decimal(changeset, attribute) do
    case Ash.Changeset.get_attribute(changeset, attribute) do
      nil -> Decimal.new(0)
      %Decimal{} = value -> value
      value -> Decimal.new(value)
    end
  end
end
