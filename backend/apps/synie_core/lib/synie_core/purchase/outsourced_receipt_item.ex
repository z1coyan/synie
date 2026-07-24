defmodule SynieCore.Purchase.OutsourcedReceiptItem.SyncReceipt do
  @moduledoc """
  行与母单同步:委外入库单必须存在且草稿态;create 时冗余 company_id。
  构建期预检 + before_action 事务内 FOR UPDATE 权威复检(同 ReceiptItem.SyncReceipt 先例)。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    receipt_id = changeset_receipt_id(changeset)

    changeset =
      case read_receipt(receipt_id) do
        {:ok, %{status: :draft} = receipt} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, receipt.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :receipt_id, message: "委外入库单不存在")

        {:ok, _receipt} ->
          Ash.Changeset.add_error(changeset,
            field: :receipt_id,
            message: "仅草稿委外入库单可编辑入库条目"
          )

        _ ->
          Ash.Changeset.add_error(changeset, field: :receipt_id, message: "委外入库单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_receipt(changeset_receipt_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :receipt_id, message: "委外入库单不存在")

        _ ->
          Ash.Changeset.add_error(cs,
            field: :receipt_id,
            message: "仅草稿委外入库单可编辑入库条目"
          )
      end
    end)
  end

  defp changeset_receipt_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :receipt_id) || changeset.data.receipt_id

  defp read_receipt(nil), do: {:ok, nil}

  defp read_receipt(id) do
    SynieCore.Purchase.OutsourcedReceipt
    |> Ash.Query.filter(id == ^id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_receipt(nil), do: {:ok, nil}

  defp lock_receipt(id) do
    SynieCore.Purchase.OutsourcedReceipt
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Purchase.OutsourcedReceiptItem.BindOrderItem do
  @moduledoc """
  绑定委外订单条目:构建期回填物料(与订单条目一致)、缺省单位取订单行单位,
  并冻结订单条目快照;before_action 再校验订单状态/委外标记/公司对手/同单原币。
  物料快照由后续 SnapshotMaterial 在构建期拍(依赖本 change 先回填 material_id)。
  (同 ReceiptItem.BindOrderItem 先例,另强制订单为委外订单)
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset = resolve_order_item(changeset)

    Ash.Changeset.before_action(changeset, fn cs ->
      order_item_id = Ash.Changeset.get_attribute(cs, :order_item_id)
      receipt_id = Ash.Changeset.get_attribute(cs, :receipt_id) || cs.data.receipt_id

      if is_nil(order_item_id) or is_nil(receipt_id) do
        cs
      else
        with {:ok, receipt} <- get_receipt(receipt_id),
             {:ok, order_item} <- get_order_item(order_item_id),
             {:ok, order} <- get_order(order_item.order_id),
             :ok <- check_order(order),
             :ok <- check_party_company(receipt, order),
             :ok <- check_currency(receipt_id, order, cs),
             :ok <- check_material(cs, order_item) do
          apply_order_snapshot(cs, order, order_item)
        else
          {:error, field, message} ->
            Ash.Changeset.add_error(cs, field: field, message: message)
        end
      end
    end)
  end

  # 构建期:有订单条目则强制物料、单位缺省回填、先写快照(before_action 再复核)
  defp resolve_order_item(changeset) do
    order_item_id = Ash.Changeset.get_attribute(changeset, :order_item_id)

    case get_order_item(order_item_id) do
      {:ok, order_item} ->
        case get_order(order_item.order_id) do
          {:ok, order} ->
            changeset =
              changeset
              |> Ash.Changeset.force_change_attribute(:material_id, order_item.material_id)
              |> then(fn cs ->
                if is_nil(Ash.Changeset.get_attribute(cs, :unit_id)) do
                  Ash.Changeset.force_change_attribute(cs, :unit_id, order_item.unit_id)
                else
                  cs
                end
              end)

            apply_order_snapshot(changeset, order, order_item)

          _ ->
            changeset
        end

      _ ->
        changeset
    end
  end

  defp apply_order_snapshot(cs, order, order_item) do
    currency_code = currency_code(order.currency_id)

    cs
    |> Ash.Changeset.force_change_attribute(:material_id, order_item.material_id)
    |> Ash.Changeset.force_change_attribute(:order_no, order.order_no)
    |> Ash.Changeset.force_change_attribute(:order_qty, order_item.qty)
    |> Ash.Changeset.force_change_attribute(:order_base_qty, order_item.base_qty)
    |> Ash.Changeset.force_change_attribute(:order_unit_name, order_item.unit_name)
    |> Ash.Changeset.force_change_attribute(:order_price, order_item.price)
    |> Ash.Changeset.force_change_attribute(:order_amount, order_item.amount)
    |> Ash.Changeset.force_change_attribute(:order_base_price, order_item.base_price)
    |> Ash.Changeset.force_change_attribute(:order_base_amount, order_item.base_amount)
    |> Ash.Changeset.force_change_attribute(:order_tax_rate, order_item.tax_rate)
    |> Ash.Changeset.force_change_attribute(:order_currency_code, currency_code)
  end

  defp get_receipt(id) do
    case Ash.get(SynieCore.Purchase.OutsourcedReceipt, id, authorize?: false) do
      {:ok, r} -> {:ok, r}
      _ -> {:error, :receipt_id, "委外入库单不存在"}
    end
  end

  defp get_order_item(id) do
    case Ash.get(SynieCore.Purchase.OrderItem, id, authorize?: false) do
      {:ok, item} -> {:ok, item}
      _ -> {:error, :order_item_id, "订单条目不存在"}
    end
  end

  defp get_order(id) do
    case Ash.get(SynieCore.Purchase.Order, id, authorize?: false) do
      {:ok, order} -> {:ok, order}
      _ -> {:error, :order_item_id, "订单不存在"}
    end
  end

  defp check_order(order) do
    cond do
      not order.is_outsourced ->
        {:error, :order_item_id, "仅委外订单条目可取行"}

      order.status == :closed ->
        {:error, :order_item_id, "订单已关闭,不可入库"}

      order.status == :voided ->
        {:error, :order_item_id, "订单已作废,不可入库"}

      order.status != :audited ->
        {:error, :order_item_id, "仅已审核订单可入库"}

      true ->
        :ok
    end
  end

  defp check_party_company(receipt, order) do
    cond do
      receipt.company_id != order.company_id ->
        {:error, :order_item_id, "订单公司与入库单不一致"}

      receipt.party_type != order.party_type or receipt.party_id != order.party_id ->
        {:error, :order_item_id, "订单对手与入库单不一致"}

      true ->
        :ok
    end
  end

  defp check_currency(receipt_id, order, changeset) do
    # 同单已有其他行时,原币必须一致
    siblings =
      SynieCore.Purchase.OutsourcedReceiptItem
      |> Ash.Query.filter(receipt_id == ^receipt_id)
      |> Ash.read!(authorize?: false)

    self_id = changeset.data && Map.get(changeset.data, :id)

    siblings =
      if self_id do
        Enum.reject(siblings, &(&1.id == self_id))
      else
        siblings
      end

    case siblings do
      [] ->
        :ok

      [first | _] ->
        if first.order_currency_code == currency_code(order.currency_id) do
          :ok
        else
          {:error, :order_item_id, "同一入库单内订单原币必须一致"}
        end
    end
  end

  defp check_material(cs, order_item) do
    material_id = Ash.Changeset.get_attribute(cs, :material_id)

    cond do
      is_nil(material_id) ->
        :ok

      material_id == order_item.material_id ->
        :ok

      true ->
        {:error, :material_id, "物料必须与订单条目一致"}
    end
  end

  defp currency_code(nil), do: nil

  defp currency_code(currency_id) do
    case Ash.get(SynieCore.Base.Currency, currency_id, authorize?: false) do
      {:ok, %{iso_code: code}} -> code
      _ -> nil
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedReceiptItem.DeriveRows do
  @moduledoc """
  比例带出(仅 create):入库条目保存后,按该条目委外订单条目的发料清单/副产物清单
  快照 ×（本行 base ÷ 条目订购 base）自动创建材料扣减行与副产物行(6 位小数,
  数量随比例折算后 ≤ 0 的清单行不带出)。带出后是独立行——可自由增删改,
  改入库条目数量不自动重算(同「代入快照脱钩」惯例)。

  材料扣减行外协仓预填单头「默认外协仓」、副产物行入仓预填单头「默认入仓」;
  头未填则留空(草稿允许,审核锁内复检必填)。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn _changeset, item ->
      derive!(item)
      {:ok, item}
    end)
  end

  @doc false
  def derive!(item) do
    if Decimal.compare(item.order_base_qty || Decimal.new(0), 0) == :gt and
         Decimal.compare(item.base_qty || Decimal.new(0), 0) == :gt do
      ratio = Decimal.div(item.base_qty, item.order_base_qty)
      receipt = Ash.get!(SynieCore.Purchase.OutsourcedReceipt, item.receipt_id, authorize?: false)

      SynieCore.Purchase.OrderItemMaterial
      |> Ash.Query.filter(order_item_id == ^item.order_item_id)
      |> Ash.read!(authorize?: false)
      |> Enum.each(fn line ->
        qty = line.quantity |> Decimal.mult(ratio) |> Decimal.round(6)

        if Decimal.compare(qty, 0) == :gt do
          SynieCore.Purchase.OutsourcedReceiptItemMaterial
          |> Ash.Changeset.for_create(:create, %{
            receipt_item_id: item.id,
            idx: line_seq(item.id, SynieCore.Purchase.OutsourcedReceiptItemMaterial),
            order_item_material_id: line.id,
            qty: qty,
            outsourced_warehouse_id: receipt.outsourced_warehouse_id
          })
          |> Ash.create!(authorize?: false)
        end
      end)

      SynieCore.Purchase.OrderItemByproduct
      |> Ash.Query.filter(order_item_id == ^item.order_item_id)
      |> Ash.read!(authorize?: false)
      |> Enum.each(fn line ->
        qty = line.quantity |> Decimal.mult(ratio) |> Decimal.round(6)

        if Decimal.compare(qty, 0) == :gt do
          SynieCore.Purchase.OutsourcedReceiptItemByproduct
          |> Ash.Changeset.for_create(:create, %{
            receipt_item_id: item.id,
            idx: line_seq(item.id, SynieCore.Purchase.OutsourcedReceiptItemByproduct),
            order_item_byproduct_id: line.id,
            qty: qty,
            warehouse_id: receipt.warehouse_id
          })
          |> Ash.create!(authorize?: false)
        end
      end)
    end

    :ok
  end

  defp line_seq(receipt_item_id, resource) do
    resource
    |> Ash.Query.filter(receipt_item_id == ^receipt_item_id)
    |> Ash.read!(authorize?: false)
    |> Enum.map(& &1.idx)
    |> Enum.max(fn -> 0 end)
    |> Kernel.+(1)
  end
end

defmodule SynieCore.Purchase.OutsourcedReceiptItem do
  @moduledoc """
  委外入库条目(成品行),对应 `pur_outsourced_receipt_item` 表。

  行必挂已审核未关闭的委外订单条目(物料须一致,同一订单条目可一单多行分仓入库);
  单位可空=订单行单位,限默认/转换单位,系统折算 base_qty;行仓必填(本公司启用叶子仓);
  行保存冻结物料快照(编号/名称/规格/客户料号/单位名)与订单条目快照
  (订单号/订购量与订购 base/价税/本币金额/税率/币种代码/订单行单位名)。
  create 后按发料清单/副产物清单快照比例自动带出材料扣减行与副产物行
  (见 `DeriveRows`)。另冗余**已对账数量**(默认单位,受控投影)进采购对账条目池。
  权限复用 `purchase.outsourced_receipt`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    primary_read_warning?: false

  require Ash.Query

  postgres do
    table "pur_outsourced_receipt_item"
    repo SynieCore.Repo

    references do
      reference :receipt, on_delete: :delete

      # 订单条目可能长期存在;入库行保留引用,订单删不了(有入库时),on_delete nothing
      reference :order_item, on_delete: :nothing
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"

      check_constraint :reconciled_qty, "reconciled_qty_nonnegative",
        check: "reconciled_qty >= 0",
        message: "已对账数量不能为负"
    end
  end

  graphql do
    type :pur_outsourced_receipt_item
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

  def grid_calculations,
    do: [
      :receipt_no,
      :receipt_date,
      :receipt_status,
      :party_type,
      :party_id,
      :remaining_reconcilable_qty
    ]

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
        :receipt_id,
        :idx,
        :order_item_id,
        :material_id,
        :unit_id,
        :qty,
        :warehouse_id,
        :remarks
      ]

      change {SynieCore.Purchase.OutsourcedReceiptItem.SyncReceipt, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Purchase.OutsourcedReceiptItem.BindOrderItem, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      validate {SynieCore.Inv.WarehouseUsable, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Sales.SnapshotMaterial, []}
      # 比例带出须在行落库后(after_action):扣减/副产物行引用本行 id 且需 base_qty 已定
      change {SynieCore.Purchase.OutsourcedReceiptItem.DeriveRows, []}
    end

    update :update do
      accept [:idx, :order_item_id, :material_id, :unit_id, :qty, :warehouse_id, :remarks]
      require_atomic? false

      change {SynieCore.Purchase.OutsourcedReceiptItem.SyncReceipt, []}
      change {SynieCore.Purchase.OutsourcedReceiptItem.BindOrderItem, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      validate {SynieCore.Inv.WarehouseUsable, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Sales.SnapshotMaterial, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Purchase.OutsourcedReceiptItem.SyncReceipt, []}
    end

    # 内部动作:采购对账单生效(常规单确认/赠送样品单结单)与回退(撤回/作废)时
    # 加减已对账数量(默认单位)。调用方须已 FOR UPDATE 锁住本行,并完成剩余量校验;不注册 GraphQL。
    update :adjust_reconciled_qty do
      accept []
      require_atomic? false
      argument :delta, :decimal, allow_nil?: false

      change fn changeset, _context ->
        delta = Ash.Changeset.get_argument(changeset, :delta)
        current = changeset.data.reconciled_qty || Decimal.new(0)
        next = Decimal.add(current, delta)

        if Decimal.compare(next, 0) == :lt do
          Ash.Changeset.add_error(changeset, field: :reconciled_qty, message: "已对账数量不能为负")
        else
          Ash.Changeset.force_change_attribute(changeset, :reconciled_qty, next)
        end
      end
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

    attribute :base_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "折算数量(物料默认单位,6 位)"
    end

    # 物料快照
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

    attribute :customer_part_no, :string do
      writable? false
      public? true
      description "客户料号"
    end

    attribute :unit_name, :string do
      allow_nil? false
      writable? false
      public? true
      description "单位名称"
    end

    # 订单条目快照
    attribute :order_no, :string do
      allow_nil? false
      writable? false
      public? true
      description "订单号"
    end

    attribute :order_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "订购数量(订单行单位)"
    end

    attribute :order_base_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "订购数量(默认单位)"
    end

    attribute :order_unit_name, :string do
      allow_nil? false
      writable? false
      public? true
      description "订单行单位名称"
    end

    attribute :order_price, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "原币含税单价(加工费)"
    end

    attribute :order_amount, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "原币含税金额"
    end

    attribute :order_base_price, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "本币含税单价(加工费)"
    end

    attribute :order_base_amount, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "本币含税金额"
    end

    attribute :order_tax_rate, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "税率"
    end

    attribute :order_currency_code, :string do
      allow_nil? false
      writable? false
      public? true
      description "订单原币代码"
    end

    # 已对账数量(默认单位,受控投影):生效中采购对账单行累计,确认/结单加、撤回/作废减
    attribute :reconciled_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "已对账数量(默认单位;由采购对账单生效/回退同步)"
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
    belongs_to :receipt, SynieCore.Purchase.OutsourcedReceipt do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "委外入库单"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :order_item, SynieCore.Purchase.OrderItem do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "委外订单条目"
    end

    belongs_to :material, SynieCore.Inv.Material do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "物料(成品,须与订单条目一致)"
    end

    belongs_to :unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "单位"
    end

    belongs_to :warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "入库仓库"
    end

    has_many :material_rows, SynieCore.Purchase.OutsourcedReceiptItemMaterial do
      destination_attribute :receipt_item_id
      sort idx: :asc
      public? true
      description "材料扣减行"
    end

    has_many :byproduct_rows, SynieCore.Purchase.OutsourcedReceiptItemByproduct do
      destination_attribute :receipt_item_id
      sort idx: :asc
      public? true
      description "副产物行"
    end
  end

  calculations do
    calculate :receipt_no, :string, expr(receipt.receipt_no) do
      public? true
      description "入库单号"
    end

    calculate :receipt_date, :date, expr(receipt.receipt_date) do
      public? true
      description "入库日期"
    end

    calculate :receipt_status,
              SynieCore.Purchase.OutsourcedReceiptStatus,
              expr(receipt.status) do
      public? true
      description "入库单状态"
    end

    calculate :party_type, SynieCore.Acc.PartyType, expr(receipt.party_type) do
      public? true
      description "对手类型(供应商/内部公司)"
    end

    calculate :party_id, :uuid, expr(receipt.party_id) do
      public? true
      description "对手"
    end

    # 剩余可对账量 = 入库 base − 已对账(对账条目池过滤:> 0 才可勾选)
    calculate :remaining_reconcilable_qty,
              :decimal,
              expr(base_qty - reconciled_qty) do
      public? true
      description "剩余可对账量(默认单位)"
    end
  end
end
