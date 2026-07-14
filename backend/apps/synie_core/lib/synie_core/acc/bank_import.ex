defmodule SynieCore.Acc.BankImportStatus do
  @moduledoc "导入记录状态:已解析/解析失败/已导入。"

  use Ash.Type.Enum,
    values: [parsed: "已解析", failed: "解析失败", imported: "已导入"]

  def graphql_type(_), do: :acc_bank_import_status
end

defmodule SynieCore.Acc.BankImport.TemplateMatchesAccount do
  @moduledoc "校验导入模板属于所选银行账户(同公司由账户校验传递保证)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    template_id = Ash.Changeset.get_attribute(changeset, :template_id)
    bank_account_id = Ash.Changeset.get_attribute(changeset, :bank_account_id)

    case template_id &&
           Ash.get(SynieCore.Acc.BankImportTemplate, template_id,
             authorize?: false,
             error?: false
           ) do
      # allow_nil? false 的必填校验兜底
      nil -> :ok
      {:ok, nil} -> {:error, field: :template_id, message: "导入模板不存在"}
      {:ok, %{bank_account_id: ^bank_account_id}} -> :ok
      {:ok, _template} -> {:error, field: :template_id, message: "导入模板必须属于所选银行账户"}
    end
  end
end

defmodule SynieCore.Acc.BankImport.ReadableFile do
  @moduledoc "校验上传文件对 actor 可见(防拿他人文件 id 挂导入);内部路径(nil actor)跳过。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, context) do
    file_id = Ash.Changeset.get_attribute(changeset, :file_id)

    with %SynieCore.Authz.Actor{} = actor <- context.actor,
         false <- actor.super_admin,
         {:ok, nil} <- file_or_error(file_id, actor) do
      {:error, field: :file_id, message: "导入文件不存在或不可见"}
    else
      _ -> :ok
    end
  end

  defp file_or_error(nil, _actor), do: :ok

  defp file_or_error(file_id, actor) do
    Ash.get(SynieCore.Files.File, file_id, actor: actor, authorize?: true, error?: false)
  rescue
    # 读策略拒绝按不可见处理
    _ -> {:ok, nil}
  end
end

defmodule SynieCore.Acc.BankImport.NoDuplicateFile do
  @moduledoc """
  同账户同文件(sha256)防呆:已存在非 failed 状态的相同文件导入记录即拒绝
  (误重传是主要事故来源;确要重导可先删除原记录)。行级指纹去重是范围外。
  """

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    file_id = Ash.Changeset.get_attribute(changeset, :file_id)
    bank_account_id = Ash.Changeset.get_attribute(changeset, :bank_account_id)

    with true <- file_id != nil and bank_account_id != nil,
         {:ok, %{sha256: sha256}} when is_binary(sha256) <-
           Ash.get(SynieCore.Files.File, file_id, authorize?: false, error?: false),
         {:ok, [_existing | _]} <-
           SynieCore.Acc.BankImport
           |> Ash.Query.filter(
             bank_account_id == ^bank_account_id and status != :failed and file.sha256 == ^sha256
           )
           |> Ash.Query.limit(1)
           |> Ash.read(authorize?: false) do
      {:error, field: :file_id, message: "该账户已存在相同文件的导入记录,如需重新导入请先删除原记录"}
    else
      _ -> :ok
    end
  end
end

