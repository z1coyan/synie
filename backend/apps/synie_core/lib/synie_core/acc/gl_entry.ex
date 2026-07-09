defmodule SynieCore.Acc.GlEntry do
  @moduledoc """
  总账分录,对应 `acc_gl_entry` 表。全系统唯一财务事实表:只追加、不可改,
  由业务单据审核时经 `SynieCore.Acc.GL.post!/2` 派生。

  用户无直接写入口:GraphQL 仅注册查询;`:create` 与 `:mark_cancelled` 仅供
  GL 模块以 `authorize?: false` 调用。不挂审计 Fragment——分录本身即来源单据的
  审计产物,来源单据已接审计。作废不删数,仅标记 `is_cancelled`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    # 主 read 上的兜底排序(seq 升序)是有意为之,分录按发生顺序展示依赖此序
    primary_read_warning?: false

  postgres do
    table "acc_gl_entry"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :debit, "single_sided_amount",
        check: "debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0)",
        message: "借贷金额必须恰一边大于零"

      check_constraint :party_type, "party_pair",
        check: "(party_type IS NULL) = (party_id IS NULL)",
        message: "对手类型与对手必须同时填写"
    end

    custom_indexes do
      index [:company_id, :account_id, :posting_date]
      index [:voucher_type, :voucher_id]
    end
  end

  graphql do
    type :acc_gl_entry
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "acc.gl_entry"
  def permission_actions, do: ~w(read)

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      prepare build(sort: [seq: :asc])
    end

    # 仅内部(GL.post!)使用,GraphQL 不注册 mutation
    create :create do
      accept [
        :company_id,
        :account_id,
        :currency_id,
        :posting_date,
        :debit,
        :credit,
        :party_type,
        :party_id,
        :voucher_type,
        :voucher_id,
        :voucher_no,
        :remarks
      ]
    end

    # 仅内部(GL.cancel!)使用:作废来源单据时批量标记
    update :mark_cancelled do
      accept []
      change set_attribute(:is_cancelled, true)
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :seq, :integer do
      allow_nil? false
      writable? false
      generated? true
      public? true
      description "序号"
    end

    attribute :posting_date, :date do
      allow_nil? false
      public? true
      description "过账日期"
    end

    attribute :debit, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "借方金额"
    end

    attribute :credit, :decimal do
      allow_nil? false
      default Decimal.new(0)
      public? true
      description "贷方金额"
    end

    attribute :party_type, SynieCore.Acc.PartyType do
      public? true
      description "对手类型"
    end

    attribute :party_id, :uuid do
      public? true
      description "对手"
    end

    attribute :voucher_type, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "来源单据类型"
    end

    attribute :voucher_id, :uuid do
      allow_nil? false
      public? true
      description "来源单据"
    end

    attribute :voucher_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "来源单据编号"
    end

    attribute :is_cancelled, :boolean do
      allow_nil? false
      default false
      public? true
      description "已作废"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "摘要"
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

    belongs_to :account, SynieCore.Base.Account do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "科目"
    end

    belongs_to :currency, SynieCore.Base.Currency do
      public? true
      attribute_public? true
      attribute_writable? true
      description "币种"
    end
  end
end
