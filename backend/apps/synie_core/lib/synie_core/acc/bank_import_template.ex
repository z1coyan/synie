defmodule SynieCore.Acc.BankImportTemplate.NormalizeColumns do
  @moduledoc "列号归一:trim + 大写(用户填 aa/d 也能落成 AA/D)。"

  use Ash.Resource.Change

  @col_fields ~w(datetime_col date_col time_col income_col expense_col amount_col
                 balance_col counterparty_name_col counterparty_account_col summary_col note_col)a

  def col_fields, do: @col_fields

  @impl true
  def change(changeset, _opts, _context) do
    Enum.reduce(@col_fields, changeset, fn field, cs ->
      case Ash.Changeset.fetch_change(cs, field) do
        {:ok, value} when is_binary(value) ->
          Ash.Changeset.force_change_attribute(cs, field, value |> String.trim() |> String.upcase())

        _ ->
          cs
      end
    end)
  end
end

defmodule SynieCore.Acc.BankImportTemplate.ColumnFormat do
  @moduledoc "校验列号为 1-2 位字母(A-Z、AA-ZZ,兼容超 26 列的导出)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    SynieCore.Acc.BankImportTemplate.NormalizeColumns.col_fields()
    |> Enum.find_value(:ok, fn field ->
      case Ash.Changeset.get_attribute(changeset, field) do
        nil -> nil
        value -> if value =~ ~r/^[A-Z]{1,2}$/, do: nil, else: error(field)
      end
    end)
  end

  defp error(field), do: {:error, field: field, message: "列号须为 1-2 位字母(如 D、AA)"}
end

defmodule SynieCore.Acc.BankImportTemplate.TimeColumns do
  @moduledoc """
  时间配置二选一:单列模式(日期时间列+格式)或双列模式(日期列+格式,时间列可省、
  缺省 00:00:00);混填、缺格式、格式无列均拒绝。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    get = &Ash.Changeset.get_attribute(changeset, &1)

    single = {get.(:datetime_col), get.(:datetime_format)}
    double = {get.(:date_col), get.(:date_format), get.(:time_col), get.(:time_format)}

    case {single, double} do
      {{nil, nil}, {nil, nil, nil, nil}} ->
        {:error, field: :datetime_col, message: "必须配置日期时间列或日期列"}

      {{col, fmt}, {nil, nil, nil, nil}} when col != nil or fmt != nil ->
        cond do
          is_nil(col) -> {:error, field: :datetime_col, message: "填了日期时间格式但缺日期时间列"}
          is_nil(fmt) -> {:error, field: :datetime_format, message: "日期时间列必须选择格式"}
          true -> :ok
        end

      {{nil, nil}, {col, fmt, tcol, tfmt}} ->
        cond do
          is_nil(col) -> {:error, field: :date_col, message: "填了日期格式/时间列但缺日期列"}
          is_nil(fmt) -> {:error, field: :date_format, message: "日期列必须选择格式"}
          not is_nil(tcol) and is_nil(tfmt) -> {:error, field: :time_format, message: "时间列必须选择格式"}
          is_nil(tcol) and not is_nil(tfmt) -> {:error, field: :time_col, message: "填了时间格式但缺时间列"}
          true -> :ok
        end

      _ ->
        {:error, field: :datetime_col, message: "时间配置二选一:日期时间单列与日期/时间双列不可混填"}
    end
  end
end

defmodule SynieCore.Acc.BankImportTemplate.AmountColumns do
  @moduledoc """
  金额配置二选一:收入/支出双列(至少一列)或带符号单金额列(正=收入、负=支出,
  导入按符号拆列);两模式互斥。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    amount = Ash.Changeset.get_attribute(changeset, :amount_col)
    income = Ash.Changeset.get_attribute(changeset, :income_col)
    expense = Ash.Changeset.get_attribute(changeset, :expense_col)

    cond do
      not is_nil(amount) and (not is_nil(income) or not is_nil(expense)) ->
        {:error, field: :amount_col, message: "带符号金额列与收入/支出列不可同时配置"}

      is_nil(amount) and is_nil(income) and is_nil(expense) ->
        {:error, field: :income_col, message: "必须配置收入/支出列或带符号金额列"}

      true ->
        :ok
    end
  end
