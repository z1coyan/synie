defmodule SynieCore.Acc.BankImportItem.SyncImport do
  @moduledoc """
  行与父导入记录同步:仅父记录「已解析」态可改删行(已导入只读、解析失败无行可改)。

  构建期预检仅为友好报错(动作事务之外,普通读);权威复检在 before_action 内
  FOR UPDATE 锁父记录——与导入执行(同样锁父)互斥,关闭「边导入边改行」竞态。
  照 `GlJournalLine.SyncJournal` 先例。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    changeset =
      case read_import(changeset.data.import_id) do
        {:ok, %{status: :parsed}} ->
          changeset

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :import_id, message: "导入记录不存在")

        {:ok, _import} ->
          Ash.Changeset.add_error(changeset, field: :import_id, message: "仅「已解析」状态的导入记录可编辑或删除行")

        _ ->
          Ash.Changeset.add_error(changeset, field: :import_id, message: "导入记录不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case SynieCore.Acc.BankImport.lock_import(cs.data.import_id) do
        {:ok, %{status: :parsed}} -> cs
        _ -> Ash.Changeset.add_error(cs, field: :import_id, message: "仅「已解析」状态的导入记录可编辑或删除行")
      end
    end)
  end

  defp read_import(nil), do: {:ok, nil}

  defp read_import(import_id) do
    Ash.get(SynieCore.Acc.BankImport, import_id, authorize?: false, error?: false)
  end
end

defmodule SynieCore.Acc.BankImportItem do
  @moduledoc """
  银行流水导入行,对应 `acc_bank_import_item` 表。

  解析产物的暂存行:字段与流水一一对应但全可空(解析失败的字段留空、原因进
  `error`);用户在导入前可改可删,保存校验与流水同源(时间必填、收/支恰一项>0),
  通过即清 `error`;导入执行后回填 `transaction_id` 供追溯,行随父记录级联删除。
  无独立权限点:动作复用 `acc.bank_transaction:import`(同 GlJournalLine 借前缀先例)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    # 主 read 上的兜底排序(row_no 升序)是有意为之,行按文件顺序展示依赖此序
    primary_read_warning?: false

  postgres do
    table "acc_bank_import_item"
    repo SynieCore.Repo

    references do
      # 删导入记录 DB 级联删行(行不留单独审计,记录删除已审计;凭证删行先例)
      reference :import, on_delete: :delete
    end

    custom_indexes do
      index [:import_id]
    end
  end

  graphql do
    type :acc_bank_import_item
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "import"}
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  # 复用流水导入权限码;actions 为空不进权限目录(同 GlJournalLine 先例)
  def permission_prefix, do: "acc.bank_transaction"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      prepare build(sort: [row_no: :asc])
    end

    # 仅解析内部路径使用(ParseOnCreate bulk_create),不注册 GraphQL mutation
    create :create do
      accept [
        :import_id,
        :company_id,
        :row_no,
        :occurred_at,
        :income,
        :expense,
        :balance,
        :counterparty_name,
        :counterparty_account,
        :summary,
        :note,
        :error
      ]
    end

    update :update do
      accept [
        :occurred_at,
        :income,
        :expense,
        :balance,
        :counterparty_name,
        :counterparty_account,
        :summary,
        :note
      ]

      require_atomic? false

      change {SynieCore.Acc.BankImportItem.SyncImport, []}

      # 保存校验与流水同源:通过即代表该行可导入,顺手清 error
      validate present(:occurred_at), message: "交易时间必须填写"
      validate {SynieCore.Acc.BankTransaction.SingleSidedAmount, []}

      change fn changeset, _context ->
        Ash.Changeset.force_change_attribute(changeset, :error, nil)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Acc.BankImportItem.SyncImport, []}
    end

    # 导入执行回填流水引用(内部路径,authorize?: false 调用),不设状态 guard:
    # 调用时父记录已在同事务内转为 imported
    update :link_transaction do
      accept [:transaction_id]
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :row_no, :integer do
      allow_nil? false
      public? true
      description "行号"
    end

    attribute :occurred_at, :utc_datetime do
      public? true
      description "交易时间"
    end

    attribute :income, :decimal do
      public? true
      description "收入金额"
    end

    attribute :expense, :decimal do
      public? true
      description "支出金额"
    end

    attribute :balance, :decimal do
      public? true
      description "余额"
    end

    attribute :counterparty_name, :string do
      public? true
      constraints max_length: 128
      description "对方户名"
    end

    attribute :counterparty_account, :string do
      public? true
      constraints max_length: 64
      description "对方账号"
    end

    attribute :summary, :string do
      public? true
      constraints max_length: 255
      description "摘要"
    end

    attribute :note, :string do
      public? true
      constraints max_length: 255
      description "备注"
    end

    attribute :error, :string do
      public? true
      constraints max_length: 500
      description "行错误"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :import, SynieCore.Acc.BankImport do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "导入记录"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :transaction, SynieCore.Acc.BankTransaction do
      public? true
      attribute_public? true
      attribute_writable? true
      description "生成的银行流水"
    end
  end
end