defmodule SynieCore.Acc.BankImport.ParseOnCreate do
  @moduledoc """
  create 即解析:before_action(动作事务内)读文件按模板解析——成功置 parsed
  并把行暂存 changeset context,失败置 failed + error(不 raise,失败记录照常
  落库供导入历史追溯);after_action 把暂存行批量插入导入行表(authorize?: false
  内部路径,带 actor 供审计,照 GL.post! 先例)。
  """

  use Ash.Resource.Change

  alias SynieCore.Acc.BankImport.Parser

  @impl true
  def change(changeset, _opts, context) do
    actor = context.actor

    changeset
    |> Ash.Changeset.before_action(fn cs ->
      case parse(cs) do
        {:ok, items} ->
          cs
          |> Ash.Changeset.force_change_attribute(:status, :parsed)
          |> Ash.Changeset.set_context(%{parsed_items: items})

        {:error, message} ->
          cs
          |> Ash.Changeset.force_change_attribute(:status, :failed)
          |> Ash.Changeset.force_change_attribute(:error, String.slice(message, 0, 500))
      end
    end)
    |> Ash.Changeset.after_action(fn cs, record ->
      case cs.context[:parsed_items] do
        nil ->
          {:ok, record}

        items ->
          rows =
            Enum.map(items, fn item ->
              Map.merge(item, %{import_id: record.id, company_id: record.company_id})
            end)

          %Ash.BulkResult{status: :success} =
            Ash.bulk_create(rows, SynieCore.Acc.BankImportItem, :create,
              authorize?: false,
              actor: actor,
              return_errors?: true,
              stop_on_error?: true
            )

          {:ok, record}
      end
    end)
  end

  defp parse(changeset) do
    with {:ok, template} <-
           fetch(SynieCore.Acc.BankImportTemplate, changeset, :template_id, "导入模板不存在"),
         {:ok, file} <- fetch(SynieCore.Files.File, changeset, :file_id, "导入文件不存在"),
         {:ok, binary} <- read_file(file) do
      Parser.parse(template, binary)
    end
  end

  defp fetch(resource, changeset, field, missing_message) do
    case Ash.get(resource, Ash.Changeset.get_attribute(changeset, field),
           authorize?: false,
           error?: false
         ) do
      {:ok, nil} -> {:error, missing_message}
      {:ok, record} -> {:ok, record}
      {:error, _} -> {:error, missing_message}
    end
  end

  defp read_file(file) do
    case SynieCore.Storage.read(file.storage, file.key) do
      {:ok, binary} -> {:ok, binary}
      {:error, _reason} -> {:error, "读取存储对象失败,请重新上传文件"}
    end
  end
end

