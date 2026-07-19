defmodule SynieCore.Inv.StockDocItem.SyncDoc do
  @moduledoc """
  行与母单同步:手工出入库单必须存在且草稿态(增删改行的前提);
  create 时把单据 company_id 冗余到行(数据权限按公司过滤依赖此列)。

  构建期预检仅为友好报错(此时在动作事务之外,加锁不生效,故用普通读);
  权威复检在 before_action 钩子内进行:before_action 在动作事务内执行,FOR UPDATE
  持锁到事务提交,借此串行化行编辑与审核/作废,关闭构建期预检看到 stale 状态的竞态窗口。
  (同 OrderItem.SyncOrder 先例)
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    doc_id = changeset_doc_id(changeset)

    changeset =
      case read_doc(doc_id) do
        {:ok, %{status: :draft} = doc} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, doc.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :stock_doc_id, message: "手工出入库单不存在")

        {:ok, _doc} ->
          Ash.Changeset.add_error(changeset,
            field: :stock_doc_id,
            message: "仅草稿手工出入库单可编辑单据行"
          )

        _ ->
          Ash.Changeset.add_error(changeset, field: :stock_doc_id, message: "手工出入库单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_doc(changeset_doc_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :stock_doc_id, message: "手工出入库单不存在")

        _ ->
          Ash.Changeset.add_error(cs,
            field: :stock_doc_id,
            message: "仅草稿手工出入库单可编辑单据行"
          )
      end
    end)
  end

  defp changeset_doc_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :stock_doc_id) || changeset.data.stock_doc_id

  defp read_doc(nil), do: {:ok, nil}

  defp read_doc(doc_id) do
    SynieCore.Inv.StockDoc
    |> Ash.Query.filter(id == ^doc_id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_doc(nil), do: {:ok, nil}

  defp lock_doc(doc_id) do
    SynieCore.Inv.StockDoc
    |> Ash.Query.filter(id == ^doc_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Inv.StockDocItem do
  @moduledoc """
  手工出入库单单据行,对应 `inv_stock_doc_item` 表。

  `company_id` 冗余自母单以复用公司数据权限;折算数量 `base_qty` 按物料默认单位
  系统算、6 位小数、不可手改(见 `StockItemBaseQty`);行单位限物料默认单位或其
  转换单位(见 `StockItemUnitAllowed`);仅母单草稿态可增删改(见 `SyncDoc`)。
  物料编号/名称/规格与单位名称是快照物理列:行保存即重拍(见 `StockItemSnapshot`),
  审核锁行即冻结,主数据后续变更不回溯。
  无独立权限点:permission_actions 为空(不进权限目录),动作复用 `inv.stock_doc` 权限码。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    # 主 read 上的兜底排序(idx 升序)是有意为之,行按录入顺序展示依赖此序
    primary_read_warning?: false

  postgres do
    table "inv_stock_doc_item"
    repo SynieCore.Repo

    references do
      # 删草稿手工出入库单 DB 级联删行(行不留单独审计,单据删除本身已审计)
      reference :stock_doc, on_delete: :delete
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"
    end
  end

  graphql do
    type :inv_stock_doc_item
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

  # 复用手工出入库单权限码;actions 为空不进权限目录(同 OrderItem 跟随 sales.order 的先例)
  def permission_prefix, do: "inv.stock_doc"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      # 行按录入顺序展示:仅在请求未指定排序时兜底 idx 升序
      prepare fn query, _context ->
        if Enum.empty?(query.sort) do
          Ash.Query.sort(query, idx: :asc)
        else
          query
        end
      end
    end

    create :create do
      accept [:stock_doc_id, :idx, :material_id, :unit_id, :qty, :remark]

      # 顺序敏感:先回填 company_id,再做公司授权校验
      change {SynieCore.Inv.StockDocItem.SyncDoc, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
    end

    update :update do
      accept [:idx, :material_id, :unit_id, :qty, :remark]
      require_atomic? false

      change {SynieCore.Inv.StockDocItem.SyncDoc, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Inv.StockDocItem.SyncDoc, []}
    end
  end

  validations do
    validate compare(:qty, greater_than: 0), message: "数量必须大于零"
  end

  attributes do
    uuid_primary_key :id

    attribute :idx, :integer do
      allow_nil? false
      public? true
      description "行号"
    end

    attribute :qty, :decimal do
      allow_nil? false
      public? true
      description "录入数量"
    end

    # 折算数量(物料默认单位口径):系统算不可手改,只能由 StockItemBaseQty 写入
    attribute :base_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "折算数量(系统算:物料默认单位口径,6 位小数)"
    end

    # 物料信息快照:行保存时按当前物料/单位重拍(StockItemSnapshot),
    # writable? false 照 OrderItem 先例只能由 change 写入;spec 可空(物料本身可空)
    attribute :material_code, :string do
      allow_nil? false
      writable? false
      public? true
      description "物料编号"
    end

    attribute :material_name, :string do
      allow_nil? false
      writable? false
      public? true
      description "物料名称"
    end

    attribute :material_spec, :string do
      writable? false
      public? true
      description "规格"
    end

    attribute :unit_name, :string do
      allow_nil? false
      writable? false
      public? true
      description "单位名称"
    end

    attribute :remark, :string do
      public? true
      constraints max_length: 512
      description "行备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :stock_doc, SynieCore.Inv.StockDoc do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "手工出入库单"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :material, SynieCore.Inv.Material do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "物料"
    end

    belongs_to :unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "单位"
    end
  end
end
