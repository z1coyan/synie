defmodule SynieCore.Acc.GlJournalLine.SyncJournal do
  @moduledoc """
  行与父凭证同步:凭证必须存在且草稿态(增删改行的前提);
  create 时把凭证 company_id 冗余到行(数据权限按公司过滤依赖此列)。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    journal_id =
      Ash.Changeset.get_attribute(changeset, :journal_id) || changeset.data.journal_id

    case journal_id && Ash.get(SynieCore.Acc.GlJournal, journal_id, authorize?: false) do
      {:ok, %{status: :draft} = journal} ->
        if changeset.action_type == :create do
          Ash.Changeset.force_change_attribute(changeset, :company_id, journal.company_id)
        else
          changeset
        end

      {:ok, _journal} ->
        Ash.Changeset.add_error(changeset, field: :journal_id, message: "仅草稿凭证可编辑分录行")

      _ ->
        Ash.Changeset.add_error(changeset, field: :journal_id, message: "凭证不存在")
    end
  end
end

defmodule SynieCore.Acc.GlJournalLine.CopyCurrency do
  @moduledoc "account_id 变更时校验科目可入账(同公司/启用/非汇总)并复制科目币种,币种不可手改。"

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    case Ash.Changeset.fetch_change(changeset, :account_id) do
      {:ok, account_id} when not is_nil(account_id) ->
        copy(changeset, account_id)

      _ ->
        changeset
    end
  end

  defp copy(changeset, account_id) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case Ash.get(SynieCore.Base.Account, account_id, authorize?: false) do
      {:ok, %{company_id: ^company_id} = account} ->
        cond do
          account.is_group ->
            Ash.Changeset.add_error(changeset, field: :account_id, message: "汇总科目不能入账")

          not account.active ->
            Ash.Changeset.add_error(changeset, field: :account_id, message: "停用科目不能入账")

          true ->
            Ash.Changeset.force_change_attribute(changeset, :currency_id, account.currency_id)
        end

      {:ok, _account} ->
        Ash.Changeset.add_error(changeset, field: :account_id, message: "科目必须属于凭证所在公司")

      {:error, _} ->
        Ash.Changeset.add_error(changeset, field: :account_id, message: "科目不存在")
    end
  end
end

defmodule SynieCore.Acc.GlJournalLine.PartyExists do
  @moduledoc "对手校验:与类型同空同有;按类型查对应主数据表确认存在(多态引用无真外键)。"

  use Ash.Resource.Validation

  @party_resources %{
    supplier: SynieCore.Purchase.Supplier,
    customer: SynieCore.Sales.Customer
  }

  @impl true
  def validate(changeset, _opts, _context) do
    party_type = Ash.Changeset.get_attribute(changeset, :party_type)
    party_id = Ash.Changeset.get_attribute(changeset, :party_id)

    cond do
      is_nil(party_type) and is_nil(party_id) ->
        :ok

      is_nil(party_type) or is_nil(party_id) ->
        {:error, field: :party_id, message: "对手类型与对手必须同时填写"}

      true ->
        case Ash.get(Map.fetch!(@party_resources, party_type), party_id, authorize?: false) do
          {:ok, _} -> :ok
          {:error, _} -> {:error, field: :party_id, message: "对手不存在"}
        end
    end
  end
end

defmodule SynieCore.Acc.GlJournalLine do
  @moduledoc """
  凭证子条目,对应 `acc_gl_journal_line` 表。

  `company_id` 冗余自父凭证以复用公司数据权限;币种保存时从科目复制不可手改;
  仅父凭证草稿态可增删改。金额约束放宽为"至多一边>0"(草稿行允许 0/0 逐步录入),
  "恰一边>0"在凭证审核时由 GL.validate_entries 把关。
  无独立权限点:permission_actions 为空(不进权限目录),动作复用 `acc.gl_journal` 权限码。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    # 主 read 上的兜底排序(idx 升序)是有意为之,行按录入顺序展示依赖此序
    primary_read_warning?: false

  postgres do
    table "acc_gl_journal_line"
    repo SynieCore.Repo

    references do
      # 删草稿凭证 DB 级联删行(行不留单独审计,凭证删除已审计)
      reference :journal, on_delete: :delete
    end

    check_constraints do
      check_constraint :debit, "at_most_one_side",
        check: "debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0)",
        message: "借贷金额至多一边大于零"

      check_constraint :party_type, "party_pair",
        check: "(party_type IS NULL) = (party_id IS NULL)",
        message: "对手类型与对手必须同时填写"
    end
  end

  graphql do
    type :acc_gl_journal_line
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

  # 复用凭证权限码;actions 为空不进权限目录(同 UserRole 跟随 sys.user 的先例)
  def permission_prefix, do: "acc.gl_journal"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      prepare build(sort: [idx: :asc])
    end

    create :create do
      accept [:journal_id, :idx, :account_id, :debit, :credit, :party_type, :party_id, :remarks]

      # 顺序敏感:先回填 company_id,再做公司授权校验与币种复制
      change {SynieCore.Acc.GlJournalLine.SyncJournal, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Acc.GlJournalLine.CopyCurrency, []}
      validate {SynieCore.Acc.GlJournalLine.PartyExists, []}
    end

    update :update do
      accept [:idx, :account_id, :debit, :credit, :party_type, :party_id, :remarks]
      require_atomic? false

      change {SynieCore.Acc.GlJournalLine.SyncJournal, []}
      change {SynieCore.Acc.GlJournalLine.CopyCurrency, []}
      validate {SynieCore.Acc.GlJournalLine.PartyExists, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Acc.GlJournalLine.SyncJournal, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :idx, :integer do
      allow_nil? false
      public? true
      description "行号"
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

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "行备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :journal, SynieCore.Acc.GlJournal do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "凭证"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
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
      description "币种"
    end
  end
end
