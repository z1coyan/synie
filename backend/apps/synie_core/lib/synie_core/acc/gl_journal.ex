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
  编号公司内唯一:留空按 `acc.gl_journal` 编号规则自动取号(AutoNumber),手填原样保留。
  删除草稿时行由 DB 级联删除(行不留单独审计记录,凭证删除本身已审计)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

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

  def grid_actions do
    [
      %{key: "audit", label: "审核", scope: "row", mutation: "auditAccGlJournal", is_danger: false},
      %{key: "cancel", label: "取消", scope: "row", mutation: "cancelAccGlJournal", is_danger: true}
    ]
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

    create :create do
      accept [:company_id, :voucher_no, :date, :posting_date, :remarks]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :voucher_no}

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

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Acc.JournalDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后头字段被改"竞态
          case __MODULE__.lock_journal(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿凭证可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Acc.JournalDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后凭证被删、分录成孤儿"竞态
          case __MODULE__.lock_journal(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿凭证可修改或删除")
          end
        end)
      end
    end

    update :audit do
      # 过账日期可在审核时补填/修正;凭证已有且未传时沿用原值
      accept [:posting_date]
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿凭证可审核"}
      end

      validate fn changeset, _context ->
        if Ash.Changeset.get_attribute(changeset, :posting_date) do
          :ok
        else
          {:error, field: :posting_date, message: "审核过账前必须填写过账日期"}
        end
      end

      validate fn changeset, _context ->
        case SynieCore.Acc.GL.validate_entries(
               changeset.data.company_id,
               __MODULE__.load_line_entries(changeset.data.id)
             ) do
          :ok -> :ok
          {:error, msg} -> {:error, message: msg}
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :audited)
        |> Ash.Changeset.force_change_attribute(:submitted_at, DateTime.utc_now())
        |> then(fn cs ->
          case context.actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :submitted_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:before_action 在动作事务内执行,FOR UPDATE 持锁到事务提交,
          # 借此串行化审核与行编辑/并发审核——关闭双审核竞态(构建期预检看到的状态可能已过期)
          case __MODULE__.lock_journal(cs.data.id) do
            {:ok, %{status: :draft}} ->
              case SynieCore.Acc.GL.validate_entries(
                     cs.data.company_id,
                     __MODULE__.load_line_entries(cs.data.id)
                   ) do
                :ok -> cs
                {:error, msg} -> Ash.Changeset.add_error(cs, message: msg)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿凭证可审核")
          end
        end)
        |> Ash.Changeset.after_action(fn _changeset, journal ->
          # 最后防线:事务内重读行并复检后过账(纵深防御,正常流程不应触发)
          SynieCore.Acc.GL.post!(
            %{
              voucher_type: "acc.gl_journal",
              voucher_id: journal.id,
              voucher_no: journal.voucher_no,
              company_id: journal.company_id,
              posting_date: journal.posting_date
            },
            __MODULE__.load_line_entries(journal.id)
          )

          {:ok, journal}
        end)
      end
    end

    update :cancel do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核凭证可取消"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :cancelled)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭双取消竞态(与审核同根因)
          case __MODULE__.lock_journal(cs.data.id) do
            {:ok, %{status: :audited}} ->
              # 有银行对账关联的凭证不可取消(对账以「已审核」为前提;先解除再取消)
              used? =
                SynieCore.Acc.BankReconciliation
                |> Ash.Query.filter(journal_id == ^cs.data.id)
                |> Ash.exists?(authorize?: false)

              if used? do
                Ash.Changeset.add_error(cs, message: "凭证已用于银行对账,请先解除对账")
              else
                cs
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅已审核凭证可取消")
          end
        end)
        |> Ash.Changeset.after_action(fn _changeset, journal ->
          SynieCore.Acc.GL.cancel!("acc.gl_journal", journal.id)
          {:ok, journal}
        end)
      end
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
      # 草稿可不填,审核时必须有(audit 动作校验)
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

  aggregates do
    sum :debit_total, :lines, :debit do
      public? true
      description "借方总金额"
    end

    sum :credit_total, :lines, :credit do
      public? true
      description "贷方总金额"
    end
  end

  identities do
    identity :unique_voucher_no_per_company, [:company_id, :voucher_no]
  end

  @doc false
  # 凭证粒度锁:FOR UPDATE 锁住凭证行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化行编辑/审核/取消
  def lock_journal(journal_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^journal_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 读凭证全部行并转成 GL entries 形状(audit 的校验与过账共用)
  def load_line_entries(journal_id) do
    SynieCore.Acc.GlJournalLine
    |> Ash.Query.filter(journal_id == ^journal_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
    |> Enum.map(
      &Map.take(&1, [:account_id, :currency_id, :debit, :credit, :party_type, :party_id, :remarks])
    )
  end
end
