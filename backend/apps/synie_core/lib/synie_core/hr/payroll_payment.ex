defmodule SynieCore.Hr.PayrollPaymentKind do
  @moduledoc "发放类型:发放(翻转工资单那笔)/补发(已发放后追加),创建时自动判别不可手选。"

  use Ash.Type.Enum, values: [normal: "发放", supplement: "补发"]

  def graphql_type(_), do: :hr_payroll_payment_kind
end

defmodule SynieCore.Hr.PayrollPayment do
  @moduledoc """
  工资发放记录,对应 `hr_payroll_payment` 表。一张工资单可多条(考勤漏算等差错
  走补发,不回头改单),决策见 docs/adr/2026-07-16-payroll.md。

  创建即发放:before_action 锁工资单行(串行化并发发放/删单/改单),按其状态
  自动判别类型——待发放=「发放」并在 after_action 翻转工资单为已发放(借款抵扣
  >0 时校验员工借款余额、自动生成台账归还行),已发放=「补发」。金额允许为负
  (多发冲回)、禁止为零。不可修改,只可删除重录(审计口径干净);删除「发放」
  记录即自动翻回待发放并删除联动归还行(无论是否还有补发)。

  `pay_remaining` 一键发放(行动作/批量发放共用):金额不收前端,事务内锁单后
  按 应发 − 已发 权威计算,差额 ≤ 0 拒绝——前端拿到的差额可能过期,以锁内计算
  为准防重复发放;其余联动与 `create` 完全一致。

  员工/月份自工资单去规范化(发放流水页按员工/月直筛),不可手填;属性层可空是
  技术让步(必填校验先于 before_action,照承兑交易 bill_id 先例),实际由
  before_action 强制回填。全局不挂公司(照 hr 域先例)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "hr_payroll_payment"
    repo SynieCore.Repo

    custom_indexes do
      index [:payroll_id]
      # 发放流水页按员工/月直筛
      index [:employee_id, :month]
      index [:month]
    end
  end

  graphql do
    type :hr_payroll_payment
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 一键发放=创建发放记录的快捷形态,复用 create 码不新设权限点
    policy action(:pay_remaining) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    policy action([:read, :create, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "hr.payroll_payment"
  def permission_label, do: "工资发放"
  def permission_actions, do: ~w(create read delete)

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
      accept [:payroll_id, :paid_on, :amount, :remarks]

      validate fn changeset, _context ->
        case Ash.Changeset.get_attribute(changeset, :amount) do
          nil ->
            # allow_nil? false 的必填校验兜底,这里不重复报错
            :ok

          amount ->
            if Decimal.equal?(amount, 0),
              do: {:error, field: :amount, message: "发放金额不能为零(冲回请填负数)"},
              else: :ok
        end
      end

      # 经办人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.before_action(fn cs -> __MODULE__.prepare_create(cs) end)
        |> Ash.Changeset.after_action(fn _cs, payment ->
          __MODULE__.settle_create(payment, context.actor)
        end)
      end
    end

    create :pay_remaining do
      # 一键发放未发差额:金额不收前端,锁内权威计算(见 moduledoc)
      accept [:payroll_id, :paid_on, :remarks]

      # 经办人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.before_action(fn cs -> __MODULE__.prepare_pay_remaining(cs) end)
        |> Ash.Changeset.after_action(fn _cs, payment ->
          __MODULE__.settle_create(payment, context.actor)
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.before_action(fn cs ->
          # 锁工资单行:串行化删发放与并发发放/删单;工资单行已不存在时无从联动,直接放行
          case SynieCore.Hr.Payroll.lock(cs.data.payroll_id) do
            {:ok, _payroll} -> cs
            _ -> cs
          end
        end)
        |> Ash.Changeset.after_action(fn _cs, payment ->
          __MODULE__.settle_destroy(payment, context.actor)
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :month, :string do
      writable? false
      public? true
      constraints max_length: 7
      description "月份"
    end

    attribute :paid_on, :date do
      allow_nil? false
      public? true
      description "发放日期"
    end

    attribute :amount, :decimal do
      allow_nil? false
      public? true
      description "发放金额"
    end

    attribute :kind, SynieCore.Hr.PayrollPaymentKind do
      allow_nil? false
      writable? false
      default :normal
      public? true
      description "类型"
    end

    attribute :remarks, :string do
      public? true
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :payroll, SynieCore.Hr.Payroll do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "工资单"
    end

    belongs_to :employee, SynieCore.Hr.Employee do
      # 自工资单去规范化,before_action 强制回填(见 moduledoc)
      public? true
      attribute_public? true
      description "员工"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "经办人"
    end
  end

  @doc false
  # 创建发放:锁工资单 → 判别类型/回填员工与月份 → 翻转前校验借款余额
  def prepare_create(changeset) do
    case SynieCore.Hr.Payroll.lock(Ash.Changeset.get_attribute(changeset, :payroll_id)) do
      {:ok, %SynieCore.Hr.Payroll{} = payroll} ->
        apply_payroll_context(changeset, payroll)

      _ ->
        Ash.Changeset.add_error(changeset, field: :payroll_id, message: "工资单不存在")
    end
  end

  @doc false
  # 一键发放:锁工资单 → 锁内算差额(应发 − 已发,≤0 拒绝)→ 其余联动同 prepare_create
  def prepare_pay_remaining(changeset) do
    case SynieCore.Hr.Payroll.lock(Ash.Changeset.get_attribute(changeset, :payroll_id)) do
      {:ok, %SynieCore.Hr.Payroll{} = payroll} ->
        remaining = Decimal.sub(payroll.payable, paid_sum(payroll.id))

        if Decimal.compare(remaining, 0) == :gt do
          changeset
          |> Ash.Changeset.force_change_attribute(:amount, remaining)
          |> apply_payroll_context(payroll)
        else
          Ash.Changeset.add_error(changeset,
            field: :payroll_id,
            message: "该工资单已无未发差额(应发 #{payroll.payable},已发放完毕)"
          )
        end

      _ ->
        Ash.Changeset.add_error(changeset, field: :payroll_id, message: "工资单不存在")
    end
  end

  # 两条创建路径共用:判别类型/回填员工与月份/翻转前校验借款余额(调用方已持工资单行锁)
  defp apply_payroll_context(changeset, payroll) do
    kind = if payroll.status == :pending, do: :normal, else: :supplement

    changeset =
      changeset
      |> Ash.Changeset.force_change_attribute(:kind, kind)
      |> Ash.Changeset.force_change_attribute(:employee_id, payroll.employee_id)
      |> Ash.Changeset.force_change_attribute(:month, payroll.month)

    if kind == :normal and Decimal.compare(payroll.loan_deduction, 0) == :gt do
      balance = SynieCore.Hr.EmployeeLoan.balance(payroll.employee_id)

      if Decimal.compare(balance, payroll.loan_deduction) == :lt do
        Ash.Changeset.add_error(changeset,
          field: :payroll_id,
          message:
            "借款抵扣(#{payroll.loan_deduction})超过员工借款余额(#{balance})," <>
              "请先修正工资单借款抵扣或补录借款"
        )
      else
        changeset
      end
    else
      changeset
    end
  end

  defp paid_sum(payroll_id) do
    __MODULE__
    |> Ash.Query.filter(payroll_id == ^payroll_id)
    |> Ash.read!(authorize?: false)
    |> Enum.reduce(Decimal.new(0), &Decimal.add(&1.amount, &2))
  end

  @doc false
  # 首笔发放的联动(事务内):翻转工资单已发放;借款抵扣 >0 时生成台账归还行
  def settle_create(payment, actor) do
    if payment.kind == :normal do
      payroll = Ash.get!(SynieCore.Hr.Payroll, payment.payroll_id, authorize?: false)

      payroll
      |> Ash.Changeset.for_update(:mark_paid, %{}, actor: actor, authorize?: false)
      |> Ash.update!(authorize?: false)

      if Decimal.compare(payroll.loan_deduction, 0) == :gt do
        SynieCore.Hr.EmployeeLoan
        |> Ash.Changeset.for_create(
          :auto_repay,
          %{
            employee_id: payroll.employee_id,
            occurred_on: payment.paid_on,
            amount: payroll.loan_deduction,
            payroll_id: payroll.id
          },
          actor: actor,
          authorize?: false
        )
        |> Ash.create!(authorize?: false)
      end
    end

    {:ok, payment}
  end

  @doc false
  # 删除发放的联动(事务内):删「发放」(normal)即回退结算——翻回待发放并删联动归还行,
  # 无论是否还有补发记录(归还行隶属于 normal 那笔的结算事实,见 settle_create);
  # 删「补发」且该工资单已无任何发放记录时同样回退(兼容历史脏数据)。
  def settle_destroy(payment, actor) do
    remaining =
      __MODULE__
      |> Ash.Query.filter(payroll_id == ^payment.payroll_id)
      |> Ash.count!(authorize?: false)

    if payment.kind == :normal or remaining == 0 do
      case Ash.get(SynieCore.Hr.Payroll, payment.payroll_id, authorize?: false) do
        {:ok, %{status: :paid} = payroll} ->
          payroll
          |> Ash.Changeset.for_update(:mark_pending, %{}, actor: actor, authorize?: false)
          |> Ash.update!(authorize?: false)

        _ ->
          :ok
      end

      SynieCore.Hr.EmployeeLoan
      |> Ash.Query.filter(payroll_id == ^payment.payroll_id)
      |> Ash.read!(authorize?: false)
      |> Enum.each(fn entry ->
        entry
        |> Ash.Changeset.for_destroy(:auto_destroy, %{}, actor: actor, authorize?: false)
        |> Ash.destroy!(authorize?: false)
      end)
    end

    {:ok, payment}
  end
end
