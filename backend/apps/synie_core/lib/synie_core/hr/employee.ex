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
        :monthly_allowance
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
        :monthly_allowance
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

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_code, [:code], message: "员工编号已存在"
    # 可空字段:Postgres 唯一索引对 NULL 互不冲突,未填身份证号的员工不受限
    identity :unique_id_number, [:id_number], message: "身份证号已存在"
  end
end
