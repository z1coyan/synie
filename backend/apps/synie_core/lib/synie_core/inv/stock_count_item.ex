defmodule SynieCore.Inv.StockCountItem.SyncCount do
  @moduledoc """
  行与母单同步:库存盘点单必须存在且草稿态(增删改行的前提);
  create 时把单据 company_id 冗余到行(数据权限按公司过滤依赖此列)。

  构建期预检仅为友好报错(此时在动作事务之外,加锁不生效,故用普通读);
  权威复检在 before_action 钩子内进行:before_action 在动作事务内执行,FOR UPDATE
  持锁到事务提交,借此串行化行编辑与审核/作废/刷新,关闭构建期预检看到 stale 状态的竞态窗口。
  (同 StockDocItem.SyncDoc 先例)
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    count_id = changeset_count_id(changeset)

    changeset =
      case read_count(count_id) do
        {:ok, %{status: :draft} = count} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, count.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :count_id, message: "库存盘点单不存在")

        {:ok, _count} ->
          Ash.Changeset.add_error(changeset,
            field: :count_id,
            message: "仅草稿库存盘点单可编辑盘点行"
          )

        _ ->
          Ash.Changeset.add_error(changeset, field: :count_id, message: "库存盘点单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_count(changeset_count_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :count_id, message: "库存盘点单不存在")

        _ ->
          Ash.Changeset.add_error(cs,
            field: :count_id,
            message: "仅草稿库存盘点单可编辑盘点行"
          )
      end
    end)
  end

  defp changeset_count_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :count_id) || changeset.data.count_id

  defp read_count(nil), do: {:ok, nil}

  defp read_count(count_id) do
    SynieCore.Inv.StockCount
    |> Ash.Query.filter(id == ^count_id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_count(nil), do: {:ok, nil}

  defp lock_count(count_id) do
    SynieCore.Inv.StockCount
    |> Ash.Query.filter(id == ^count_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Inv.StockCountItem.ConvertedCounted do
  @moduledoc """
  实盘折算数量系统算(库存分录只认物料默认单位),`converted_counted` 不允许手改
  (属性 writable? false 兜底):单位即物料默认单位时 converted_counted = counted_quantity;
  否则 converted_counted = counted_quantity ÷ 该物料转换行换算系数
  (1 默认单位 = factor 该单位),Decimal.round 6 位。

  与 StockItemBaseQty 的差别:实盘数量审核前可空——counted_quantity 未填时
  converted_counted 同步置空,审核时由单据侧「逐行已填」校验兜底报错。
  在 before_action 内取数——此时 SyncCount 的 FOR UPDATE 已锁住母单
  (changes 声明序在其后,钩子同序执行)。物料/单位读不到时跳过,
  由 StockItemUnitAllowed 与必填校验兜底报错;转换行缺失按同文案报错。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      material_id = Ash.Changeset.get_attribute(cs, :material_id)
      unit_id = Ash.Changeset.get_attribute(cs, :unit_id)
      counted = Ash.Changeset.get_attribute(cs, :counted_quantity)

      cond do
        is_nil(material_id) or is_nil(unit_id) ->
          cs

        is_nil(counted) ->
          Ash.Changeset.force_change_attribute(cs, :converted_counted, nil)

        true ->
          case get_material(material_id) do
            {:ok, material} ->
              if material.default_unit_id == unit_id do
                Ash.Changeset.force_change_attribute(cs, :converted_counted, counted)
              else
                case conversion_factor(material_id, unit_id) do
                  nil ->
                    Ash.Changeset.add_error(cs,
                      field: :unit_id,
                      message: "单位必须是物料默认单位或其单位转换单位"
                    )

                  factor ->
                    converted = counted |> Decimal.div(factor) |> Decimal.round(6)
                    Ash.Changeset.force_change_attribute(cs, :converted_counted, converted)
                end
              end

            :error ->
              cs
          end
      end
    end)
  end

  defp get_material(material_id) do
    case Ash.get(SynieCore.Inv.Material, material_id, authorize?: false) do
      {:ok, material} -> {:ok, material}
      _ -> :error
    end
  end

  defp conversion_factor(material_id, unit_id) do
    SynieCore.Inv.MaterialUnit
    |> Ash.Query.filter(material_id == ^material_id and unit_id == ^unit_id)
    |> Ash.read_one!(authorize?: false)
    |> case do
      nil -> nil
      conversion -> conversion.factor
    end
  end
end

