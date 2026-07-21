defmodule SynieCore.Hr.AttendancePunch do
  @moduledoc """
  打卡记录,对应 `hr_attendance_punch` 表。考勤机原始打卡事实(员工+时刻),
  全局主数据不挂公司(照员工),为将来日考勤/月统计提供原始层。

  导入批次是唯一写入口:无对外 create/update/destroy,单条不可改删——打卡是
  客观事实,导错靠删除批次整批撤销(库级联删)。逐条审计只有噪音(月导上万行),
  留痕由批次(接审计)与挂批次的原始 .dat 文件承担,故不挂审计 fragment。
  `(employee_id, punched_at)` 唯一,导入撞键静默跳过(重复导出区间天然幂等)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "hr_attendance_punch"
    repo SynieCore.Repo

    references do
      # 撤销=删除批次,打卡库级联删(量大且逐条无审计诉求,不经 Ash)
      reference :import, on_delete: :delete
    end

    custom_indexes do
      # 台账按时间倒序/区间筛;级联删与批次聚合走 import_id
      index [:punched_at]
      index [:import_id]
    end
  end

  graphql do
    type :hr_attendance_punch
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 写入仅导入批次内部路径(authorize?: false);策略留作纵深防御
    policy action_type(:create) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "import"}
    end
  end

  def permission_prefix, do: "hr.attendance_punch"
  def permission_label, do: "打卡记录"

  # import 是批次链路的用户视角能力,权限码挂本资源(照 acc.bank_transaction:import)
  def permission_actions, do: ~w(read import)

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
      accept [:employee_id, :attendance_no, :punched_at, :import_id]
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :attendance_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "考勤机编号(原始留痕)"
    end

    attribute :punched_at, :utc_datetime do
      allow_nil? false
      public? true
      description "打卡时间"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
  end

  relationships do
    belongs_to :employee, SynieCore.Hr.Employee do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "员工"
    end

    belongs_to :import, SynieCore.Hr.AttendanceImport do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "导入批次"
    end
  end

  identities do
    identity :unique_employee_punch, [:employee_id, :punched_at], message: "该员工此时刻的打卡已存在"
  end
end
