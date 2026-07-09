defmodule SynieCore.Acc.JournalStatus do
  @moduledoc "凭证状态:草稿/已审核/已取消。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", cancelled: "已取消"]

  def graphql_type(_), do: :acc_journal_status
end

defmodule SynieCore.Acc.JournalDraft do
  @moduledoc "校验凭证处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿凭证可修改或删除"}
    end
  end
end

defmodule SynieCore.Acc.GlJournal do
  @moduledoc """
  手工会计凭证(头),对应 `acc_gl_journal` 表。首个 GL voucher,地位与其他单据平等。

  生命周期:草稿(可改可删)→ 已审核(audit,生成分录)→ 已取消(cancel,分录标记作废,终态)。
  编号手工输入,公司内唯一;自动编号留跟进。删除草稿时行由 DB 级联删除
  (行不留单独审计记录,凭证删除本身已审计)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "acc_gl_journal"
    repo SynieCore.Repo
  end

  graphql do
    type :acc_gl_journal
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

  def permission_prefix, do: "acc.gl_journal"
  def permission_actions, do: ~w(create read update delete audit cancel)

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
      accept [:company_id, :voucher_no, :date, :posting_date, :remarks]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}

      # 编写人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end
    end

    update :update do
      accept [:voucher_no, :date, :posting_date, :remarks]
      require_atomic? false

      validate {SynieCore.Acc.JournalDraft, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Acc.JournalDraft, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :voucher_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "凭证编号"
    end

    attribute :date, :date do
      allow_nil? false
      public? true
      description "单据日期"
    end

    attribute :posting_date, :date do
      allow_nil? false
      public? true
      description "过账日期"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "凭证备注"
    end

    attribute :status, SynieCore.Acc.JournalStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
    end

    attribute :submitted_at, :utc_datetime_usec do
      writable? false
      public? true
      description "提交时间"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "编写人"
    end

    belongs_to :submitted_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "提交人"
    end

    has_many :lines, SynieCore.Acc.GlJournalLine do
      destination_attribute :journal_id
      sort idx: :asc
      public? true
      description "分录行"
    end
  end

  identities do
    identity :unique_voucher_no_per_company, [:company_id, :voucher_no]
  end
end
