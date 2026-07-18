defmodule SynieCore.Inv.MaterialCategoryIsLeaf do
  @moduledoc "校验物料所挂分类:必须存在且为叶子分类(物料只能挂叶子,见物料分类 ADR)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if Ash.Changeset.changing_attribute?(changeset, :category_id) do
      check_leaf(Ash.Changeset.get_attribute(changeset, :category_id))
    else
      :ok
    end
  end

  # nil 由 allow_nil? false 兜底报必填
  defp check_leaf(nil), do: :ok

  defp check_leaf(category_id) do
    case Ash.get(SynieCore.Inv.MaterialCategory, category_id, authorize?: false) do
      {:ok, %{is_leaf: true}} -> :ok
      {:ok, _} -> {:error, field: :category_id, message: "物料只能挂叶子分类"}
      {:error, _} -> {:error, field: :category_id, message: "物料分类不存在"}
    end
  end
end

defmodule SynieCore.Inv.MaterialDefaultUnitLocked do
  @moduledoc """
  有单位转换行时禁止改默认单位:转换系数全部以默认单位为基准(1 默认单位 = x 该单位),
  改基准即全表系数失效,强迫改动者先删转换行直面后果,不做静默保留或自动清空。
  """

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    if Ash.Changeset.changing_attribute?(changeset, :default_unit_id) &&
         has_units?(changeset.data.id) do
      {:error, field: :default_unit_id, message: "存在单位转换行,不能修改默认单位,请先删除转换行"}
    else
      :ok
    end
  end

  defp has_units?(material_id) do
    SynieCore.Inv.MaterialUnit
    |> Ash.Query.filter(material_id == ^material_id)
    |> Ash.exists?(authorize?: false)
  end
end

defmodule SynieCore.Inv.MaterialCustomerFields do
  @moduledoc """
  客户物料字段互斥与对方料号边界:

  - `is_customer_material=true` → `customer_id` 必填
  - `is_customer_material=false` → `customer_id` 与 `customer_part_no` 必空
  - 客户料允许空的 `customer_part_no`

  通用料关掉开关时由 `ClearCustomerWhenGeneral` change 清空 FK/对方料号,
  本校验兜底非法组合。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    is_cm = Ash.Changeset.get_attribute(changeset, :is_customer_material) == true
    customer_id = Ash.Changeset.get_attribute(changeset, :customer_id)
    part_no = Ash.Changeset.get_attribute(changeset, :customer_part_no)

    cond do
      is_cm and is_nil(customer_id) ->
        {:error, field: :customer_id, message: "客户物料必须选择客户"}

      not is_cm and not is_nil(customer_id) ->
        {:error, field: :customer_id, message: "非客户物料不能挂客户"}

      not is_cm and present?(part_no) ->
        {:error, field: :customer_part_no, message: "非客户物料不能填写客户方产品编号"}

      true ->
        :ok
    end
  end

  defp present?(s) when is_binary(s), do: String.trim(s) != ""
  defp present?(_), do: false
end

defmodule SynieCore.Inv.MaterialCustomerLocked do
  @moduledoc """
  有销侧引用时锁死客户约束字段:报价条目/订单条目任一引用(含已作废单据上的行)
  则不可改 `is_customer_material` / `customer_id`。无引用可改。
  仅挂 update。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if customer_fields_changing?(changeset) and
         SynieCore.Inv.Material.referenced?(changeset.data.id) do
      {:error, message: "物料已被报价或订单引用,不能修改客户约束"}
    else
      :ok
    end
  end

  defp customer_fields_changing?(changeset) do
    Enum.any?([:is_customer_material, :customer_id], fn field ->
      Ash.Changeset.get_attribute(changeset, field) != Map.get(changeset.data, field)
    end)
  end
end

