defmodule SynieCore.Hr.EmployeeLoanKind do
  @moduledoc "台账类型:借款(借出/预支)/归还(现金还款或工资抵扣)。"

  use Ash.Type.Enum, values: [borrow: "借款", repay: "归还"]

  def graphql_type(_), do: :hr_employee_loan_kind
end

defmodule SynieCore.Hr.EmployeeLoanManual do
  @moduledoc "校验是手工台账行:工资发放联动生成的归还行(payroll_id 非空)禁手改手删。"
  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if is_nil(changeset.data.payroll_id),
      do: :ok,
      else: {:error, message: "工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理"}
  end
end

defmodule SynieCore.Hr.EmployeeLoan do
  @moduledoc """
  员工借款台账,对应 `hr_employee_loan` 表。借款/归还两类流水行,余额 = Σ借款 −
  Σ归还(员工级,不做单笔核销),决策见 docs/adr/2026-07-16-payroll.md。

  手工行:员工借款/预支、现金还款,增删改自由(台账是事实记录,不校验余额方向)。
  自动行(`payroll_id` 非空):工资单发放时按借款抵扣生成的归还行,禁手改手删,
  随工资单发放/回退联动增删(`auto_repay`/`auto_destroy` 仅发放联动的内部路径,
  不注册 GraphQL)。余额汇总 `balances` 复用 read 码(照考勤 month_summary 先例)。
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
    table "hr_employee_loan"
    repo SynieCore.Repo

    custom_indexes do
      # 余额按员工聚合;发放回退按 payroll_id 找联动归还行
      index [:employee_id]
      index [:payroll_id], where: "payroll_id IS NOT NULL"
    end
  end

  graphql do
    type :hr_employee_loan
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 余额汇总是读能力的衍生视图,复用 read 码不新设权限点
    policy action(:balances) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    # 联动行仅发放侧内部路径(authorize?: false);策略留作纵深防御,归口增/删码
    policy action(:auto_repay) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    policy action(:auto_destroy) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "delete"}
    end

    policy action([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "hr.employee_loan"
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
      accept [:employee_id, :kind, :occurred_on, :amount, :remarks]

      # 经办人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end
    end

    create :auto_repay do
      # 仅工资发放联动调用(见 PayrollPayment),不注册 GraphQL
      accept [:employee_id, :occurred_on, :amount, :payroll_id]

      change fn changeset, _context ->
        Ash.Changeset.force_change_attribute(changeset, :kind, :repay)
      end
    end

    update :update do
      accept [:employee_id, :kind, :occurred_on, :amount, :remarks]
      require_atomic? false

      validate {SynieCore.Hr.EmployeeLoanManual, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Hr.EmployeeLoanManual, []}
    end

    destroy :auto_destroy do
      # 仅工资发放回退联动调用(见 PayrollPayment),不注册 GraphQL
      require_atomic? false
    end

    action :balances, {:array, :map} do
      description "员工借款余额汇总:每员工累计借款/累计归还/余额(仅含有台账记录的员工)"

      run fn _input, _context ->
        {:ok, SynieCore.Hr.EmployeeLoan.balances_summary()}
      end
    end
  end

  validations do
    validate compare(:amount, greater_than: 0), message: "金额必须大于零"
  end

  attributes do
    uuid_primary_key :id

    attribute :kind, SynieCore.Hr.EmployeeLoanKind do
      allow_nil? false
      public? true
      description "类型"
    end

    attribute :occurred_on, :date do
      allow_nil? false
      public? true
      description "发生日期"
    end

    attribute :amount, :decimal do
      allow_nil? false
      public? true
      description "金额"
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

    belongs_to :payroll, SynieCore.Hr.Payroll do
      # 非空 = 工资发放联动生成的归还行(禁手改手删)
      public? true
      attribute_public? true
      description "关联工资单"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "经办人"
    end
  end

  @doc "员工借款余额 = Σ借款 − Σ归还(受信内部路径,发放前校验用)"
  def balance(employee_id) do
    __MODULE__
    |> Ash.Query.filter(employee_id == ^employee_id)
    |> Ash.read!(authorize?: false)
    |> Enum.reduce(Decimal.new(0), fn entry, acc ->
      case entry.kind do
        :borrow -> Decimal.add(acc, entry.amount)
        :repay -> Decimal.sub(acc, entry.amount)
      end
    end)
  end

  @doc """
  余额汇总(台账页):每员工累计借款/累计归还/余额。
  Decimal 一律转字符串(照考勤 month_summary 先例)。
  """
  def balances_summary do
    entries = __MODULE__ |> Ash.read!(authorize?: false)

    employees =
      case entries do
        [] ->
          %{}

        entries ->
          ids = entries |> Enum.map(& &1.employee_id) |> Enum.uniq()

          SynieCore.Hr.Employee
          |> Ash.Query.filter(id in ^ids)
          |> Ash.read!(authorize?: false)
          |> Map.new(&{&1.id, &1})
      end

    entries
    |> Enum.group_by(& &1.employee_id)
    |> Enum.map(fn {employee_id, rows} ->
      borrowed = sum_kind(rows, :borrow)
      repaid = sum_kind(rows, :repay)
      employee = employees[employee_id]

      %{
        "employeeId" => employee_id,
        "employeeCode" => employee && employee.code,
        "employeeName" => employee && employee.name,
        "borrowed" => Decimal.to_string(borrowed, :normal),
        "repaid" => Decimal.to_string(repaid, :normal),
        "balance" => Decimal.to_string(Decimal.sub(borrowed, repaid), :normal)
      }
    end)
    |> Enum.sort_by(&{&1["employeeCode"] || "", &1["employeeName"] || ""})
  end

  defp sum_kind(rows, kind) do
    rows
    |> Enum.filter(&(&1.kind == kind))
    |> Enum.reduce(Decimal.new(0), &Decimal.add(&1.amount, &2))
  end
end
