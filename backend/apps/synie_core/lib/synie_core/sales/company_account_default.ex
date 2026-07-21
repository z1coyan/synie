defmodule SynieCore.Sales.CompanyAccountDefault.DeliveryDebitOk do
  @moduledoc "发货借方默认科目:若填则须未开票应收角色 + 本公司启用非汇总。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :delivery_debit_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      :ok
    else
      case SynieCore.Sales.Delivery.DebitAccountRole.check_account(
             account_id,
             company_id,
             :unbilled_receivable
           ) do
        :ok -> :ok
        {:error, message} -> {:error, field: :delivery_debit_account_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Sales.CompanyAccountDefault.DeliveryCreditOk do
  @moduledoc "发货贷方默认科目:若填则须本公司启用非汇总。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :delivery_credit_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      :ok
    else
      case SynieCore.Sales.Delivery.CreditAccountOk.check_account(account_id, company_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: :delivery_credit_account_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Sales.CompanyAccountDefault.ReceiptDebitOk do
  @moduledoc "入库借方默认科目:若填则须本公司启用非汇总。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :receipt_debit_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      :ok
    else
      case SynieCore.Purchase.Receipt.DebitAccountOk.check_account(account_id, company_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: :receipt_debit_account_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Sales.CompanyAccountDefault.ReceiptCreditOk do
  @moduledoc "入库贷方默认科目:若填则须未开票应付角色 + 本公司启用非汇总。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :receipt_credit_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      :ok
    else
      case SynieCore.Purchase.Receipt.CreditAccountRole.check_account(
             account_id,
             company_id,
             :unbilled_payable
           ) do
        :ok -> :ok
        {:error, message} -> {:error, field: :receipt_credit_account_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Sales.CompanyAccountDefault do
  @moduledoc """
  公司默认过账科目,对应 `sal_company_account_default` 表(一公司一行)。

  四槽均可空:发货借/贷、入库借/贷。供应链设置销/采 Tab 按公司维护;
  发货/入库新建或换公司时整组覆盖代入。权限复用 `sales.setting`(配置=update)。
  见 ADR 2026-07-21-company-default-posting-accounts。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sal_company_account_default"
    repo SynieCore.Repo
  end

  graphql do
    type :sal_company_account_default
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 配置写入复用 sales.setting:update;读复用 read;不新开权限点
    policy action(:read) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy action([:create, :update]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end

    policy action_type([:read, :update]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  # 复用供应链设置权限码,不进权限目录(actions 空)
  def permission_prefix, do: "sales.setting"
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
      accept [
        :company_id,
        :delivery_debit_account_id,
        :delivery_credit_account_id,
        :receipt_debit_account_id,
        :receipt_credit_account_id
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Sales.CompanyAccountDefault.DeliveryDebitOk, []}
      validate {SynieCore.Sales.CompanyAccountDefault.DeliveryCreditOk, []}
      validate {SynieCore.Sales.CompanyAccountDefault.ReceiptDebitOk, []}
      validate {SynieCore.Sales.CompanyAccountDefault.ReceiptCreditOk, []}
    end

    update :update do
      # 不接受 company_id:一行一公司,换公司等于另开一行
      accept [
        :delivery_debit_account_id,
        :delivery_credit_account_id,
        :receipt_debit_account_id,
        :receipt_credit_account_id
      ]

      require_atomic? false

      validate {SynieCore.Sales.CompanyAccountDefault.DeliveryDebitOk, []}
      validate {SynieCore.Sales.CompanyAccountDefault.DeliveryCreditOk, []}
      validate {SynieCore.Sales.CompanyAccountDefault.ReceiptDebitOk, []}
      validate {SynieCore.Sales.CompanyAccountDefault.ReceiptCreditOk, []}
    end
  end

  attributes do
    uuid_primary_key :id

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

    belongs_to :delivery_debit_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "销售发货默认借方科目(未开票应收)"
    end

    belongs_to :delivery_credit_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "销售发货默认贷方科目"
    end

    belongs_to :receipt_debit_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "采购入库默认借方科目"
    end

    belongs_to :receipt_credit_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "采购入库默认贷方科目(未开票应付)"
    end
  end

  identities do
    identity :unique_company, [:company_id], message: "该公司已有默认过账科目配置"
  end

  require Ash.Query

  @doc "取某公司默认过账科目(受信内部读;无则 nil)。"
  @spec get_for_company(Ash.UUID.t()) :: %__MODULE__{} | nil
  def get_for_company(company_id) when is_binary(company_id) do
    __MODULE__
    |> Ash.Query.filter(company_id == ^company_id)
    |> Ash.read_one!(authorize?: false)
  end
end