defmodule SynieCore.Inv.StockCountItem.BookQty do
  @moduledoc """
  账面数量快照系统取数(不允许手改,属性 writable? false 兜底):
  行创建、或行修改换了物料时,按母单仓库当前账面余额(未作废分录合计,
  物料默认单位口径,6 位小数)落行——「取数时刻快照」是定案语义,之后不随
  世界变化,整单重取走单据的 refresh 动作(刷新不动已填实盘数)。
  只改实盘数/单位/备注的保存不重取。

  在 before_action 内取数——此时 SyncCount 的 FOR UPDATE 已锁住母单
  (changes 声明序在其后,钩子同序执行)。母单/物料读不到时跳过,
  由 StockItemUnitAllowed 与 SyncCount 兜底报错。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      if cs.action_type == :create or Ash.Changeset.changing_attribute?(cs, :material_id) do
        take_book_quantity(cs)
      else
        cs
      end
    end)
  end

  defp take_book_quantity(cs) do
    count_id = Ash.Changeset.get_attribute(cs, :count_id) || cs.data.count_id
    material_id = Ash.Changeset.get_attribute(cs, :material_id)

    with false <- is_nil(count_id) or is_nil(material_id),
         {:ok, count} <- Ash.get(SynieCore.Inv.StockCount, count_id, authorize?: false) do
      book_quantity = SynieCore.Inv.StockCount.book_quantity(count.warehouse_id, material_id)
      Ash.Changeset.force_change_attribute(cs, :book_quantity, book_quantity)
    else
      _ -> cs
    end
  end
end

defmodule SynieCore.Inv.StockCountItem do
  @moduledoc """
  库存盘点单盘点行,对应 `inv_stock_count_item` 表。

  `company_id` 冗余自母单以复用公司数据权限;实盘数量 `counted_quantity` 按
  录入单位口径、审核前可空、≥0(审核要求逐行已填,空行整单拒);折算实盘
  `converted_counted` 按物料默认单位系统算、6 位小数、不可手改(见
  `ConvertedCounted`);账面数量 `book_quantity` 为取数时刻余额快照(默认单位
  口径,系统取数,见 `BookQty`);行单位限物料默认单位或其转换单位(见
  `StockItemUnitAllowed`);仅母单草稿态可增删改(见 `SyncCount`)。
  物料编号/名称/规格与单位名称是快照物理列:行保存即重拍(见 `StockItemSnapshot`),
  审核锁行即冻结,主数据后续变更不回溯。
  无独立权限点:permission_actions 为空(不进权限目录),动作复用 `inv.stock_count` 权限码。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "inv_stock_count_item"
    repo SynieCore.Repo

    references do
      # 删草稿库存盘点单 DB 级联删行(行不留单独审计,单据删除本身已审计)
      reference :count, on_delete: :delete
    end

    check_constraints do
      check_constraint :counted_quantity, "counted_quantity_nonnegative",
        check: "counted_quantity >= 0",
        message: "实盘数量不能为负"
    end
  end

  graphql do
    type :inv_stock_count_item
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

  # 复用库存盘点单权限码;actions 为空不进权限目录(同 StockDocItem 跟随 inv.stock_doc 的先例)
  def permission_prefix, do: "inv.stock_count"
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
      accept [:count_id, :material_id, :unit_id, :counted_quantity, :remark]

      # 顺序敏感:先回填 company_id,再做公司授权校验
      change {SynieCore.Inv.StockCountItem.SyncCount, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      change {SynieCore.Inv.StockCountItem.ConvertedCounted, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
      change {SynieCore.Inv.StockCountItem.BookQty, []}
    end

    update :update do
      accept [:material_id, :unit_id, :counted_quantity, :remark]
      require_atomic? false

      change {SynieCore.Inv.StockCountItem.SyncCount, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      change {SynieCore.Inv.StockCountItem.ConvertedCounted, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
      change {SynieCore.Inv.StockCountItem.BookQty, []}
    end

    # 仅内部(StockCount refresh)使用:重取账面快照列,不动已填实盘数,GraphQL 不注册
    update :sync_book_quantity do
      accept []
      require_atomic? false

      argument :book_quantity, :decimal, allow_nil?: false

      change fn changeset, _context ->
        Ash.Changeset.force_change_attribute(
          changeset,
          :book_quantity,
          Ash.Changeset.get_argument(changeset, :book_quantity)
        )
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Inv.StockCountItem.SyncCount, []}
    end
  end

  validations do
    validate compare(:counted_quantity, greater_than_or_equal_to: 0), message: "实盘数量不能为负"
  end

  attributes do
    uuid_primary_key :id

    # 实盘数量(录入单位口径):审核前可空,审核要求逐行已填且 >= 0(空行整单拒)
    attribute :counted_quantity, :decimal do
      public? true
      description "实盘数量(录入单位口径,审核前可空)"
    end

    # 折算实盘(物料默认单位口径):系统算不可手改,只能由 ConvertedCounted 写入
    attribute :converted_counted, :decimal do
      writable? false
      public? true
      description "折算实盘(系统算:物料默认单位口径,6 位小数)"
    end

    # 账面数量快照(物料默认单位口径):系统取数不可手改,只能由 BookQty/refresh 写入
    attribute :book_quantity, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "账面数量快照(系统取数:物料默认单位口径,6 位小数)"
    end

    # 物料信息快照:行保存时按当前物料/单位重拍(StockItemSnapshot),
    # writable? false 照 StockDocItem 先例只能由 change 写入;spec 可空(物料本身可空)
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
    belongs_to :count, SynieCore.Inv.StockCount do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "库存盘点单"
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
