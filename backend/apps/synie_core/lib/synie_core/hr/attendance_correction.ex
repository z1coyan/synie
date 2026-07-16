defmodule SynieCore.Hr.AttendanceCorrection.Recalc do
  @moduledoc "补卡增删改后重算受影响 (员工, 日);update 换人/改日则新旧两天都重算。"

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn cs, result ->
      old = pair(cs.data)
      new = if cs.action_type == :destroy, do: nil, else: pair(result)

      [old, new]
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()
      |> SynieCore.Hr.Attendance.Recompute.recompute()

      {:ok, result}
    end)
  end

  # create 时 cs.data 是空结构,员工/日期为 nil,自然滤掉
  defp pair(%{employee_id: employee_id, date: %Date{} = date}) when is_binary(employee_id),
    do: {employee_id, date}

  defp pair(_), do: nil
end

defmodule SynieCore.Hr.AttendanceCorrection.NormalizeTimes do
  @moduledoc "补卡钟点规整:截秒后去重排序,存储形态稳定(审计差异与展示都干净)。"

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :times) do
      times when is_list(times) ->
        normalized =
          times
          |> Enum.map(&Time.truncate(&1, :second))
          |> Enum.uniq()
          |> Enum.sort(Time)

        Ash.Changeset.force_change_attribute(changeset, :times, normalized)

      _ ->
        changeset
    end
  end
end

defmodule SynieCore.Hr.AttendanceCorrection do
  @moduledoc """
  补卡单,对应 `hr_attendance_correction` 表。一单=一人一天的若干虚拟卡钟点
  (本地时间),重算时与真实打卡合并进桶取 min/max——原始打卡永不修改(导入
  ADR 定死),漏打卡/考勤机故障全走这里修正。保存/修改/删除即自动重算当天日考勤;
  无审批流,靠权限码与审计留痕。(员工, 日期) 唯一:同日再补编辑原单。
  全局不挂公司(照员工)。决策见 docs/adr/2026-07-15-attendance-daily-calc.md。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "hr_attendance_correction"
    repo SynieCore.Repo

    custom_indexes do
      # 重算引擎与台账均按日期取数;(employee_id, date) 唯一索引由 identity 生成
      index [:date]
    end
  end

  graphql do
    type :hr_attendance_correction
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "hr.attendance_correction"

  def permission_actions, do: ~w(create read update delete)

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
      accept [:employee_id, :date, :times, :note]

      # 录入人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end

      change {SynieCore.Hr.AttendanceCorrection.NormalizeTimes, []}
      change {SynieCore.Hr.AttendanceCorrection.Recalc, []}
    end

    update :update do
      accept [:employee_id, :date, :times, :note]
      require_atomic? false

      change {SynieCore.Hr.AttendanceCorrection.NormalizeTimes, []}
      change {SynieCore.Hr.AttendanceCorrection.Recalc, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Hr.AttendanceCorrection.Recalc, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :date, :date do
      allow_nil? false
      public? true
      description "日期"
    end

    attribute :times, {:array, :time} do
      allow_nil? false
      public? true
      constraints min_length: 1, max_length: 20
      description "补卡时刻"
    end

    attribute :note, :string do
      public? true
      constraints max_length: 200
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

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end
  end

  identities do
    identity :unique_employee_date, [:employee_id, :date], message: "该员工当日已有补卡单,请编辑原单"
  end
end
