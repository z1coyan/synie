defmodule SynieCore.Base.AccountDirection do
  @moduledoc "科目余额方向:借/贷。"

  use Ash.Type.Enum, values: [debit: "借", credit: "贷"]

  def graphql_type(_), do: :account_direction
end

defmodule SynieCore.Base.AccountRole do
  @moduledoc """
  科目角色:标记科目在应收应付口径下的用途,应收应付报表按角色圈定科目范围。
  决策见 docs/adr/2026-07-16-ar-ap-report.md;同公司多科目可挂同一角色,报表合并。
  """

  use Ash.Type.Enum,
    values: [
      unbilled_receivable: "未开票应收",
      receivable: "应收账款",
      advance_received: "预收账款",
      unbilled_payable: "未开票应付",
      payable: "应付账款",
      advance_paid: "预付账款"
    ]

  def graphql_type(_), do: :bas_account_role

  @doc "应收侧三角色(顺序即报表列序)"
  def receivable_roles, do: [:unbilled_receivable, :receivable, :advance_received]

  @doc "应付侧三角色(顺序即报表列序)"
  def payable_roles, do: [:unbilled_payable, :payable, :advance_paid]

  @doc "角色自然方向:debit 角色余额=借−贷,credit 角色余额=贷−借"
  def natural_direction(role) when role in [:unbilled_receivable, :receivable, :advance_paid],
    do: :debit

  def natural_direction(role) when role in [:unbilled_payable, :payable, :advance_received],
    do: :credit
end

