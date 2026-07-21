defmodule SynieCore.Inv.WarehouseParent do
  @moduledoc "校验上级仓库:不能选自身,且上级必须是非叶子、同公司的仓库(叶子仓库不能挂子仓库)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    parent_id = Ash.Changeset.get_attribute(changeset, :parent_id)

    cond do
      is_nil(parent_id) ->
        :ok

      changeset.data.id && parent_id == changeset.data.id ->
        {:error, field: :parent_id, message: "上级仓库不能选择自身"}

      true ->
        check_parent(changeset, parent_id)
    end
  end

  # 与分类同权衡:两节点以上成环检测留跟进,本轮只堵 UI 可触发的误操作
  defp check_parent(changeset, parent_id) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case Ash.get(SynieCore.Inv.Warehouse, parent_id, authorize?: false) do
      {:ok, %{company_id: ^company_id, is_leaf: true}} ->
        {:error, field: :parent_id, message: "上级仓库是叶子仓库,不能挂子仓库"}

      {:ok, %{company_id: ^company_id}} ->
        :ok

      {:ok, _} ->
        {:error, field: :parent_id, message: "上级仓库不属于本公司"}

      {:error, _} ->
        {:error, field: :parent_id, message: "上级仓库不存在"}
    end
  end
end

defmodule SynieCore.Inv.WarehouseAccount do
  @moduledoc "校验关联科目:必须属于同一公司、非汇总、本币(指定了币种的科目不可关联)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :account_id) do
      nil -> :ok
      account_id -> check(changeset, account_id)
    end
  end

  defp check(changeset, account_id) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case Ash.get(SynieCore.Base.Account, account_id, authorize?: false) do
      {:ok, %{company_id: ^company_id} = account} ->
        cond do
          account.is_group ->
            {:error, field: :account_id, message: "汇总科目不能作为关联科目"}

          account.currency_id != nil ->
            {:error, field: :account_id, message: "外币科目不能作为关联科目"}

          true ->
            :ok
        end

      {:ok, _account} ->
        {:error, field: :account_id, message: "关联科目不属于本公司"}

      {:error, _} ->
        {:error, field: :account_id, message: "关联科目不存在"}
    end
  end
end

