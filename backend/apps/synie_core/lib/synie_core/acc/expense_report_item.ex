defmodule SynieCore.Acc.ExpenseReportItem.SyncReport do
  @moduledoc """
  行与母单同步:报销单必须存在且草稿态;create 时冗余 company_id。
  构建期预检 + before_action 事务内 FOR UPDATE 权威复检(同 ReconciliationItem.SyncReconciliation)。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    report_id = changeset_report_id(changeset)

    changeset =
      case read_report(report_id) do
        {:ok, %{status: :draft} = report} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, report.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :report_id, message: "报销单不存在")

        {:ok, _report} ->
          Ash.Changeset.add_error(changeset,
            field: :report_id,
            message: "仅草稿报销单可编辑报销行"
          )

        _ ->
          Ash.Changeset.add_error(changeset, field: :report_id, message: "报销单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_report(changeset_report_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :report_id, message: "报销单不存在")

        _ ->
          Ash.Changeset.add_error(cs, field: :report_id, message: "仅草稿报销单可编辑报销行")
      end
    end)
  end

  defp changeset_report_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :report_id) || changeset.data.report_id

  defp read_report(nil), do: {:ok, nil}

  defp read_report(id) do
    SynieCore.Acc.ExpenseReport
    |> Ash.Query.filter(id == ^id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_report(nil), do: {:ok, nil}

  defp lock_report(id) do
    SynieCore.Acc.ExpenseReport
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Acc.ExpenseReportItem.KindRules do
  @moduledoc """
  行类型两槽互斥(费用报销 ADR 2026-07-21):
  挂票行=只有发票+行备注(金额与科目过账时读发票,不冗余存储);
  无票行=摘要+金额+费用科目必填、发票必空,金额大于零,费用科目本公司启用非汇总。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :kind) do
      :invoiced -> check_invoiced(changeset)
      :manual -> check_manual(changeset)
      _ -> :ok
    end
  end

  defp check_invoiced(changeset) do
    cond do
      is_nil(Ash.Changeset.get_attribute(changeset, :invoice_id)) ->
        {:error, field: :invoice_id, message: "挂票行必须选择发票"}

      not is_nil(Ash.Changeset.get_attribute(changeset, :summary)) ->
        {:error, field: :summary, message: "挂票行不填写摘要"}

      not is_nil(Ash.Changeset.get_attribute(changeset, :amount)) ->
        {:error, field: :amount, message: "挂票行金额取发票价税合计,不手填"}

      not is_nil(Ash.Changeset.get_attribute(changeset, :expense_account_id)) ->
        {:error, field: :expense_account_id, message: "挂票行不选费用科目"}

      true ->
        :ok
    end
  end

  defp check_manual(changeset) do
    zero = Decimal.new(0)

    cond do
      not is_nil(Ash.Changeset.get_attribute(changeset, :invoice_id)) ->
        {:error, field: :invoice_id, message: "无票行不关联发票"}

      is_nil(Ash.Changeset.get_attribute(changeset, :summary)) ->
        {:error, field: :summary, message: "无票行必须填写摘要"}

      is_nil(Ash.Changeset.get_attribute(changeset, :amount)) ->
        {:error, field: :amount, message: "无票行必须填写金额"}

      Decimal.compare(Ash.Changeset.get_attribute(changeset, :amount), zero) != :gt ->
        {:error, field: :amount, message: "金额必须大于零"}

      is_nil(Ash.Changeset.get_attribute(changeset, :expense_account_id)) ->
        {:error, field: :expense_account_id, message: "无票行必须选择费用科目"}

      true ->
        check_expense_account(changeset)
    end
  end

  # 费用科目本公司启用非汇总(角色不限,报销类型带科目在前端;同 Receipt.DebitAccountOk 口径)
  defp check_expense_account(changeset) do
    account_id = Ash.Changeset.get_attribute(changeset, :expense_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case SynieCore.Purchase.Receipt.DebitAccountOk.check_account(account_id, company_id) do
      :ok -> :ok
      {:error, message} -> {:error, field: :expense_account_id, message: message}
    end
  end
end

defmodule SynieCore.Acc.ExpenseReportItem.BindInvoice do
  @moduledoc """
  绑定挂票发票:构建期预检(存在性)即可;before_action 事务内 FOR UPDATE 锁发票
  权威复检条目池口径——已审核、开入、与报销单同公司、本员工名下、未被其他非作废
  报销单引用(锁序恒为 单头→发票,与报销单审核一致)。仅挂票行生效。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset = precheck(changeset)

    Ash.Changeset.before_action(changeset, fn cs ->
      invoice_id = Ash.Changeset.get_attribute(cs, :invoice_id)

      if Ash.Changeset.get_attribute(cs, :kind) == :invoiced and not is_nil(invoice_id) do
        # SyncReport 声明在前,钩子同序执行,母单此时已 FOR UPDATE
        report_id = Ash.Changeset.get_attribute(cs, :report_id) || cs.data.report_id

        with {:ok, invoice} <- lock_invoice(invoice_id),
             {:ok, report} <- get_report(report_id),
             :ok <- check_pool(invoice, report) do
          cs
        else
          {:error, field, message} -> Ash.Changeset.add_error(cs, field: field, message: message)
        end
      else
        cs
      end
    end)
  end

  # 构建期预检(友好报错,不加锁):发票存在性粗检;权威校验在钩子里
  defp precheck(changeset) do
    invoice_id = Ash.Changeset.get_attribute(changeset, :invoice_id)

    if Ash.Changeset.get_attribute(changeset, :kind) == :invoiced and not is_nil(invoice_id) do
      case Ash.get(SynieCore.Acc.VatInvoice, invoice_id, authorize?: false) do
        {:ok, _invoice} -> changeset
        _ -> Ash.Changeset.add_error(changeset, field: :invoice_id, message: "挂票发票不存在")
      end
    else
      changeset
    end
  end

  defp lock_invoice(id) do
    SynieCore.Acc.VatInvoice
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
    |> case do
      {:ok, nil} -> {:error, :invoice_id, "挂票发票不存在"}
      {:ok, invoice} -> {:ok, invoice}
    end
  end

  defp get_report(nil), do: {:error, :report_id, "报销单不存在"}

  defp get_report(id) do
    case Ash.get(SynieCore.Acc.ExpenseReport, id, authorize?: false) do
      {:ok, report} -> {:ok, report}
      _ -> {:error, :report_id, "报销单不存在"}
    end
  end

  defp check_pool(invoice, report) do
    cond do
      invoice.status != :audited ->
        {:error, :invoice_id, "挂票发票须为已审核状态"}

      invoice.direction != :inbound ->
        {:error, :invoice_id, "挂票发票须为开入方向"}

      invoice.company_id != report.company_id ->
        {:error, :invoice_id, "挂票发票公司与报销单不一致"}

      invoice.party_type != :employee or invoice.party_id != report.employee_id ->
        {:error, :invoice_id, "挂票发票须为报销单员工名下"}

      SynieCore.Acc.ExpenseReport.invoice_referenced_by_other?(invoice.id, report.id) ->
        {:error, :invoice_id, "挂票发票已被其他报销单引用"}

      true ->
        :ok
    end
  end
end

defmodule SynieCore.Acc.ExpenseReportItem do
  @moduledoc """
  报销行,对应 `acc_expense_report_item` 表。两类行(互斥,见 `KindRules`):
  挂票行引用一张本公司该员工「已审核未报销」的费用报销发票(一票一单全额核销,
  金额与科目过账时读发票);无票行手填摘要+金额+费用科目(非税支出,税额恒 0)。
  行随报销单级联删除;被引用的发票不可删(on_delete nothing)。
  权限复用 `acc.expense_report`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    primary_read_warning?: false

  require Ash.Query

  postgres do
    table "acc_expense_report_item"
    repo SynieCore.Repo

    references do
      reference :report, on_delete: :delete

      # 被引用的发票不可删(须先在报销单草稿上移除该行或作废报销单)
      reference :invoice, on_delete: :nothing
    end
  end

  graphql do
    type :acc_expense_report_item
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

  def permission_prefix, do: "acc.expense_report"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      prepare fn query, _context ->
        if Enum.empty?(query.sort) do
          Ash.Query.sort(query, idx: :asc)
        else
          query
        end
      end
    end

    create :create do
      accept [
        :report_id,
        :idx,
        :kind,
        :invoice_id,
        :summary,
        :amount,
        :expense_account_id,
        :remarks
      ]

      change {SynieCore.Acc.ExpenseReportItem.SyncReport, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Acc.ExpenseReportItem.KindRules, []}
      change {SynieCore.Acc.ExpenseReportItem.BindInvoice, []}
    end

    update :update do
      accept [:idx, :kind, :invoice_id, :summary, :amount, :expense_account_id, :remarks]
      require_atomic? false

      change {SynieCore.Acc.ExpenseReportItem.SyncReport, []}
      validate {SynieCore.Acc.ExpenseReportItem.KindRules, []}
      change {SynieCore.Acc.ExpenseReportItem.BindInvoice, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Acc.ExpenseReportItem.SyncReport, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :idx, :integer do
      allow_nil? false
      public? true
      description "行号"
    end

    attribute :kind, SynieCore.Acc.ExpenseReportItemKind do
      allow_nil? false
      public? true
      description "行类型(挂票/无票)"
    end

    attribute :summary, :string do
      public? true
      constraints max_length: 256
      description "摘要(无票行必填)"
    end

    attribute :amount, :decimal do
      public? true
      description "金额(无票行必填;挂票行金额取发票价税合计,不冗余存储)"
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
    belongs_to :report, SynieCore.Acc.ExpenseReport do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "报销单"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :invoice, SynieCore.Acc.VatInvoice do
      public? true
      attribute_public? true
      attribute_writable? true
      description "挂票发票(挂票行必填)"
    end

    belongs_to :expense_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "费用科目(无票行必填)"
    end
  end
end
