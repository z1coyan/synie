defmodule SynieCore.Purchase.OutsourcedReceiptItemByproduct.BindByproductLine do
  @moduledoc """
  绑定副产物清单行:副产物行必挂父入库条目同一委外订单条目的副产物清单行;
  物料/单位以清单行为准强制带出(不可手改),写订单号快照。
  (同 OutsourcedReceiptItemMaterial.BindMaterialLine 先例)
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    changeset = resolve_byproduct_line(changeset)

    Ash.Changeset.before_action(changeset, fn cs ->
      line_id = Ash.Changeset.get_attribute(cs, :order_item_byproduct_id)
      receipt_item_id = Ash.Changeset.get_attribute(cs, :receipt_item_id) || cs.data.receipt_item_id

      if is_nil(line_id) or is_nil(receipt_item_id) do
        cs
      else
        with {:ok, line} <- get_line(line_id),
             {:ok, receipt_item} <- get_receipt_item(receipt_item_id),
             :ok <- check_same_order_item(line, receipt_item),
             {:ok, order} <- get_order(receipt_item) do
          cs
          |> Ash.Changeset.force_change_attribute(:material_id, line.material_id)
          |> Ash.Changeset.force_change_attribute(:unit_id, line.unit_id)
          |> Ash.Changeset.force_change_attribute(:order_no, order.order_no)
        else
          {:error, field, message} -> Ash.Changeset.add_error(cs, field: field, message: message)
        end
      end
    end)
  end

  # 构建期:有清单行则强制物料/单位并先写订单号快照(before_action 再复核)
  defp resolve_byproduct_line(changeset) do
    line_id = Ash.Changeset.get_attribute(changeset, :order_item_byproduct_id)

    with {:ok, line} <- get_line(line_id),
         {:ok, receipt_item} <-
           get_receipt_item(
             Ash.Changeset.get_attribute(changeset, :receipt_item_id) ||
               changeset.data.receipt_item_id
           ),
         {:ok, order} <- get_order(receipt_item) do
      changeset
      |> Ash.Changeset.force_change_attribute(:material_id, line.material_id)
      |> Ash.Changeset.force_change_attribute(:unit_id, line.unit_id)
      |> Ash.Changeset.force_change_attribute(:order_no, order.order_no)
    else
      _ -> changeset
    end
  end

  defp get_line(id) do
    case Ash.get(SynieCore.Purchase.OrderItemByproduct, id, authorize?: false) do
      {:ok, line} -> {:ok, line}
      _ -> {:error, :order_item_byproduct_id, "副产物清单行不存在"}
    end
  end

  defp get_receipt_item(id) do
    case Ash.get(SynieCore.Purchase.OutsourcedReceiptItem, id, authorize?: false) do
      {:ok, item} -> {:ok, item}
      _ -> {:error, :receipt_item_id, "入库条目不存在"}
    end
  end

  defp get_order(receipt_item) do
    with {:ok, order_item} <-
           Ash.get(SynieCore.Purchase.OrderItem, receipt_item.order_item_id, authorize?: false),
         {:ok, order} <-
           Ash.get(SynieCore.Purchase.Order, order_item.order_id, authorize?: false) do
      {:ok, order}
    else
      _ -> {:error, :receipt_item_id, "入库条目的源订单不存在"}
    end
  end

  defp check_same_order_item(line, receipt_item) do
    if line.order_item_id == receipt_item.order_item_id do
      :ok
    else
      {:error, :order_item_byproduct_id, "副产物清单行须属于入库条目的订单条目"}
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedReceiptItemByproduct.OptionalWarehouseUsable do
  @moduledoc """
  副产物行入仓可空(草稿允许,审核锁内复检必填);有值时必须本公司启用叶子仓
  (WarehouseUsable 同款;公司经父入库条目取)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    warehouse_id = Ash.Changeset.get_attribute(changeset, :warehouse_id)
    receipt_item_id =
      Ash.Changeset.get_attribute(changeset, :receipt_item_id) || changeset.data.receipt_item_id

    if is_nil(warehouse_id) or is_nil(receipt_item_id) do
      :ok
    else
      case Ash.get(SynieCore.Purchase.OutsourcedReceiptItem, receipt_item_id, authorize?: false) do
        {:ok, receipt_item} ->
          case SynieCore.Inv.WarehouseUsable.check(warehouse_id, receipt_item.company_id) do
            :ok -> :ok
            {:error, message} -> {:error, field: :warehouse_id, message: message}
          end

        _ ->
          # 父条目不存在由 SyncReceiptItem 报出
          :ok
      end
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedReceiptItemByproduct do
  @moduledoc """
  委外入库副产物行,对应 `pur_outsourced_receipt_item_byproduct` 表。

  由入库条目按副产物清单快照 ×（本行 base ÷ 条目订购 base）比例带出
  (见 `OutsourcedReceiptItem.DeriveRows`),带出后可自由增删改;
  行必挂父入库条目同一委外订单条目的副产物清单行,物料/单位以清单行为准强制带出;
  数量录入后系统折算 base_qty(物料默认单位,6 位);入仓可空(草稿允许,
  审核锁内复检必填且限本公司启用叶子仓)。审核写本公司仓正向数量分录、
  无金额不过总账(同生产入库第一期先例)。
  权限复用 `purchase.outsourced_receipt`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    primary_read_warning?: false

  postgres do
    table "pur_outsourced_receipt_item_byproduct"
    repo SynieCore.Repo

    references do
      reference :receipt_item, on_delete: :delete

      # 副产物清单行可能随草稿订单删除;有入库行引用时保留引用,删单被拒(on_delete nothing)
      reference :order_item_byproduct, on_delete: :nothing
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"
    end
  end

  graphql do
    type :pur_outsourced_receipt_item_byproduct
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

  def permission_prefix, do: "purchase.outsourced_receipt"
  def permission_actions, do: []

  def grid_calculations, do: [:receipt_no]

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
        :receipt_item_id,
        :idx,
        :order_item_byproduct_id,
        :material_id,
        :unit_id,
        :qty,
        :warehouse_id,
        :remarks
      ]

      # 顺序敏感:先同步父条目(回填 company_id 并预检母单草稿),再做公司授权校验;
      # BindByproductLine 强制物料/单位后折算与快照才有输入
      change {SynieCore.Purchase.OutsourcedReceiptItemMaterial.SyncReceiptItem, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Purchase.OutsourcedReceiptItemByproduct.BindByproductLine, []}
      validate {SynieCore.Purchase.OutsourcedReceiptItemByproduct.OptionalWarehouseUsable, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
    end

    update :update do
      accept [
        :idx,
        :order_item_byproduct_id,
        :material_id,
        :unit_id,
        :qty,
        :warehouse_id,
        :remarks
      ]

      require_atomic? false

      change {SynieCore.Purchase.OutsourcedReceiptItemMaterial.SyncReceiptItem, []}
      change {SynieCore.Purchase.OutsourcedReceiptItemByproduct.BindByproductLine, []}
      validate {SynieCore.Purchase.OutsourcedReceiptItemByproduct.OptionalWarehouseUsable, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Purchase.OutsourcedReceiptItemMaterial.SyncReceiptItem, []}
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
      description "入库数量"
    end

    attribute :base_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "折算数量(物料默认单位,6 位)"
    end

    # 物料快照(行保存即重拍,审核锁行即冻结)
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

    # 来源订单快照
    attribute :order_no, :string do
      allow_nil? false
      writable? false
      public? true
      description "订单号"
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
    belongs_to :receipt_item, SynieCore.Purchase.OutsourcedReceiptItem do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "入库条目"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :order_item_byproduct, SynieCore.Purchase.OrderItemByproduct do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "副产物清单行"
    end

    belongs_to :material, SynieCore.Inv.Material do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "物料(以副产物清单行为准)"
    end

    belongs_to :unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "单位(以副产物清单行为准)"
    end

    belongs_to :warehouse, SynieCore.Inv.Warehouse do
      public? true
      attribute_public? true
      attribute_writable? true
      description "入仓(可空,审核前必填;本公司启用叶子仓)"
    end
  end

  calculations do
    calculate :receipt_no, :string, expr(receipt_item.receipt.receipt_no) do
      public? true
      description "入库单号"
    end
  end
end
