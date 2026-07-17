defmodule SynieCore.Hr.Employee do
  @moduledoc """
  员工,对应 `hr_employees` 表。人事域首个资源,全局主数据(不挂公司)。

  员工编号留空按 `hr.employee` 编号规则自动取号(AutoNumber),手填原样保留。
  身份证正/背面照片走统一附件(owner_type `hr_employee`,槽位 `id_front`/`id_back`),
  不占表字段;身份证号标 sensitive,审计日志记 `[FILTERED]`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "hr_employees"
    repo SynieCore.Repo
  end

  graphql do
    type :hr_employee
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "hr.employee"
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
      accept [
        :code,
        :name,
        :attendance_no,
        :id_number,
        :household_registration,
        :phone,
        :current_address,
        :daily_wage,
        :monthly_allowance,
        :insurance_types
      ]

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :code}
    end

    update :update do
      accept [
        :code,
        :name,
        :attendance_no,
        :id_number,
        :household_registration,
        :phone,
        :current_address,
        :daily_wage,
        :monthly_allowance,
        :insurance_types
      ]

      require_atomic? false
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  validations do
    validate compare(:daily_wage, greater_than_or_equal_to: 0),
      where: [present(:daily_wage)],
      message: "日薪不能为负数"

    validate compare(:monthly_allowance, greater_than_or_equal_to: 0),
      where: [present(:monthly_allowance)],
      message: "月补贴不能为负数"
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "员工编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "员工姓名"
    end

    attribute :attendance_no, :string do
      public? true
      constraints max_length: 64
      description "考勤设备编号"
    end

    attribute :id_number, :string do
      public? true
      sensitive? true
      constraints max_length: 32
      description "身份证号"
    end

    attribute :household_registration, :string do
      public? true
      constraints max_length: 128
      description "户籍"
    end

    attribute :phone, :string do
      public? true
      constraints max_length: 32
      description "手机号码"
    end

    attribute :current_address, :string do
      public? true
      constraints max_length: 255
      description "现居住地"
    end

    attribute :daily_wage, :decimal do
      public? true
      description "日薪"
    end

    attribute :monthly_allowance, :decimal do
      public? true
      description "月补贴"
    end

    # 原子险种多选,任意组合不设互斥;当前状态快照,变更追溯靠审计日志
    attribute :insurance_types, {:array, SynieCore.Hr.InsuranceType} do
      public? true
      allow_nil? false
      default []
      description "参保类型"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  calculations do
    # 参保类型列的筛选通道:AshGraphql 不为数组属性生成 filter 字段,包含判断走带参
    # 伴生 calculation(命名约定 `<attr>_has`,GridMeta 据此标记枚举数组列可筛)。
    # 前端「包含」= {insuranceTypesHas: {input: {type: X}, eq: true}},「不包含」= eq false
    calculate :insurance_types_has,
              :boolean,
              expr(has(insurance_types, ^arg(:type))) do
      public? true
      argument :type, SynieCore.Hr.InsuranceType, allow_nil?: false
      description "参保类型包含判断(仅列筛选用)"
    end
  end

  identities do
    identity :unique_code, [:code], message: "员工编号已存在"
    # 可空字段:Postgres 唯一索引对 NULL 互不冲突,未填身份证号的员工不受限
    identity :unique_id_number, [:id_number], message: "身份证号已存在"

    # 考勤导入按编号匹配员工,语义要求非空全局唯一(多台考勤机同编号=同一人)
    identity :unique_attendance_no, [:attendance_no], message: "考勤机编号已存在"
  end
end
