defmodule SynieCore.Acc.ExpenseReportStatus do
  @moduledoc "报销单状态:草稿/已审核/已作废(无红冲,纠错=作废+重开)。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]

  def graphql_type(_), do: :acc_expense_report_status
end

defmodule SynieCore.Acc.ExpenseReportItemKind do
  @moduledoc "报销单行类型:挂票(引用费用报销发票)/无票(手填非税支出)。"

  use Ash.Type.Enum, values: [invoiced: "挂票", manual: "无票"]

  def graphql_type(_), do: :acc_expense_report_item_kind
end

defmodule SynieCore.Acc.ExpenseReportDraft do
  @moduledoc "校验报销单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿报销单可修改或删除"}
    end
  end
end

defmodule SynieCore.Acc.ExpenseReport.PaymentAccountOk do
  @moduledoc """
  付款科目必填,须本公司、启用、非汇总(贷方付款科目,角色不限,银行存款/库存现金类)。
  草稿保存即校验(同 Receipt.DebitAccountOk 先例)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :payment_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      {:error, field: :payment_account_id, message: "付款科目不能为空"}
    else
      case SynieCore.Purchase.Receipt.DebitAccountOk.check_account(account_id, company_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: :payment_account_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Acc.ExpenseReport do
  @moduledoc """
  报销单(头),对应 `acc_expense_report` 表:对员工付款的核销单据,费用报销两步模型
  的第二步(费用报销发票审核即挂账 → 报销单付款核销,决策见
  docs/adr/2026-07-21-expense-reimbursement.md)。

  状态机:草稿(可改可删)→ 已审核(audit,`GL.post!` 过账)→(已作废 void,
  `GL.cancel!` 回滚分录;无红冲)。审核分录:每挂票行 借<发票往来科目,金额=发票
  价税合计,带员工对手>、每无票行 借<行费用科目,金额=行金额,不带对手>、
  贷<付款科目,Σ 全部行>。作废后挂票行数据保留,发票引用靠「非作废」条件自然解除,
  发票回到「已审核未报销」。行见 `SynieCore.Acc.ExpenseReportItem`。

  单号 `doc_no` 公司内唯一,留空按 `acc.expense_report` 编号规则自动取号(AutoNumber)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "acc_expense_report"
    repo SynieCore.Repo

    custom_indexes do
      index [:company_id, :status]
    end
  end

  graphql do
    type :acc_expense_report
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :create, :update, :destroy, :audit, :void]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 公司维度 fail-closed;update/destroy 取数走 read,同样被此过滤兜住
    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "acc.expense_report"
  def permission_label, do: "报销单"
  def permission_actions, do: ~w(create read update delete audit void)

  def grid_actions do
    [
      %{
        key: "audit",
        label: "审核",
        scope: "row",
        mutation: "auditAccExpenseReport",
        is_danger: false
      },
      %{
        key: "void",
        label: "作废",
        scope: "row",
        mutation: "voidAccExpenseReport",
        is_danger: true
      }
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
      accept [
        :company_id,
        :doc_no,
        :employee_id,
        :expense_date,
        :posting_date,
        :payment_account_id,
        :remarks
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Acc.ExpenseReport.PaymentAccountOk, []}

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :doc_no}

      # 录入人自动取 actor;nil actor 只出现在受信内部路径,允许留空
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
      # 不接受 company_id:公司创建后不可改(同发票先例)
      accept [:doc_no, :employee_id, :expense_date, :posting_date, :payment_account_id, :remarks]
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Acc.ExpenseReportDraft, []}
      validate {SynieCore.Acc.ExpenseReport.PaymentAccountOk, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后头字段被改"竞态
          case __MODULE__.lock_report(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿报销单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Acc.ExpenseReportDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后报销单被删"竞态
          case __MODULE__.lock_report(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿报销单可修改或删除")
          end
        end)
      end
    end

    update :audit do
      # 过账日期可在审核时补填/修正
      accept [:posting_date]
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿报销单可审核"}
      end

      validate fn changeset, _context ->
        if Ash.Changeset.get_attribute(changeset, :posting_date) do
          :ok
        else
          {:error, field: :posting_date, message: "审核过账前必须填写过账日期"}
        end
      end

      validate fn changeset, _context ->
        case __MODULE__.audit_blockers(changeset.data) do
          [] ->
            case SynieCore.Acc.GL.validate_entries(
                   changeset.data.company_id,
                   __MODULE__.gl_entries(changeset.data)
                 ) do
              :ok -> :ok
              {:error, msg} -> {:error, message: msg}
            end

          msgs ->
            {:error, message: Enum.join(msgs, ";")}
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :audited)
        |> Ash.Changeset.force_change_attribute(:audited_at, DateTime.utc_now())
        |> then(fn cs ->
          case context.actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :audited_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:before_action 在动作事务内执行,FOR UPDATE 持锁到事务提交,
          # 借此串行化审核与并发改头/并发审核;挂票发票一并锁住,关闭
          # "两报销单同时核销同一票"竞态(构建期预检看到的状态可能已过期)
          case __MODULE__.lock_report(cs.data.id) do
            {:ok, %{status: :draft}} ->
              __MODULE__.lock_invoices(cs.data.id)

              case __MODULE__.audit_blockers(cs.data) do
                [] ->
                  case SynieCore.Acc.GL.validate_entries(
                         cs.data.company_id,
                         __MODULE__.gl_entries(cs.data)
                       ) do
                    :ok -> cs
                    {:error, msg} -> Ash.Changeset.add_error(cs, message: msg)
                  end

                msgs ->
                  Ash.Changeset.add_error(cs, message: Enum.join(msgs, ";"))
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿报销单可审核")
          end
        end)
        |> Ash.Changeset.after_action(fn _cs, report ->
          # 最后防线:事务内重读后过账(纵深防御,正常流程不应触发)
          SynieCore.Acc.GL.post!(
            %{
              voucher_type: "acc.expense_report",
              voucher_id: report.id,
              voucher_no: report.doc_no,
              company_id: report.company_id,
              posting_date: report.posting_date
            },
            __MODULE__.gl_entries(report)
          )

          {:ok, report}
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited,
          do: :ok,
          else: {:error, message: "仅已审核报销单可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭双作废竞态
          case __MODULE__.lock_report(cs.data.id) do
            {:ok, %{status: :audited}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核报销单可作废")
          end
        end)
        |> Ash.Changeset.after_action(fn _cs, report ->
          # 行数据保留,发票引用靠「非作废」条件自然解除
          SynieCore.Acc.GL.cancel!("acc.expense_report", report.id)
          {:ok, report}
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :doc_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "单据编号(留空自动取号)"
    end

    attribute :expense_date, :date do
      allow_nil? false
      public? true
      description "报销日期"
    end

    attribute :posting_date, :date do
      # 草稿可不填,审核时必须有(audit 动作校验)
      public? true
      description "过账日期"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "备注"
    end

    attribute :status, SynieCore.Acc.ExpenseReportStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
    end

    attribute :audited_at, :utc_datetime_usec do
      writable? false
      public? true
      description "审核时间"
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

    belongs_to :employee, SynieCore.Hr.Employee do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "员工(报销对象)"
    end

    belongs_to :payment_account, SynieCore.Base.Account do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "付款科目(贷方,银行存款/库存现金类;草稿必填)"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end

    belongs_to :audited_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "审核人"
    end

    has_many :items, SynieCore.Acc.ExpenseReportItem do
      destination_attribute :report_id
      sort idx: :asc
      public? true
      description "报销行"
    end
  end

  identities do
    identity :unique_doc_no_per_company, [:company_id, :doc_no], message: "单据编号已存在"
  end

  @doc false
  # 报销单粒度锁:FOR UPDATE 锁住单头行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化改/删/审核/作废
  def lock_report(report_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^report_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 挂票发票粒度锁:审核权威复检时把涉及的发票一并 FOR UPDATE,
  # 串行化"两报销单同时核销同一票"竞态(锁序恒为 单头→发票,与行绑定一致)
  def lock_invoices(report_id) do
    invoice_ids =
      SynieCore.Acc.ExpenseReportItem
      |> Ash.Query.filter(report_id == ^report_id and not is_nil(invoice_id))
      |> Ash.read!(authorize?: false)
      |> Enum.map(& &1.invoice_id)
      |> Enum.uniq()

    SynieCore.Acc.VatInvoice
    |> Ash.Query.filter(id in ^invoice_ids)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read!(authorize?: false)
  end

  @doc false
  def load_items(report_id) do
    SynieCore.Acc.ExpenseReportItem
    |> Ash.Query.filter(report_id == ^report_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  @doc "发票是否被任一非作废报销单的挂票行引用(发票作废/红冲守卫与行绑定校验共用)"
  def invoice_referenced?(invoice_id) do
    SynieCore.Acc.ExpenseReportItem
    |> Ash.Query.filter(invoice_id == ^invoice_id and report.status != :voided)
    |> Ash.exists?(authorize?: false)
  end

  @doc "发票是否被其他非作废报销单引用(审核一票一单校验)"
  def invoice_referenced_by_other?(invoice_id, report_id) do
    SynieCore.Acc.ExpenseReportItem
    |> Ash.Query.filter(
      invoice_id == ^invoice_id and report_id != ^report_id and report.status != :voided
    )
    |> Ash.exists?(authorize?: false)
  end

  @doc "审核前的齐全性检查,返回错误清单(空 = 可审核)。"
  def audit_blockers(%__MODULE__{} = report) do
    items = load_items(report.id)

    if items == [] do
      ["审核前必须至少填写一行报销行"]
    else
      invoices = load_invoices(items)
      accounts = load_accounts(items, invoices)

      items
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {item, position} ->
        item_blockers(item, position, report, invoices, accounts)
      end)
    end
  end

  # 挂票行:发票须已审核、开入、本公司、本员工名下、未被其他非作废报销单引用
  defp item_blockers(%{kind: :invoiced} = item, position, report, invoices, _accounts) do
    case invoices[item.invoice_id] do
      nil ->
        ["第#{position}行:挂票发票不存在"]

      inv ->
        [
          {inv.status != :audited, "第#{position}行:挂票发票须为已审核状态"},
          {inv.direction != :inbound, "第#{position}行:挂票发票须为开入方向"},
          {inv.company_id != report.company_id, "第#{position}行:挂票发票公司与报销单不一致"},
          {inv.party_type != :employee or inv.party_id != report.employee_id,
           "第#{position}行:挂票发票须为报销单员工名下"},
          {__MODULE__.invoice_referenced_by_other?(inv.id, report.id),
           "第#{position}行:挂票发票已被其他报销单引用"}
        ]
        |> Enum.filter(&elem(&1, 0))
        |> Enum.map(&elem(&1, 1))
    end
  end

  # 无票行:金额大于零、费用科目本公司启用非汇总
  defp item_blockers(%{kind: :manual} = item, position, report, _invoices, accounts) do
    account = accounts[item.expense_account_id]
    zero = Decimal.new(0)

    [
      {is_nil(item.amount) or Decimal.compare(item.amount, zero) != :gt, "第#{position}行:金额必须大于零"},
      {is_nil(item.expense_account_id), "第#{position}行:费用科目不能为空"},
      {not is_nil(item.expense_account_id) and is_nil(account), "第#{position}行:费用科目不存在"},
      {not is_nil(account) and account.company_id != report.company_id,
       "第#{position}行:费用科目必须属于报销单公司"},
      {not is_nil(account) and account.is_group, "第#{position}行:费用科目不能是汇总科目"},
      {not is_nil(account) and not account.active, "第#{position}行:费用科目已停用"}
    ]
    |> Enum.filter(&elem(&1, 0))
    |> Enum.map(&elem(&1, 1))
  end

  @doc "派生审核过账分录组:挂票行借发票往来科目(带员工对手)/无票行借费用科目,贷付款科目(Σ 全部行)。"
  def gl_entries(%__MODULE__{} = report) do
    items = load_items(report.id)
    invoices = load_invoices(items)

    account_ids =
      [report.payment_account_id] ++
        Enum.flat_map(items, fn
          %{kind: :invoiced} = item -> [invoices[item.invoice_id].party_account_id]
          %{kind: :manual} = item -> [item.expense_account_id]
        end)

    currencies =
      SynieCore.Base.Account
      |> Ash.Query.filter(id in ^Enum.uniq(account_ids))
      |> Ash.read!(authorize?: false)
      |> Map.new(&{&1.id, &1.currency_id})

    zero = Decimal.new(0)

    debit_entries =
      Enum.map(items, fn
        %{kind: :invoiced} = item ->
          inv = invoices[item.invoice_id]

          %{
            account_id: inv.party_account_id,
            currency_id: currencies[inv.party_account_id],
            debit: inv.gross_total,
            credit: zero,
            party_type: :employee,
            party_id: report.employee_id,
            remarks: nil
          }

        %{kind: :manual} = item ->
          %{
            account_id: item.expense_account_id,
            currency_id: currencies[item.expense_account_id],
            debit: item.amount,
            credit: zero,
            party_type: nil,
            party_id: nil,
            remarks: nil
          }
      end)

    total = Enum.reduce(debit_entries, zero, &Decimal.add(&1.debit, &2))

    debit_entries ++
      [
        %{
          account_id: report.payment_account_id,
          currency_id: currencies[report.payment_account_id],
          debit: zero,
          credit: total,
          party_type: nil,
          party_id: nil,
          remarks: nil
        }
      ]
  end

  defp load_invoices(items) do
    ids = items |> Enum.map(& &1.invoice_id) |> Enum.reject(&is_nil/1) |> Enum.uniq()

    SynieCore.Acc.VatInvoice
    |> Ash.Query.filter(id in ^ids)
    |> Ash.read!(authorize?: false)
    |> Map.new(&{&1.id, &1})
  end

  defp load_accounts(items, invoices) do
    ids =
      items
      |> Enum.flat_map(fn
        %{kind: :invoiced} = item ->
          case invoices[item.invoice_id] do
            nil -> []
            inv -> [inv.party_account_id]
          end

        %{kind: :manual} = item ->
          List.wrap(item.expense_account_id)
      end)
      |> Enum.uniq()

    SynieCore.Base.Account
    |> Ash.Query.filter(id in ^ids)
    |> Ash.read!(authorize?: false)
    |> Map.new(&{&1.id, &1})
  end
end
