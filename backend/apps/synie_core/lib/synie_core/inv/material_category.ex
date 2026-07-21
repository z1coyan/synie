defmodule SynieCore.Inv.MaterialCategoryParent do
  @moduledoc "校验上级分类:不能选自身,且上级必须是非叶子分类(叶子分类不能有子分类)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    parent_id = Ash.Changeset.get_attribute(changeset, :parent_id)

    cond do
      is_nil(parent_id) ->
        :ok

      changeset.data.id && parent_id == changeset.data.id ->
        {:error, field: :parent_id, message: "上级分类不能选择自身"}

      true ->
        check_parent_not_leaf(parent_id)
    end
  end

  # 与科目同权衡:两节点以上成环检测留跟进,本轮只堵 UI 可触发的误操作
  defp check_parent_not_leaf(parent_id) do
    case Ash.get(SynieCore.Inv.MaterialCategory, parent_id, authorize?: false) do
      {:ok, %{is_leaf: false}} -> :ok
      {:ok, _} -> {:error, field: :parent_id, message: "上级分类是叶子分类,不能挂子分类"}
      {:error, _} -> {:error, field: :parent_id, message: "上级分类不存在"}
    end
  end
end

defmodule SynieCore.Inv.MaterialCategory do
  @moduledoc """
  物料分类,对应 `inv_material_category` 表。

  全局共享的树形分类学(不分公司),编号人工定义、全局唯一,作为物料编号前缀
  (编号可改,已生成的物料编号不追溯)。`is_leaf` 为硬约束:叶子分类不能有子分类,
  物料只能挂叶子分类;下有物料的分类不能删除、不能改为非叶子。
  注意与科目 `is_group` 语义相反。
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
    table "inv_material_category"
    repo SynieCore.Repo
  end

  graphql do
    type :inv_material_category
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "inv.material_category"
  def permission_label, do: "物料分类"
  def permission_actions, do: ~w(create read update delete)

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      # 兜底排序:未显式传 sort 时按编号升序,树形每层取数依赖此序
      prepare build(sort: [code: :asc])
    end

    create :create do
      accept [:code, :name, :is_leaf, :active, :parent_id]

      validate {SynieCore.Inv.MaterialCategoryParent, []}
    end

    update :update do
      accept [:code, :name, :is_leaf, :active, :parent_id]
      require_atomic? false

      validate {SynieCore.Inv.MaterialCategoryParent, []}

      # 有子分类的不能改成叶子分类
      validate fn changeset, _context ->
        if Ash.Changeset.changing_attribute?(changeset, :is_leaf) &&
             Ash.Changeset.get_attribute(changeset, :is_leaf) == true &&
             has_children?(changeset.data.id) do
          {:error, field: :is_leaf, message: "存在下级分类,不能改为叶子分类"}
        else
          :ok
        end
      end

      # 挂着物料的叶子不能改成非叶子(物料只能挂叶子,改了编号语义也整个变掉)
      validate fn changeset, _context ->
        if Ash.Changeset.changing_attribute?(changeset, :is_leaf) &&
             Ash.Changeset.get_attribute(changeset, :is_leaf) == false &&
             has_materials?(changeset.data.id) do
          {:error, field: :is_leaf, message: "分类下存在物料,不能改为非叶子分类"}
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
          {:error, message: "存在下级分类,不能删除"}
        else
          :ok
        end
      end

      validate fn changeset, _context ->
        if has_materials?(changeset.data.id) do
          {:error, message: "分类下存在物料,不能删除"}
        else
          :ok
        end
      end
    end
  end

  defp has_children?(id) do
    __MODULE__
    |> Ash.Query.filter(parent_id == ^id)
    |> Ash.exists?(authorize?: false)
  end

  defp has_materials?(id) do
    SynieCore.Inv.Material
    |> Ash.Query.filter(category_id == ^id)
    |> Ash.exists?(authorize?: false)
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "分类编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "分类名称"
    end

    attribute :is_leaf, :boolean do
      allow_nil? false
      public? true
      default true
      description "叶子分类"
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
    belongs_to :parent, __MODULE__ do
      public? true
      attribute_public? true
      attribute_writable? true
      description "上级分类"
    end

    has_many :children, __MODULE__ do
      destination_attribute :parent_id
    end
  end

  calculations do
    # 有无下级:前端树形懒加载据此显示展开箭头。用 exists 表达式,
    # 不用 count 聚合——自引用 has_many 的 count 聚合在本 ash_postgres 版本会走"load parent record"策略并报错
    calculate :has_children, :boolean, expr(exists(children, true)) do
      public? true
      description "有下级分类"
    end
  end

  identities do
    identity :unique_code, [:code], message: "分类编号已存在"
  end
end