defmodule SynieCore.Inv.WarehouseUsable do
  @moduledoc """
  校验库存单据仓:必须存在、属于单据公司、叶子仓且启用。

  仓停用「拦新不拦旧」——新单据保存(create/update)与调拨发货(ship)时拦截,
  审核/作废/调拨收货不再校验(ADR 2026-07-19-stock-ledger)。

  默认读 changeset 的 warehouse_id/company_id 两属性(手工出入库单直接用);
  `attribute` 选项换成其他仓属性(调拨单三仓逐个校验,错误落在对应字段)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, opts, _context) do
    attribute = Keyword.get(opts, :attribute, :warehouse_id)
    warehouse_id = Ash.Changeset.get_attribute(changeset, attribute)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    # nil 由 allow_nil? false 兜底报必填
    if is_nil(warehouse_id) or is_nil(company_id) do
      :ok
    else
      case check(warehouse_id, company_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: attribute, message: message}
      end
    end
  end

  @doc """
  单仓可用性检查:存在、同公司、叶子且启用,返回 :ok | {:error, 消息}。
  调拨单发货在锁内逐仓复检(锁内无 changeset)也走此。
  """
  def check(warehouse_id, company_id) do
    case Ash.get(SynieCore.Inv.Warehouse, warehouse_id, authorize?: false) do
      {:ok, %{company_id: ^company_id, is_leaf: false}} ->
        {:error, "只有叶子仓库才能发生库存"}

      {:ok, %{company_id: ^company_id, active: false}} ->
        {:error, "仓库已停用"}

      {:ok, %{company_id: ^company_id}} ->
        :ok

      {:ok, _warehouse} ->
        {:error, "仓库不属于本公司"}

      {:error, _} ->
        {:error, "仓库不存在"}
    end
  end
end

defmodule SynieCore.Inv.Warehouse do
  @moduledoc """
  仓库,对应 `inv_warehouse` 表。

  公司下的仓库树(名称同公司内唯一,创建后不允许换公司)。`is_leaf` 为硬约束:
  叶子仓库不能挂子仓库,有下级的仓库不能改为叶子、不能删除;已有库存分录
  (含已作废)的仓禁删、不能改回非叶子(分录只挂叶子仓,见库存分录 ADR)。
  `is_outsourced` 为占位字段,暂无逻辑;`allow_negative` 在库存分录落地后生效
  (负库存校验逐仓跳过,见 `SynieCore.Inv.Stock`);`account` 为关联科目(选填)。
  注意与科目 `is_group` 语义相反。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    # 主 read 上的兜底排序(name 升序)是有意为之,树形每层取数依赖此序
    primary_read_warning?: false

  require Ash.Query

  postgres do
    table "inv_warehouse"
    repo SynieCore.Repo
  end

  graphql do
    type :inv_warehouse
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action_type([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 种子初始化本质是批量新增:复用 create 权限码,不设独立权限点(权限矩阵零噪音)
    policy action(:seed_defaults) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    # 公司维度 fail-closed;update/destroy 取数走 read,同样被此过滤兜住
    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "inv.warehouse"
  def permission_label, do: "仓库"
  def permission_actions, do: ~w(create read update delete)

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      # 兜底排序:未显式传 sort 时按名称升序,树形每层取数依赖此序
      prepare build(sort: [name: :asc])
    end

    create :create do
      accept [
        :name,
        :is_leaf,
        :active,
        :is_outsourced,
        :allow_negative,
        :company_id,
        :parent_id,
        :account_id
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Inv.WarehouseParent, []}
      validate {SynieCore.Inv.WarehouseAccount, []}
    end

    update :update do
      # 不接受 company_id:仓库不允许换公司(名称唯一性与未来库存都以公司为界)
      accept [:name, :is_leaf, :active, :is_outsourced, :allow_negative, :parent_id, :account_id]
      require_atomic? false

      validate {SynieCore.Inv.WarehouseParent, []}
      validate {SynieCore.Inv.WarehouseAccount, []}

      # 有下级仓库的不能改成叶子仓库
      validate fn changeset, _context ->
        if Ash.Changeset.changing_attribute?(changeset, :is_leaf) &&
             Ash.Changeset.get_attribute(changeset, :is_leaf) == true &&
             has_children?(changeset.data.id) do
          {:error, field: :is_leaf, message: "存在下级仓库,不能改为叶子仓库"}
        else
          :ok
        end
      end

      # 已有库存分录(含已作废)的仓不能改回非叶子:分录只挂叶子仓,改非叶子即历史引用语义悬空
      validate fn changeset, _context ->
        if Ash.Changeset.changing_attribute?(changeset, :is_leaf) &&
             Ash.Changeset.get_attribute(changeset, :is_leaf) == false &&
             has_stock_entries?(changeset.data.id) do
          {:error, field: :is_leaf, message: "仓库已有库存分录,不能改为非叶子"}
        else
          :ok
        end
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate fn changeset, _context ->
        if has_children?(changeset.data.id) do
          {:error, message: "存在下级仓库,不能删除"}
        else
          :ok
        end
      end

      # 存在库存分录(含已作废——作废分录仍是历史引用)的仓禁删
      validate fn changeset, _context ->
        if has_stock_entries?(changeset.data.id) do
          {:error, message: "仓库已有库存分录,不能删除"}
        else
          :ok
        end
      end
    end

    # 初始化公司默认仓库(所有仓库/默认仓库/在途),返回创建条数;已有仓库的公司幂等返回 0
    action :seed_defaults, :integer do
      transaction? true

      argument :company_id, :uuid, allow_nil?: false

      run SynieCore.Inv.WarehouseSeed
    end
  end

  defp has_children?(id) do
    __MODULE__
    |> Ash.Query.filter(parent_id == ^id)
    |> Ash.exists?(authorize?: false)
  end

  defp has_stock_entries?(id) do
    SynieCore.Inv.StockEntry
    |> Ash.Query.filter(warehouse_id == ^id)
    |> Ash.exists?(authorize?: false)
  end

  attributes do
    uuid_primary_key :id

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "仓库名称"
    end

    attribute :is_leaf, :boolean do
      allow_nil? false
      public? true
      default true
      description "叶子仓库"
    end

    attribute :active, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用"
    end

    attribute :is_outsourced, :boolean do
      allow_nil? false
      public? true
      default false
      description "委外仓(占位,暂无逻辑)"
    end

    attribute :allow_negative, :boolean do
      allow_nil? false
      public? true
      default false
      description "允许负库存(库存分录审核/作废的负库存校验逐仓跳过)"
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

    belongs_to :parent, __MODULE__ do
      public? true
      attribute_public? true
      attribute_writable? true
      description "上级仓库"
    end

    has_many :children, __MODULE__ do
      destination_attribute :parent_id
    end

    belongs_to :account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "关联科目"
    end
  end

  calculations do
    # 有无下级:前端树形懒加载据此显示展开箭头。用 exists 表达式,
    # 不用 count 聚合——自引用 has_many 的 count 聚合在本 ash_postgres 版本会走"load parent record"策略并报错
    calculate :has_children, :boolean, expr(exists(children, true)) do
      public? true
      description "有下级仓库"
    end
  end

  identities do
    identity :unique_name_per_company, [:company_id, :name], message: "仓库名称已存在"
  end
end
