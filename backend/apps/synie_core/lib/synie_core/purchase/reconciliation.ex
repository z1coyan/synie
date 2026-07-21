defmodule SynieCore.Purchase.ReconciliationType do
  @moduledoc "采购对账单类型:常规/赠送样品(手选必填、保存后锁死,两类约束不对称,镜像销售对账 ADR 2026-07-21)。"

  use Ash.Type.Enum, values: [regular: "常规", gift_sample: "赠送/样品"]

  def graphql_type(_), do: :pur_reconciliation_type
end

defmodule SynieCore.Purchase.ReconciliationStatus do
  @moduledoc "采购对账单状态:草稿/供应商已确认/已结单/已作废(常规单无作废,赠送/样品单无确认)。"

  use Ash.Type.Enum,
    values: [draft: "草稿", confirmed: "供应商已确认", closed: "已结单", voided: "已作废"]

  def graphql_type(_), do: :pur_reconciliation_status
end

defmodule SynieCore.Purchase.ReconciliationDraft do
  @moduledoc "校验对账单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿采购对账单可修改或删除"}
    end
  end
end

defmodule SynieCore.Purchase.ReconciliationTypeLocked do
  @moduledoc "对账类型锁死:新建时手选必填,保存后不可变更(换类型只能作废/删单重开,同订单类型先例)。仅挂 update。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if Ash.Changeset.get_attribute(changeset, :reconciliation_type) ==
         changeset.data.reconciliation_type do
      :ok
    else
      {:error, field: :reconciliation_type, message: "对账类型不可变更"}
    end
  end
end

defmodule SynieCore.Purchase.ReconciliationPartyType do
  @moduledoc "对账单对手类型限供应商/内部公司(与采购订单/入库单一致)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :party_type) do
      nil -> :ok
      t when t in [:supplier, :company] -> :ok
      _ -> {:error, field: :party_type, message: "对手类型只能为供应商或内部公司"}
    end
  end
end

defmodule SynieCore.Purchase.Reconciliation.HeadFieldsFrozen do
  @moduledoc """
  头关键字段变更闸:对账单已有行时,对手不可再改——行上入库条目已锚定
  公司/对手/币种,改头会让既有行口径漂移(同 Receipt.HeadFieldsFrozen 先例)。仅挂 update。
  """

  use Ash.Resource.Validation

  @fields [:party_type, :party_id]

  @impl true
  def validate(changeset, _opts, _context) do
    if head_changed?(changeset) and SynieCore.Purchase.Reconciliation.has_items?(changeset.data.id) do
      {:error, message: "请先删除对账条目"}
    else
      :ok
    end
  end

  defp head_changed?(changeset) do
    Enum.any?(@fields, fn field ->
      Ash.Changeset.get_attribute(changeset, field) != Map.get(changeset.data, field)
    end)
  end
end