defmodule SynieCore.Acc.BankImport do
  @moduledoc """
  银行流水导入记录,对应 `acc_bank_import` 表。

  一次导入 = 一条记录:create 即按模板解析上传的 xlsx(状态 parsed/failed),
  行落导入行表;`import` 动作把全部无错行转正为银行流水(带 actor 逐行走正常
  授权与校验,任一行失败整体回滚)并回填行的流水引用,状态 imported 后只读、
  不可删。解析后表单锁定:无 header update 动作,配置错误删除重来。
  无独立权限点:全链路复用 `acc.bank_transaction:import`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "acc_bank_import"
    repo SynieCore.Repo

    custom_indexes do
      index [:company_id]
    end
  end

  graphql do
    type :acc_bank_import
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "import"}
    end

    # 公司维度 fail-closed;update/destroy 取数走 read,同样被此过滤兜住
    policy action_type(:read) do
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
    end

    create :create do
      accept [:company_id, :bank_account_id, :template_id, :file_id]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Acc.OwnBankAccount, check_active: true}
      validate {SynieCore.Acc.BankImport.TemplateMatchesAccount, []}
      validate {SynieCore.Acc.BankImport.ReadableFile, []}
      validate {SynieCore.Acc.BankImport.NoDuplicateFile, []}

      # 发起人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end

      change {SynieCore.Acc.BankImport.ParseOnCreate, []}
    end

    update :import do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :parsed,
          do: :ok,
          else: {:error, message: "仅「已解析」状态的导入记录可执行导入"}
      end

      change fn changeset, context ->
        actor = context.actor

        changeset
        |> Ash.Changeset.force_change_attribute(:status, :imported)
        |> Ash.Changeset.force_change_attribute(:imported_at, DateTime.utc_now())
        |> then(fn cs ->
          case actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :imported_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:FOR UPDATE 持锁到事务提交,串行化双导入/导入与改行删记录并发
          with {:ok, %{status: :parsed}} <- __MODULE__.lock_import(cs.data.id),
               items when items != [] <- load_items(cs.data.id) do
            case Enum.filter(items, &(&1.error != nil)) do
              [] ->
                Ash.Changeset.set_context(cs, %{import_items: items})

              bad ->
                rows = bad |> Enum.map(& &1.row_no) |> Enum.take(5) |> Enum.join("、")

                Ash.Changeset.add_error(cs,
                  message:
                    "存在 #{length(bad)} 行错误(第 #{rows} 行#{if length(bad) > 5, do: " 等", else: ""}),修正或删除后才能导入"
                )
            end
          else
            [] -> Ash.Changeset.add_error(cs, message: "没有可导入的行")
            _ -> Ash.Changeset.add_error(cs, message: "仅「已解析」状态的导入记录可执行导入")
          end
        end)
        |> Ash.Changeset.after_action(fn cs, record ->
          create_transactions(cs.context[:import_items] || [], record, actor)
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 已导入记录留档追溯不可删;构建期预检 + before_action 锁复检(与导入执行互斥)
      validate fn changeset, _context ->
        if changeset.data.status in [:parsed, :failed],
          do: :ok,
          else: {:error, message: "已导入的记录不可删除"}
      end

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_import(cs.data.id) do
            {:ok, %{status: status}} when status in [:parsed, :failed] -> cs
            _ -> Ash.Changeset.add_error(cs, message: "已导入的记录不可删除")
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :status, SynieCore.Acc.BankImportStatus do
      allow_nil? false
      public? true

      # 占位默认:必填校验先于 before_action(AutoNumber 同款时序),实际值由 ParseOnCreate 权威覆盖
      default :parsed
      description "状态"
    end

    attribute :error, :string do
      public? true
      constraints max_length: 500
      description "解析失败原因"
    end

    attribute :imported_at, :utc_datetime do
      public? true
      description "导入时间"
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

    belongs_to :bank_account, SynieCore.Acc.BankAccount do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "银行账户"
    end

    belongs_to :template, SynieCore.Acc.BankImportTemplate do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "导入模板"
    end

    belongs_to :file, SynieCore.Files.File do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "导入文件"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "发起人"
    end

    belongs_to :imported_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "导入人"
    end

    has_many :items, SynieCore.Acc.BankImportItem do
      public? true
      destination_attribute :import_id
      description "导入行"
    end
  end

  aggregates do
    count :item_count, :items do
      public? true
      description "行数"
    end

    count :error_count, :items do
      public? true
      filter expr(not is_nil(error))
      description "错误行数"
    end
  end

  @doc false
  # 导入记录粒度锁:FOR UPDATE 锁记录行本身;仅在 before_action 钩子内调用才有效
  # (照 VatInvoice.lock_invoice 先例),导入执行/改行/删记录三方互斥靠它
  def lock_import(import_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^import_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  defp load_items(import_id) do
    SynieCore.Acc.BankImportItem
    |> Ash.Query.filter(import_id == ^import_id)
    |> Ash.Query.sort(row_no: :asc)
    |> Ash.read!(authorize?: false)
  end

  # 逐行带 actor 走正常授权与校验(需 acc.bank_transaction:create,纵深防御);
  # 任一行失败返回 {:error, …} 令整个导入事务回滚
  defp create_transactions(items, record, actor) do
    Enum.reduce_while(items, {:ok, record}, fn item, acc ->
      attrs = %{
        company_id: record.company_id,
        bank_account_id: record.bank_account_id,
        occurred_at: item.occurred_at,
        income: item.income,
        expense: item.expense,
        balance: item.balance,
        counterparty_name: item.counterparty_name,
        counterparty_account: item.counterparty_account,
        summary: item.summary,
        note: item.note
      }

      try do
        transaction =
          SynieCore.Acc.BankTransaction
          |> Ash.Changeset.for_create(:create, attrs)
          |> Ash.create!(actor: actor, authorize?: true)

        item
        |> Ash.Changeset.for_update(:link_transaction, %{transaction_id: transaction.id})
        |> Ash.update!(authorize?: false, actor: actor)

        {:cont, acc}
      rescue
        e in [Ash.Error.Forbidden] ->
          _ = e
          {:halt, {:error, "第 #{item.row_no} 行导入失败:无权新增银行流水(需要「银行流水-新增」权限)"}}

        e in [Ash.Error.Invalid] ->
          messages =
            e.errors
            |> Enum.map(fn
              %{message: message} when is_binary(message) -> message
              other -> Exception.message(other)
            end)
            |> Enum.join(";")

          {:halt, {:error, "第 #{item.row_no} 行导入失败:#{messages}"}}
      end
    end)
  end
end
