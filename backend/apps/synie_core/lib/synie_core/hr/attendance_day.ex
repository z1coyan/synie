defmodule SynieCore.Hr.AttendanceDayStatus do
  @moduledoc "日考勤状态:正常/缺卡(某半天桶内只有一张卡,该段计 0 工时待补卡)。"

  use Ash.Type.Enum, values: [ok: "正常", missing: "缺卡"]

  def graphql_type(_), do: :hr_attendance_day_status
end

defmodule SynieCore.Hr.AttendanceDay do
  @moduledoc """
  日考勤,对应 `hr_attendance_day` 表。按 (员工, 本地自然日) 派生的考勤结果行:
  四段时刻 + 正常/加班工时 + 奖励工日 + 状态,由重算引擎从真实打卡∪补卡虚拟卡
  推导(`SynieCore.Hr.Attendance.Recompute`),规则常量集中
  `SynieCore.Hr.Attendance.Rules`,决策见 docs/adr/2026-07-15-attendance-daily-calc.md。

  人工不可直改:无对外写动作,唯一修正入口=补卡单;导入执行/撤销、补卡增删自动
  重算受影响 (员工, 日),`recalc` 按区间手动重算兜底;全天无卡不生成行。派生行随
  重算大量增删,逐条审计只有噪音,照打卡记录先例不挂审计 fragment(留痕由补卡单/
  导入批次承担)。全局不挂公司(照员工)。`month_summary` 出月汇总供工资,暂不锁定。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "hr_attendance_day"
    repo SynieCore.Repo

    custom_indexes do
      # 日/月视图按日期区间筛;(employee_id, date) 唯一索引由 identity 生成
      index [:date]
    end
  end

  graphql do
    type :hr_attendance_day
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 月汇总是读能力的衍生视图,复用 read 码不新设权限点
    policy action(:month_summary) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 行级写入仅重算引擎内部路径(authorize?: false);策略留作纵深防御,归口 recalc 码
    policy action_type([:create, :destroy]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "recalc"}
    end

    policy action(:recalc) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "hr.attendance_day"

  def permission_actions, do: ~w(read recalc)

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
      # 仅重算引擎调用:同 (员工,日) 重算即覆盖(upsert),计算字段全量重写
      upsert? true
      upsert_identity :unique_employee_date

      upsert_fields [
        :morning_in,
        :morning_out,
        :afternoon_in,
        :afternoon_out,
        :normal_hours,
        :overtime_hours,
        :bonus_workday,
        :status,
        :updated_at
      ]

      accept [
        :employee_id,
        :date,
        :morning_in,
        :morning_out,
        :afternoon_in,
        :afternoon_out,
        :normal_hours,
        :overtime_hours,
        :bonus_workday,
        :status
      ]
    end

    destroy :destroy do
      # 仅重算引擎调用:该 (员工,日) 重算后全天无卡,清掉派生行
      primary? true
    end

    action :recalc, :integer do
      description "按日期区间重算日考勤(兜底动线;导入/补卡已自动重算),返回重算天数"

      argument :date_from, :date, allow_nil?: false
      argument :date_to, :date, allow_nil?: false

      run fn input, _context ->
        from = input.arguments.date_from
        to = input.arguments.date_to

        cond do
          Date.compare(from, to) == :gt ->
            {:error,
             Ash.Error.Changes.InvalidArgument.exception(
               field: :date_to,
               message: "结束日期不能早于开始日期"
             )}

          Date.diff(to, from) > 366 ->
            {:error,
             Ash.Error.Changes.InvalidArgument.exception(
               field: :date_to,
               message: "重算区间不能超过一年"
             )}

          true ->
            {:ok, SynieCore.Hr.Attendance.Recompute.recalc_range(from, to)}
        end
      end
    end

    action :month_summary, {:array, :map} do
      description "月度考勤汇总(供工资):每员工出勤天数、正常/加班工时、奖励工日与月工日"

      argument :month, :string, allow_nil?: false

      run fn input, _context ->
        case Date.from_iso8601(input.arguments.month <> "-01") do
          {:ok, first} ->
            {:ok, SynieCore.Hr.Attendance.Recompute.month_summary(first)}

          _ ->
            {:error,
             Ash.Error.Changes.InvalidArgument.exception(
               field: :month,
               message: "月份格式应为 YYYY-MM"
             )}
        end
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :date, :date do
      allow_nil? false
      public? true
      description "日期"
    end

    attribute :morning_in, :time do
      public? true
      description "上午上班"
    end

    attribute :morning_out, :time do
      public? true
      description "上午下班"
    end

    attribute :afternoon_in, :time do
      public? true
      description "下午上班"
    end

    attribute :afternoon_out, :time do
      public? true
      description "下午下班"
    end

    attribute :normal_hours, :decimal do
      allow_nil? false
      public? true
      description "正常工时"
    end

    attribute :overtime_hours, :decimal do
      allow_nil? false
      public? true
      description "加班工时"
    end

    attribute :bonus_workday, :decimal do
      allow_nil? false
      public? true
      description "奖励工日"
    end

    attribute :status, SynieCore.Hr.AttendanceDayStatus do
      allow_nil? false
      public? true
      description "状态"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "重算时间"
  end

  relationships do
    belongs_to :employee, SynieCore.Hr.Employee do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "员工"
    end
  end

  identities do
    identity :unique_employee_date, [:employee_id, :date], message: "该员工当日的日考勤已存在"
  end
end
