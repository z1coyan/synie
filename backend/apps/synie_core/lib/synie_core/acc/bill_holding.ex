defmodule SynieCore.Acc.BillHoldingLabel do
  @moduledoc """
  持有段的展示标签:`票号 段起-段止 ¥金额 到期到期日`。
  RemoteSelect 选段控件的 labelField(直连 RemoteSelect 必传 labelField,见既有坑)。
  """

  use Ash.Resource.Calculation

  @impl true
  def load(_query, _opts, _context), do: [:bill_no, :sub_start, :sub_end, :amount, :due_date]

  @impl true
  def calculate(records, _opts, _context) do
    Enum.map(records, fn r ->
      "#{r.bill_no} #{r.sub_start}-#{r.sub_end} ¥#{r.amount} 到期#{r.due_date}"
    end)
  end
end

defmodule SynieCore.Acc.BillHolding do
  @moduledoc """
  承兑持有库存,对应 `acc_bill_holding` 表。只读投影,由 `SynieCore.Acc.BillLedger.replay!/1`
  按票整删整建——不是用户可写的台账,而是把该票全部已审核交易重放后的库存快照。

  `:rebuild`(create)与 `:destroy` 两个动作策略上不开放对外授权路径(照 `GlEntry` 内部
  动作先例:`permission_actions` 只列 `read`,GraphQL 也只注册查询不注册这两个动作的
  mutation),仅供 `BillLedger` 以 `authorize?: false` 内部调用。不挂审计 Fragment——
  引擎整删整建产生的噪音没有审计价值,交易本身(Task 2/4)才是审计线索。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "acc_bill_holding"
    repo SynieCore.Repo

    custom_indexes do
      index [:bill_id]
      index [:company_id, :bank_account_id]
      index [:company_id, :due_date]
    end

    # sub_start/sub_end 承载 face×100(10亿票 → 10^11),必须 bigint,照 BillTransaction
    migration_types sub_start: :bigint, sub_end: :bigint
  end

  graphql do
    type :acc_bill_holding
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "acc.bill_holding"
  def permission_label, do: "持有承兑"
  def permission_actions, do: ~w(read)

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    # 无手工动作:仅 BillLedger.rebuild!/2 内部(authorize?: false)调用,不出 GraphQL mutation
    create :rebuild do
      accept [
        :company_id,
        :bank_account_id,
        :bill_id,
        :bill_no,
        :sub_start,
        :sub_end,
        :amount,
        :due_date,
        :acquired_on,
        :source_transaction_id
      ]
    end

    destroy :destroy do
      primary? true
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :bill_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "票据号码(冗余自票据主档)"
    end

    attribute :sub_start, :integer do
      allow_nil? false
      public? true
      constraints min: 1
      description "子票起"
    end

    attribute :sub_end, :integer do
      allow_nil? false
      public? true
      constraints min: 1
      description "子票止"
    end

    attribute :amount, :decimal do
      allow_nil? false
      public? true
      description "持有金额"
    end

    attribute :due_date, :date do
      allow_nil? false
      public? true
      description "到期日(冗余自票据主档)"
    end

    attribute :acquired_on, :date do
      allow_nil? false
      public? true
      description "取得日期"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :bank_account, SynieCore.Acc.BankAccount do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "持有银行账户"
    end

    belongs_to :bill, SynieCore.Acc.Bill do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "关联票据"
    end

    belongs_to :source_transaction, SynieCore.Acc.BillTransaction do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "来源交易(该段最近一次取得的交易)"
    end
  end

  calculations do
    calculate :label, :string, SynieCore.Acc.BillHoldingLabel, public?: true
  end
end