end

defmodule SynieCore.Acc.BankImportTemplate do
  @moduledoc """
  银行流水导入模板,对应 `acc_bank_import_template` 表。

  描述某银行导出 xls/xlsx 的列布局:各字段落在哪一列(A-Z 列号)、日期时间格式、
  数据起始行。绑定银行账户,一个账户可建多个模板(不同导出渠道格式不同)。
  导入执行另轮实现,本资源只管模板管理。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  alias SynieCore.Acc.BankImportTemplate.{
    AmountColumns,
    ColumnFormat,
    DateFormat,
    DatetimeFormat,
    NormalizeColumns,
    TimeColumns,
    TimeFormat
  }

  postgres do
    table "acc_bank_import_template"
    repo SynieCore.Repo
  end

  graphql do
    type :acc_bank_import_template
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 公司维度 fail-closed;update/destroy 取数走 read,同样被此过滤兜住
    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "acc.bank_import_template"
  def permission_actions, do: ~w(create read update delete)

  # 默认反射也会取到 name,显式声明防字段顺序变动
  def display_field, do: :name

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
        :name,
        :start_row,
        :datetime_col,
        :datetime_format,
        :date_col,
        :date_format,
        :time_col,
        :time_format,
        :income_col,
        :expense_col,
        :amount_col,
        :balance_col,
        :counterparty_name_col,
        :counterparty_account_col,
        :summary_col,
        :note_col,
        :company_id,
        :bank_account_id
      ]

      change {NormalizeColumns, []}

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Acc.OwnBankAccount, []}
      validate {ColumnFormat, []}
      validate {TimeColumns, []}
      validate {AmountColumns, []}
    end

    update :update do
      # 不接受 company_id:模板不允许换公司(名称唯一性与数据权限都以公司为界)
      accept [
        :name,
        :start_row,
        :datetime_col,
        :datetime_format,
        :date_col,
        :date_format,
        :time_col,
        :time_format,
        :income_col,
        :expense_col,
        :amount_col,
        :balance_col,
        :counterparty_name_col,
        :counterparty_account_col,
        :summary_col,
        :note_col,
        :bank_account_id
      ]

      require_atomic? false

      change {NormalizeColumns, []}

      validate {SynieCore.Acc.OwnBankAccount, []}
      validate {ColumnFormat, []}
      validate {TimeColumns, []}
      validate {AmountColumns, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "模板名称"
    end

    attribute :start_row, :integer do
      allow_nil? false
      public? true
      default 2
      constraints min: 1
      description "起始行"
    end

    attribute :datetime_col, :string do
      public? true
      description "日期时间列"
    end

    attribute :datetime_format, DatetimeFormat do
      public? true
      description "日期时间格式"
    end

    attribute :date_col, :string do
      public? true
      description "日期列"
    end

    attribute :date_format, DateFormat do
      public? true
      description "日期格式"
    end

    attribute :time_col, :string do
      public? true
      description "时间列"
    end

    attribute :time_format, TimeFormat do
      public? true
      description "时间格式"
    end

    attribute :income_col, :string do
      public? true
      description "收入金额列"
    end

    attribute :expense_col, :string do
      public? true
      description "支出金额列"
    end

    attribute :amount_col, :string do
      public? true
      description "金额列(带符号)"
    end

    attribute :balance_col, :string do
      public? true
      description "余额列"
    end

    attribute :counterparty_name_col, :string do
      public? true
      description "对方户名列"
    end

    attribute :counterparty_account_col, :string do
      public? true
      description "对方账号列"
    end

    attribute :summary_col, :string do
      public? true
      description "摘要列"
    end

    attribute :note_col, :string do
      public? true
      description "备注列"
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
  end

  identities do
    identity :unique_name_per_company, [:company_id, :name]
  end
end