defmodule SynieCore.Purchase.Reconciliation.DebitAccountRole do
  @moduledoc """
  借方科目必填,必须挂「未开票应付」角色(对冲入库时挂的未开票应付);
  另须本公司、启用、非汇总(同 Receipt.CreditAccountRole)。草稿保存即校验。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :debit_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      {:error, field: :debit_account_id, message: "借方科目不能为空"}
    else
      case SynieCore.Purchase.Receipt.CreditAccountRole.check_account(
             account_id,
             company_id,
             :unbilled_payable
           ) do
        :ok -> :ok
        {:error, message} -> {:error, field: :debit_account_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Purchase.Reconciliation.CreditAccountOk do
  @moduledoc """
  贷方科目必填,须本公司、启用、非汇总(角色不限):常规单=入库借方口径(存货/费用),
  赠送/样品单=收益类手选——两型同一校验口径(同 Receipt.DebitAccountOk)。草稿保存即校验。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :credit_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      {:error, field: :credit_account_id, message: "贷方科目不能为空"}
    else
      case SynieCore.Purchase.Receipt.DebitAccountOk.check_account(account_id, company_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: :credit_account_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Purchase.Reconciliation.FillDefaultAccounts do
  @moduledoc """
  建单按「公司默认过账科目」整组代入借贷科目(可改):对账单借方(未开票应付)←
  默认入库贷方,对账单贷方(入库借方口径)← 默认入库借方;无默认则留空,由必填校验兜底。
  仅挂 create;只填未显式给的槽位(手填优先)。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case company_id && SynieCore.Sales.CompanyAccountDefault.get_for_company(company_id) do
      nil ->
        changeset

      defaults ->
        changeset
        |> fill_if_blank(:debit_account_id, defaults.receipt_credit_account_id)
        |> fill_if_blank(:credit_account_id, defaults.receipt_debit_account_id)
    end
  end

  defp fill_if_blank(changeset, attribute, value) do
    if is_nil(Ash.Changeset.get_attribute(changeset, attribute)) and not is_nil(value) do
      Ash.Changeset.force_change_attribute(changeset, attribute, value)
    else
      changeset
    end
  end
end

defmodule SynieCore.Purchase.Reconciliation do
  @moduledoc """
  采购对账单(头),对应 `pur_reconciliation` 表。入库与收票之间的勾稽层:
  自身确认/结单不过往来重分类——常规单(draft→confirmed→closed)的
  「未开票应付→应付账款」迁移由发票审核关联触发(五笔分录,见 `SynieCore.Acc.VatInvoice`);
  赠送/样品单(draft→closed)审核即结单并过账 借未开票应付/贷收益类,
  已结单可作废(回滚分录组与已对账数量)。与销售对账逐点对称(借贷镜像)。

  草稿不占量;数量消耗发生在生效时点(常规单 confirm、赠送/样品单 audit),
  逐行校验剩余可对账量并累加入库条目 `reconciled_qty`,撤回/作废回滚。
  单号全局唯一,留空按 `purchase.reconciliation` 编号规则取号。行见 `ReconciliationItem`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "pur_reconciliation"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :party_type, "party_pair",
        check: "(party_type IS NULL) = (party_id IS NULL)",
        message: "对手类型与对手必须同时填写"
    end
  end

  graphql do
    type :pur_reconciliation
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

  def permission_prefix, do: "purchase.reconciliation"
  def permission_label, do: "采购对账单"
  def permission_actions, do: ~w(create read update delete confirm unconfirm audit void)

  def grid_actions do
    [
      %{
        key: "confirm",
        label: "供应商确认",
        scope: "row",
        mutation: "confirmPurReconciliation",
        is_danger: false
      },
      %{
        key: "unconfirm",
        label: "撤回确认",
        scope: "row",
        mutation: "unconfirmPurReconciliation",
        is_danger: true
      },
      %{
        key: "audit",
        label: "结单",
        scope: "row",
        mutation: "auditPurReconciliation",
        is_danger: false
      },
      %{
        key: "void",
        label: "作废",
        scope: "row",
        mutation: "voidPurReconciliation",
        is_danger: true
      }
    ]
  end

  def poly_refs do
    %{
      party_id: %{
        discriminator: :party_type,
        variants: Map.take(SynieCore.Acc.PartyType.party_resources(), [:supplier, :company])
      }
    }
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
        :reconciliation_no,
        :reconciliation_type,
        :party_type,
        :party_id,
        :debit_account_id,
        :credit_account_id,
        :remarks
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Purchase.ReconciliationPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      # 默认科目代入须先于必填校验(声明序即执行序,同 AutoNumber 须在构建期取号)
      change {SynieCore.Purchase.Reconciliation.FillDefaultAccounts, []}

      validate {SynieCore.Purchase.Reconciliation.DebitAccountRole, []}
      validate {SynieCore.Purchase.Reconciliation.CreditAccountOk, []}

      change {SynieCore.Numbering.AutoNumber, attribute: :reconciliation_no}

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
      accept [
        :reconciliation_no,
        :reconciliation_type,
        :party_type,
        :party_id,
        :debit_account_id,
        :credit_account_id,
        :remarks
      ]

      require_atomic? false

      validate {SynieCore.Purchase.ReconciliationDraft, []}
      validate {SynieCore.Purchase.ReconciliationTypeLocked, []}
      validate {SynieCore.Purchase.Reconciliation.HeadFieldsFrozen, []}
      validate {SynieCore.Purchase.ReconciliationPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}
      validate {SynieCore.Purchase.Reconciliation.DebitAccountRole, []}
      validate {SynieCore.Purchase.Reconciliation.CreditAccountOk, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_reconciliation(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿采购对账单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Purchase.ReconciliationDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_reconciliation(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿采购对账单可修改或删除")
          end
        end)
      end
    end

    # 供应商确认(仅常规单):生效时点,逐行校验剩余可对账量并累加已对账数量
    update :confirm do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        cond do
          changeset.data.reconciliation_type != :regular ->
            {:error, message: "仅常规对账单可供应商确认"}

          changeset.data.status != :draft ->
            {:error, message: "仅草稿采购对账单可供应商确认"}

          true ->
            :ok
        end
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "确认前必须至少填写一行对账条目"}
        end
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :confirmed)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_reconciliation(cs.data.id) do
            {:ok, %{status: :draft, reconciliation_type: :regular} = locked} ->
              case __MODULE__.consume!(cs, locked) do
                :ok -> cs
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿常规对账单可供应商确认")
          end
        end)
      end
    end

    # 撤回确认(仅常规单,未关联发票前):回滚已对账数量
    update :unconfirm do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        cond do
          changeset.data.reconciliation_type != :regular ->
            {:error, message: "仅常规对账单可撤回确认"}

          changeset.data.status != :confirmed ->
            {:error, message: "仅供应商已确认对账单可撤回确认"}

          __MODULE__.linked_invoice?(changeset.data.id) ->
            {:error, message: "已关联发票,不可撤回确认"}

          true ->
            :ok
        end
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :draft)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_reconciliation(cs.data.id) do
            {:ok, %{status: :confirmed, reconciliation_type: :regular} = locked} ->
              if __MODULE__.linked_invoice?(locked.id) do
                Ash.Changeset.add_error(cs, message: "已关联发票,不可撤回确认")
              else
                case __MODULE__.release!(cs, locked) do
                  :ok -> cs
                  {:error, message} -> Ash.Changeset.add_error(cs, message: message)
                end
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅供应商已确认常规对账单可撤回确认")
          end
        end)
      end
    end

    # 结单审核(仅赠送/样品单):审核即结单,消耗数量并过账 借未开票应付/贷收益类
    update :audit do
      accept [:posting_date]
      require_atomic? false

      validate fn changeset, _context ->
        cond do
          changeset.data.reconciliation_type != :gift_sample ->
            {:error, message: "仅赠送/样品对账单可结单审核(常规单由发票审核结单)"}

          changeset.data.status != :draft ->
            {:error, message: "仅草稿采购对账单可结单审核"}

          true ->
            :ok
        end
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "结单前必须至少填写一行对账条目"}
        end
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :closed)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_reconciliation(cs.data.id) do
            {:ok, %{status: :draft, reconciliation_type: :gift_sample} = locked} ->
              # 过账日期:有金额时必填;未传则默认结单当日(参照入库单先例)
              cs = ensure_posting_date(cs)

              with :ok <- __MODULE__.consume!(cs, locked),
                   :ok <- __MODULE__.post_gift_gl!(cs, locked) do
                cs
              else
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿赠送/样品对账单可结单审核")
          end
        end)
      end
    end

    # 作废(仅赠送/样品单已结单):回滚分录组与已对账数量;常规单已结单无独立作废入口
    update :void do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        cond do
          changeset.data.reconciliation_type != :gift_sample ->
            {:error, message: "常规对账单已结单不可作废,请从发票侧作废/红冲纠错"}

          changeset.data.status != :closed ->
            {:error, message: "仅已结单采购对账单可作废"}

          true ->
            :ok
        end
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_reconciliation(cs.data.id) do
            {:ok, %{status: :closed, reconciliation_type: :gift_sample} = locked} ->
              with :ok <- __MODULE__.cancel_gift_gl!(locked),
                   :ok <- __MODULE__.release!(cs, locked) do
                cs
              else
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅已结单赠送/样品对账单可作废")
          end
        end)
      end
    end

    # 内部动作:发票审核关联时把常规单翻为已结单(同事务,不注册 GraphQL)
    update :close_from_invoice do
      accept []
      require_atomic? false

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :closed)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_reconciliation(cs.data.id) do
            {:ok, %{status: :confirmed, reconciliation_type: :regular}} ->
              cs

            _ ->
              Ash.Changeset.add_error(cs, message: "对账单须为供应商已确认状态")
          end
        end)
      end
    end

    # 内部动作:发票作废/红冲时把常规单退回供应商已确认(同事务,不注册 GraphQL)
    update :reopen_from_invoice do
      accept []
      require_atomic? false

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :confirmed)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_reconciliation(cs.data.id) do
            {:ok, %{status: :closed, reconciliation_type: :regular}} ->
              cs

            _ ->
              Ash.Changeset.add_error(cs, message: "对账单须为已结单状态")
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :reconciliation_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "对账单号"
    end

    attribute :reconciliation_type, SynieCore.Purchase.ReconciliationType do
      allow_nil? false
      public? true
      description "对账类型(常规/赠送样品;保存后锁死)"
    end

    attribute :party_type, SynieCore.Acc.PartyType do
      allow_nil? false
      public? true
      description "对手类型(供应商/内部公司)"
    end

    attribute :party_id, :uuid do
      allow_nil? false
      public? true
      description "对手"
    end

    attribute :posting_date, :date do
      public? true
      description "过账日期(赠送/样品单结单总账;有金额结单时必填,默认结单当日)"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "备注"
    end

    attribute :status, SynieCore.Purchase.ReconciliationStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
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

    belongs_to :debit_account, SynieCore.Base.Account do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "借方科目(未开票应付;草稿必填)"
    end

    belongs_to :credit_account, SynieCore.Base.Account do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "贷方科目(常规单=入库借方口径;赠送/样品单=收益类;草稿必填)"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end

    has_many :items, SynieCore.Purchase.ReconciliationItem do
      destination_attribute :reconciliation_id
      sort idx: :asc
      public? true
      description "对账条目"
    end
  end

  aggregates do
    sum :gross_total, :items, :amount do
      public? true
      description "原币含税合计(行原币金额合计;单内同币种)"
    end

    sum :base_gross_total, :items, :base_amount do
      public? true
      description "本币含税合计(行本币金额合计;发票价税合计须与之相等)"
    end
  end

  identities do
    identity :unique_reconciliation_no, [:reconciliation_no], message: "对账单号已存在"
  end

  @doc false
  def lock_reconciliation(reconciliation_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^reconciliation_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  def has_items?(reconciliation_id) do
    SynieCore.Purchase.ReconciliationItem
    |> Ash.Query.filter(reconciliation_id == ^reconciliation_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  def load_items(reconciliation_id) do
    SynieCore.Purchase.ReconciliationItem
    |> Ash.Query.filter(reconciliation_id == ^reconciliation_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  @doc false
  # 任一发票仍引用本对账单时视为已关联(作废/红冲会自动解除关联),此时不可撤回确认
  def linked_invoice?(reconciliation_id) do
    SynieCore.Acc.VatInvoice
    |> Ash.Query.filter(pur_reconciliation_id == ^reconciliation_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  # 生效消耗:按入库条目分组,逐条 FOR UPDATE 锁行、复核剩余可对账量后累加
  def consume!(_changeset, reconciliation) do
    adjust_reconciled(load_items(reconciliation.id), :add)
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  @doc false
  # 回退(撤回确认/作废):按行回滚已对账数量
  def release!(_changeset, reconciliation) do
    adjust_reconciled(load_items(reconciliation.id), :sub)
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  @doc false
  # 赠送/样品单结单过账:借单头借方(未开票应付,往来须带对手)/贷单头贷方(收益类),
  # 金额=勾选条目价税合计(本币);为零跳过分录(同入库先例,但科目仍草稿必填)
  def post_gift_gl!(changeset, reconciliation) do
    gl_amount =
      reconciliation.id
      |> load_items()
      |> Enum.map(& &1.base_amount)
      |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
      |> Decimal.round(2)

    if Decimal.compare(gl_amount, 0) != :gt do
      :ok
    else
      posting =
        Ash.Changeset.get_attribute(changeset, :posting_date) || reconciliation.posting_date

      if is_nil(posting) do
        {:error, "有金额对账结单前必须填写过账日期"}
      else
        currencies =
          SynieCore.Base.Account
          |> Ash.Query.filter(
            id in ^[reconciliation.debit_account_id, reconciliation.credit_account_id]
          )
          |> Ash.read!(authorize?: false)
          |> Map.new(&{&1.id, &1.currency_id})

        zero = Decimal.new(0)

        entries = [
          %{
            account_id: reconciliation.debit_account_id,
            currency_id: currencies[reconciliation.debit_account_id],
            debit: gl_amount,
            credit: zero,
            party_type: reconciliation.party_type,
            party_id: reconciliation.party_id,
            remarks: nil
          },
          %{
            account_id: reconciliation.credit_account_id,
            currency_id: currencies[reconciliation.credit_account_id],
            debit: zero,
            credit: gl_amount,
            party_type: nil,
            party_id: nil,
            remarks: nil
          }
        ]

        case SynieCore.Acc.GL.validate_entries(reconciliation.company_id, entries) do
          :ok ->
            SynieCore.Acc.GL.post!(
              %{
                voucher_type: "purchase.reconciliation",
                voucher_id: reconciliation.id,
                voucher_no: reconciliation.reconciliation_no,
                company_id: reconciliation.company_id,
                posting_date: posting
              },
              entries
            )

            :ok

          {:error, message} ->
            {:error, message}
        end
      end
    end
  end

  @doc false
  def cancel_gift_gl!(reconciliation) do
    # 零金额结单无总账分录,cancel! 空集亦成功
    SynieCore.Acc.GL.cancel!("purchase.reconciliation", reconciliation.id)
    :ok
  end

  # 发票审核关联:把常规单翻为已结单(在发票审核事务内调用)
  @doc false
  def close_from_invoice!(reconciliation_id) do
    __MODULE__
    |> Ash.get!(reconciliation_id, authorize?: false)
    |> Ash.Changeset.for_update(:close_from_invoice, %{})
    |> Ash.update!(authorize?: false)

    :ok
  end

  # 发票作废/红冲:解除关联后把常规单退回供应商已确认(在发票动作事务内调用)
  @doc false
  def reopen_from_invoice!(reconciliation_id) do
    __MODULE__
    |> Ash.get!(reconciliation_id, authorize?: false)
    |> Ash.Changeset.for_update(:reopen_from_invoice, %{})
    |> Ash.update!(authorize?: false)

    :ok
  end

  defp ensure_posting_date(cs) do
    if Ash.Changeset.get_attribute(cs, :posting_date) do
      cs
    else
      Ash.Changeset.force_change_attribute(cs, :posting_date, Date.utc_today())
    end
  end

  defp adjust_reconciled(items, direction) do
    items
    |> Enum.group_by(& &1.receipt_item_id)
    |> Enum.reduce_while(:ok, fn {receipt_item_id, group}, :ok ->
      delta =
        group
        |> Enum.map(& &1.base_qty)
        |> Enum.reduce(Decimal.new(0), &Decimal.add/2)

      receipt_item =
        SynieCore.Purchase.ReceiptItem
        |> Ash.Query.filter(id == ^receipt_item_id)
        |> Ash.Query.lock("FOR UPDATE")
        |> Ash.read_one!(authorize?: false)

      with :ok <- check_remaining(receipt_item, group, delta, direction),
           :ok <- do_adjust(receipt_item, delta, direction) do
        {:cont, :ok}
      else
        {:error, message} -> {:halt, {:error, message}}
      end
    end)
  end

  # 生效方向才校验剩余:剩余可对账 = 入库 base − 已对账(回退方向只由非负约束兜底)
  defp check_remaining(receipt_item, group, delta, :add) do
    remaining = Decimal.sub(receipt_item.base_qty, receipt_item.reconciled_qty)

    if Decimal.compare(delta, remaining) == :gt do
      {:error,
       "第#{hd(group).idx}行:超出剩余可对账量(剩余#{Decimal.to_string(remaining)} < 本单#{Decimal.to_string(delta)})"}
    else
      :ok
    end
  end

  defp check_remaining(_receipt_item, _group, _delta, :sub), do: :ok

  defp do_adjust(receipt_item, delta, direction) do
    delta = if direction == :sub, do: Decimal.negate(delta), else: delta

    receipt_item
    |> Ash.Changeset.for_update(:adjust_reconciled_qty, %{delta: delta})
    |> Ash.update(authorize?: false)
    |> case do
      {:ok, _} -> :ok
      {:error, error} -> {:error, Exception.message(error)}
    end
  end
end