defmodule SynieCore.Base.AccountRoleGuard do
  @moduledoc """
  校验科目角色挂载条件:只允许叶子(非汇总)科目——分录只能记叶子,圈叶子即完备;
  外币科目不可挂——报表不做折算(均见 docs/adr/2026-07-16-ar-ap-report.md)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    cond do
      is_nil(Ash.Changeset.get_attribute(changeset, :role)) ->
        :ok

      Ash.Changeset.get_attribute(changeset, :is_group) ->
        {:error, field: :role, message: "汇总科目不能设置科目角色"}

      true ->
        check_currency(changeset)
    end
  end

  # currency 为空视作本位币;非空时仅人民币科目可挂角色
  defp check_currency(changeset) do
    case Ash.Changeset.get_attribute(changeset, :currency_id) do
      nil ->
        :ok

      currency_id ->
        case Ash.get(SynieCore.Base.Currency, currency_id, authorize?: false) do
          {:ok, %{iso_code: "CNY"}} -> :ok
          {:ok, _} -> {:error, field: :role, message: "外币科目不能设置科目角色(报表不做折算)"}
          {:error, _} -> {:error, field: :currency_id, message: "币种不存在"}
        end
    end
  end
end

defmodule SynieCore.Base.AccountTemplateKey do
  @moduledoc "科目表初始化模板,与 `SynieCore.Base.AccountTemplates.entries/1` 的参数一致。"

  use Ash.Type.Enum,
    values: [cas: "企业会计准则", small: "小企业会计准则", intl: "国际通用(精简)"]

  def graphql_type(_), do: :bas_account_template
end

defmodule SynieCore.Base.AccountParent do
  @moduledoc "校验上级科目:不能选自身,且必须属于同一公司(跨公司挂父节点会破坏公司内的树)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    parent_id = Ash.Changeset.get_attribute(changeset, :parent_id)

    cond do
      is_nil(parent_id) ->
        :ok

      changeset.data.id && parent_id == changeset.data.id ->
        {:error, field: :parent_id, message: "上级科目不能选择自身"}

      true ->
        check_same_company(changeset, parent_id)
    end
  end

  # 与 Company 同权衡:两节点以上成环检测留跟进,本轮只堵 UI 可触发的误操作
  defp check_same_company(changeset, parent_id) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case Ash.get(SynieCore.Base.Account, parent_id, authorize?: false) do
      {:ok, %{company_id: ^company_id}} -> :ok
      {:ok, _} -> {:error, field: :parent_id, message: "上级科目必须属于同一公司"}
      {:error, _} -> {:error, field: :parent_id, message: "上级科目不存在"}
    end
  end
end

defmodule SynieCore.Base.Account do
  @moduledoc """
  会计科目,对应 `bas_account` 表。

  科目直接挂公司(ERPNext 式):每个公司一棵科目树,编码同公司内唯一。
  会计要素本身也是科目(根节点,parent 为空),由初始化模板决定要素个数
  (企业会计准则 6 类/小企业会计准则与国际 5 类),不在代码里写死类别枚举。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    # 主 read 上的兜底排序(code 升序)是有意为之,树形每层取数依赖此序
    primary_read_warning?: false

  require Ash.Query

  postgres do
    table "bas_account"
    repo SynieCore.Repo
  end

  graphql do
    type :bas_account
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action_type([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 模板初始化本质是批量新增:复用 create 权限码,不设独立权限点(权限矩阵零噪音)
    policy action(:init_from_template) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    # 公司维度 fail-closed;update/destroy 取数走 read,同样被此过滤兜住
    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "base.account"
  def permission_actions, do: ~w(create read update delete)

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      # 兜底排序:未显式传 sort 时按编码升序,树形每层取数依赖此序
      prepare build(sort: [code: :asc])
    end

    create :create do
      accept [
        :code,
        :name,
        :direction,
        :is_group,
        :active,
        :role,
        :parent_id,
        :company_id,
        :currency_id
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Base.AccountParent, []}
      validate {SynieCore.Base.AccountRoleGuard, []}
    end

    update :update do
      # 不接受 company_id:科目不允许换公司(树与编码唯一性都以公司为界)
      accept [:code, :name, :direction, :is_group, :active, :role, :parent_id, :currency_id]
      require_atomic? false

      validate {SynieCore.Base.AccountParent, []}
      validate {SynieCore.Base.AccountRoleGuard, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate fn changeset, _context ->
        exists? =
          __MODULE__
          |> Ash.Query.filter(parent_id == ^changeset.data.id)
          |> Ash.exists?(authorize?: false)

        if exists? do
          {:error, message: "存在下级科目,不能删除"}
        else
          :ok
        end
      end
    end

    # 从模板整套初始化公司科目表,返回创建条数;目标公司必须尚无科目
    action :init_from_template, :integer do
      transaction? true

      argument :company_id, :uuid, allow_nil?: false
      argument :template, SynieCore.Base.AccountTemplateKey, allow_nil?: false

      run SynieCore.Base.AccountInit
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "科目编码"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "科目名称"
    end

    attribute :direction, SynieCore.Base.AccountDirection do
      allow_nil? false
      public? true
      description "余额方向"
    end

    attribute :is_group, :boolean do
      allow_nil? false
      public? true
      default false
      description "汇总科目"
    end

    attribute :active, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用"
    end

    attribute :role, SynieCore.Base.AccountRole do
      public? true
      description "科目角色"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :parent, __MODULE__ do
      public? true
      attribute_public? true
      attribute_writable? true
      description "上级科目"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :currency, SynieCore.Base.Currency do
      public? true
      attribute_public? true
      attribute_writable? true
      description "币种"
    end

    has_many :children, __MODULE__ do
      destination_attribute :parent_id
    end
  end

  calculations do
    # 有无下级:前端树形懒加载据此显示展开箭头。用 exists 表达式(编译为 SQL EXISTS 子查询,可内联),
    # 不用 count 聚合——自引用 has_many 的 count 聚合在本 ash_postgres 版本会走"load parent record"策略并报错
    calculate :has_children, :boolean, expr(exists(children, true)) do
      public? true
      description "有下级科目"
    end
  end

  identities do
    identity :unique_code_per_company, [:company_id, :code]
  end
end