defmodule SynieCore.Inv.Material.ClearCustomerWhenGeneral do
  @moduledoc """
  非客户物料时强制清空客户 FK 与对方料号,避免前端漏清留下非法态。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    if Ash.Changeset.get_attribute(changeset, :is_customer_material) == true do
      changeset
    else
      changeset
      |> Ash.Changeset.force_change_attribute(:customer_id, nil)
      |> Ash.Changeset.force_change_attribute(:customer_part_no, nil)
    end
  end
end

defmodule SynieCore.Inv.Material do
  @moduledoc """
  物料,对应 `inv_material` 表。全局主数据(不挂公司,与物料分类同理):
  库存/成本等公司维度将来由库存资源承载。

  编号留空按 `inv.material` 编号规则自动取号(AutoNumber,seed 规则为
  分类编号+客户编号(空则省略)+`-`+4 位序号),手填原样保留;改挂分类/客户编号不追溯。
  只能挂叶子分类。客户物料见 `is_customer_material`/`customer_id`(v1 一料一客);
  销侧单据只能用通用料或本客户料。图纸/其他文件走统一附件
  (owner_type `inv_material`,槽位 `drawing`/`default`),不占表字段。单位转换子表见 `MaterialUnit`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "inv_material"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :is_customer_material, "customer_material_pair",
        check: """
        (is_customer_material = false AND customer_id IS NULL) OR
        (is_customer_material = true AND customer_id IS NOT NULL)
        """,
        message: "客户物料必须挂客户,非客户物料不能挂客户"
    end
  end

  graphql do
    type :inv_material
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "inv.material"
  def permission_actions, do: ~w(create read update delete)

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
        :code,
        :name,
        :spec,
        :customer_part_no,
        :is_customer_material,
        :active,
        :category_id,
        :default_unit_id,
        :customer_id
      ]

      validate {SynieCore.Inv.MaterialCategoryIsLeaf, []}
      change {SynieCore.Inv.Material.ClearCustomerWhenGeneral, []}
      validate {SynieCore.Inv.MaterialCustomerFields, []}

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :code}
    end

    update :update do
      accept [
        :code,
        :name,
        :spec,
        :customer_part_no,
        :is_customer_material,
        :active,
        :category_id,
        :default_unit_id,
        :customer_id
      ]

      require_atomic? false

      validate {SynieCore.Inv.MaterialCategoryIsLeaf, []}
      validate {SynieCore.Inv.MaterialDefaultUnitLocked, []}
      validate {SynieCore.Inv.MaterialCustomerLocked, []}
      change {SynieCore.Inv.Material.ClearCustomerWhenGeneral, []}
      validate {SynieCore.Inv.MaterialCustomerFields, []}
    end

    destroy :destroy do
      # 转换子表行随物料级联删(DB reference on_delete: :delete);附件不级联,与全站一致
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "物料编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "物料名称"
    end

    attribute :spec, :string do
      public? true
      constraints max_length: 128
      description "物料规格"
    end

    attribute :customer_part_no, :string do
      public? true
      constraints max_length: 64
      description "客户方产品编号(仅客户物料可填)"
    end

    attribute :is_customer_material, :boolean do
      allow_nil? false
      public? true
      default false
      description "是否客户物料"
    end

    attribute :active, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :category, SynieCore.Inv.MaterialCategory do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "物料分类"
    end

    belongs_to :default_unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "默认单位"
    end

    belongs_to :customer, SynieCore.Sales.Customer do
      allow_nil? true
      public? true
      attribute_public? true
      attribute_writable? true
      description "所属客户(仅客户物料)"
    end

    has_many :units, SynieCore.Inv.MaterialUnit do
      destination_attribute :material_id
    end
  end

  identities do
    identity :unique_code, [:code], message: "物料编号已存在"
  end

  @doc "是否被报价条目或订单条目引用(含已作废单据上的行)。"
  def referenced?(nil), do: false

  def referenced?(material_id) do
    order_hit? =
      SynieCore.Sales.OrderItem
      |> Ash.Query.filter(material_id == ^material_id)
      |> Ash.exists?(authorize?: false)

    quotation_hit? =
      SynieCore.Sales.QuotationItem
      |> Ash.Query.filter(material_id == ^material_id)
      |> Ash.exists?(authorize?: false)

    order_hit? or quotation_hit?
  end
end
