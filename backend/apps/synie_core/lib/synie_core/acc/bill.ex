defmodule SynieCore.Acc.BillKind do
  @moduledoc "承兑票据种类。"
  use Ash.Type.Enum,
    values: [
      bank_acceptance: "银行承兑汇票",
      commercial_acceptance: "商业承兑汇票",
      finance_company_acceptance: "财务公司承兑汇票"
    ]

  def graphql_type(_), do: :acc_bill_kind
end

defmodule SynieCore.Acc.BillFaceLock do
  @moduledoc """
  票据存在任何交易(含草稿)后,到期日/票据包金额/能否转让锁死(库存引擎与日期校验依赖)。
  """
  use Ash.Resource.Validation

  @locked [:due_date, :face_amount, :transferable]

  @impl true
  def validate(changeset, _opts, _context) do
    changing? = Enum.any?(@locked, &Ash.Changeset.changing_attribute?(changeset, &1))

    has_tx? =
      changing? &&
        Code.ensure_loaded?(SynieCore.Acc.BillTransaction) &&
        SynieCore.Acc.BillTransaction
        |> Ash.Query.filter(bill_id == ^changeset.data.id)
        |> Ash.exists?(authorize?: false)

    if has_tx? do
      {:error, message: "该票据已有交易,到期日/票据包金额/能否转让不可修改"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Acc.BillCompanyScope do
  @moduledoc """
  票据读权限(filter check):票据本身无 `company_id`,不能直接用 `CompanyScope`;
  改写成「该票在 actor 可及公司范围内有过交易」的 exists 过滤,取可及公司集的写法照抄
  `SynieCore.Authz.Checks.CompanyScope`。fail-closed:无授权公司 → 空集。
  """

  use Ash.Policy.FilterCheck

  import Ash.Expr

  alias SynieCore.Authz.Actor

  @impl true
  def describe(_opts), do: "限制在 actor 可及公司范围内曾有交易的票据"

  @impl true
  def filter(%Actor{super_admin: true}, _authorizer, _opts), do: expr(true)
  def filter(%Actor{all_companies: true}, _authorizer, _opts), do: expr(true)

  def filter(%Actor{company_ids: ids}, _authorizer, _opts),
    do: expr(exists(transactions, company_id in ^ids))

  def filter(_actor, _authorizer, _opts), do: expr(false)
end

defmodule SynieCore.Acc.Bill do
  @moduledoc """
  承兑票据主档,对应 `acc_bill` 表。

  票据本身不挂公司(应收承兑一票可流转多公司持有,归属由 Task 3 的持有资源承载);
  建档走内部 `:register` 动作(upsert 挂接不覆盖,首录票面为准),不开放 GraphQL create
  mutation——真正的建档入口是 Task 2 接收交易(收票时若票号未建档则顺带注册)。

  到期日/票据包金额/能否转让三个字段一旦有交易(含草稿)即锁死,见 `BillFaceLock`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "acc_bill"
    repo SynieCore.Repo

    custom_indexes do
      index [:due_date]
    end
  end

  graphql do
    type :acc_bill
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type(:read) do
      authorize_if SynieCore.Acc.BillCompanyScope
    end
  end

  def permission_prefix, do: "acc.bill"
  def permission_label, do: "承兑票据"
  def permission_actions, do: ~w(read update delete)

  validations do
    validate compare(:face_amount, greater_than: 0), message: "票据包金额必须大于零"
  end

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    # 内部建档:仅接收交易的 change 调用(authorize?: false),不暴露 GraphQL create
    create :register do
      accept [
        :bill_no,
        :bill_kind,
        :issue_date,
        :due_date,
        :face_amount,
        :drawer_name,
        :drawer_account,
        :drawer_bank_name,
        :drawer_bank_no,
        :payee_name,
        :payee_account,
        :payee_bank_name,
        :payee_bank_no,
        :acceptor_name,
        :acceptor_account,
        :acceptor_bank_name,
        :acceptor_bank_no,
        :transferable,
        :acceptance_date,
        :remarks
      ]

      upsert? true
      upsert_identity :unique_bill_no

      # 挂接不覆盖:并发/二次录入同票号时返回既有档案,票面以先录为准(修正走台账页 update)
      upsert_fields []
    end

    update :update do
      accept [
        :bill_kind,
        :issue_date,
        :due_date,
        :face_amount,
        :drawer_name,
        :drawer_account,
        :drawer_bank_name,
        :drawer_bank_no,
        :payee_name,
        :payee_account,
        :payee_bank_name,
        :payee_bank_no,
        :acceptor_name,
        :acceptor_account,
        :acceptor_bank_name,
        :acceptor_bank_no,
        :transferable,
        :acceptance_date,
        :remarks
      ]

      require_atomic? false

      validate {SynieCore.Acc.BillFaceLock, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 有交易时外键(on_delete 默认 restrict)兜底拒删;此处再给中文校验
      validate fn changeset, _context ->
        has_tx? =
          Code.ensure_loaded?(SynieCore.Acc.BillTransaction) &&
            SynieCore.Acc.BillTransaction
            |> Ash.Query.filter(bill_id == ^changeset.data.id)
            |> Ash.exists?(authorize?: false)

        if has_tx? do
          {:error, message: "该票据已有交易,不可删除"}
        else
          :ok
        end
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :bill_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "票据号码"
    end

    attribute :bill_kind, SynieCore.Acc.BillKind do
      allow_nil? false
      public? true
      description "票据种类"
    end

    attribute :issue_date, :date do
      public? true
      description "出票日期"
    end

    attribute :due_date, :date do
      allow_nil? false
      public? true
      description "到期日"
    end

    attribute :face_amount, :decimal do
      # 可空:承兑均来源于接收,原票据包金额业务上不关心;有值时段勾稽仍校验不越界
      public? true
      constraints min: 0
      description "票据包金额"
    end

    attribute :drawer_name, :string do
      public? true
      description "出票人名称"
    end

    attribute :drawer_account, :string do
      public? true
      description "出票人账号"
    end

    attribute :drawer_bank_name, :string do
      public? true
      description "出票人开户行"
    end

    attribute :drawer_bank_no, :string do
      public? true
      description "出票人开户行联行号"
    end

    attribute :payee_name, :string do
      public? true
      description "收款人名称"
    end

    attribute :payee_account, :string do
      public? true
      description "收款人账号"
    end

    attribute :payee_bank_name, :string do
      public? true
      description "收款人开户行"
    end

    attribute :payee_bank_no, :string do
      public? true
      description "收款人开户行联行号"
    end

    attribute :acceptor_name, :string do
      public? true
      description "承兑人名称"
    end

    attribute :acceptor_account, :string do
      public? true
      description "承兑人账号"
    end

    attribute :acceptor_bank_name, :string do
      public? true
      description "承兑人开户行"
    end

    attribute :acceptor_bank_no, :string do
      public? true
      description "承兑人开户行联行号"
    end

    attribute :transferable, :boolean do
      allow_nil? false
      default true
      public? true
      description "能否转让"
    end

    attribute :acceptance_date, :date do
      public? true
      description "承兑日期"
    end

    attribute :remarks, :string do
      public? true
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    has_many :transactions, SynieCore.Acc.BillTransaction do
      destination_attribute :bill_id
      description "该票据关联的承兑交易"
    end
  end

  identities do
    identity :unique_bill_no, [:bill_no], message: "该票据号码已建档"
  end
end
