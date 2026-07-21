defmodule SynieCore.Purchase.ReceiptItem.SyncReceipt do
  @moduledoc """
  行与母单同步:入库单必须存在且草稿态;create 时冗余 company_id。
  构建期预检 + before_action 事务内 FOR UPDATE 权威复检(同 Sales.DeliveryItem.SyncDelivery 先例)。
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
          Ash.Changeset.add_error(changeset, field: :receipt_id, message: "采购入库单不存在")

        {:ok, _receipt} ->
          Ash.Changeset.add_error(changeset,
            field: :receipt_id,
            message: "仅草稿采购入库单可编辑入库条目"
          )

        _ ->
          Ash.Changeset.add_error(changeset, field: :receipt_id, message: "采购入库单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_receipt(changeset_receipt_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :receipt_id, message: "采购入库单不存在")

        _ ->
          Ash.Changeset.add_error(cs,
            field: :receipt_id,
            message: "仅草稿采购入库单可编辑入库条目"
          )
      end
    end)
  end

  defp changeset_receipt_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :receipt_id) || changeset.data.receipt_id

  defp read_receipt(nil), do: {:ok, nil}

  defp read_receipt(id) do
    SynieCore.Purchase.Receipt
    |> Ash.Query.filter(id == ^id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_receipt(nil), do: {:ok, nil}

  defp lock_receipt(id) do
    SynieCore.Purchase.Receipt
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Purchase.ReceiptItem.BindOrderItem do
  @moduledoc """
  绑定订单条目:构建期回填物料(与订单条目一致)、缺省单位取订单行单位,
  并冻结订单条目快照;before_action 再校验订单状态/公司对手/同单原币。
  物料快照由后续 SnapshotMaterial 在构建期拍(依赖本 change 先回填 material_id)。
  (同 Sales.DeliveryItem.BindOrderItem 先例)
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset = resolve_order_item(changeset)

    Ash.Changeset.before_action(changeset, fn cs ->
      order_item_id = Ash.Changeset.get_attribute(cs, :order_item_id)
      receipt_id = Ash.Changeset.get_attribute(cs, :receipt_id) || cs.data.receipt_id

      cond do
        is_nil(order_item_id) or is_nil(receipt_id) ->
          cs

        true ->
          with {:ok, receipt} <- get_receipt(receipt_id),
               {:ok, order_item} <- get_order_item(order_item_id),
               {:ok, order} <- get_order(order_item.order_id),
               :ok <- check_order_status(order),
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
    case Ash.get(SynieCore.Purchase.Receipt, id, authorize?: false) do
      {:ok, r} -> {:ok, r}
      _ -> {:error, :receipt_id, "采购入库单不存在"}
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

  defp check_order_status(%{status: :audited}), do: :ok
  defp check_order_status(%{status: :closed}), do: {:error, :order_item_id, "订单已关闭,不可入库"}
  defp check_order_status(%{status: :voided}), do: {:error, :order_item_id, "订单已作废,不可入库"}
  defp check_order_status(_), do: {:error, :order_item_id, "仅已审核订单可入库"}

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
      SynieCore.Purchase.ReceiptItem
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

defmodule SynieCore.Purchase.ReceiptItem.SyncDrawings do
  @moduledoc """
  图纸挂接复制:行 create/update 后把物料当前 drawing 槽位的 sys_file 同步为
  行挂接(owner_type `pur_receipt_item`、category `drawing`);整删整建,
  引用复制而非字节复制(同订单条目 `OrderItem.SyncDrawings` 先例)。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Files.Attachment
  alias SynieCore.Purchase.ReceiptItem.ClearDrawings

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn _changeset, item ->
      sync!(item)
      {:ok, item}
    end)
  end

  @doc false
  def sync!(item) do
    ClearDrawings.clear!(item.id)

    Attachment
    |> Ash.Query.filter(
      owner_type == "inv_material" and owner_id == ^item.material_id and category == "drawing"
    )
    |> Ash.read!(authorize?: false)
    |> Enum.each(fn %{file_id: file_id} ->
      Attachment
      |> Ash.Changeset.for_create(:create, %{
        file_id: file_id,
        owner_type: "pur_receipt_item",
        owner_id: item.id,
        category: "drawing",
        company_id: item.company_id
      })
      |> Ash.create!(authorize?: false)
    end)
  end
end

defmodule SynieCore.Purchase.ReceiptItem.ClearDrawings do
  @moduledoc """
  清理入库行的图纸挂接。attachment 与行无外键,行删挂接不会跟着删,
  留着会让 sys_file 被 AttachmentGuard 永久锁死,故行 destroy 必须显式清。
  注意:入库单删行走 DB 级联,本钩子不触发——单头清理见 `Receipt.ClearItemDrawings`。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Files.Attachment

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn _changeset, item ->
      clear!(item.id)
      {:ok, item}
    end)
  end

  @doc false
  def clear!(item_id) do
    Attachment
    |> Ash.Query.filter(
      owner_type == "pur_receipt_item" and owner_id == ^item_id and category == "drawing"
    )
    |> Ash.read!(authorize?: false)
    |> Enum.each(&Ash.destroy!(&1, authorize?: false))
  end
end

defmodule SynieCore.Purchase.ReceiptItem do
  @moduledoc """
  采购入库条目,对应 `pur_receipt_item` 表。

  行必挂已审核未关闭订单条目(物料须一致,同一订单条目可一单多行分仓入库);
  单位可空=订单行单位,限默认/转换单位,系统折算 base_qty;行仓必填(本公司启用叶子仓);
  行保存冻结物料快照(编号/名称/规格/客户料号/单位名)与订单条目快照
  (订单号/订购量与订购 base/价税/本币金额/税率/币种代码/订单行单位名);
  物料 drawing 槽位在行保存时复制挂接到行(见 `SyncDrawings`),
  行/入库单删除时显式清理(见 `ClearDrawings` 与 `Receipt.ClearItemDrawings`)。
  权限复用 `purchase.receipt`。
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
    table "pur_receipt_item"
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
    type :pur_receipt_item
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

  def permission_prefix, do: "purchase.receipt"
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

      change {SynieCore.Purchase.ReceiptItem.SyncReceipt, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Purchase.ReceiptItem.BindOrderItem, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      validate {SynieCore.Inv.WarehouseUsable, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Sales.SnapshotMaterial, []}
      change {SynieCore.Purchase.ReceiptItem.SyncDrawings, []}
    end

    update :update do
      accept [:idx, :order_item_id, :material_id, :unit_id, :qty, :warehouse_id, :remarks]
      require_atomic? false

      change {SynieCore.Purchase.ReceiptItem.SyncReceipt, []}
      change {SynieCore.Purchase.ReceiptItem.BindOrderItem, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      validate {SynieCore.Inv.WarehouseUsable, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Sales.SnapshotMaterial, []}
      change {SynieCore.Purchase.ReceiptItem.SyncDrawings, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Purchase.ReceiptItem.SyncReceipt, []}
      change {SynieCore.Purchase.ReceiptItem.ClearDrawings, []}
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
      description "原币含税单价"
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
      description "本币含税单价"
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
    belongs_to :receipt, SynieCore.Purchase.Receipt do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "采购入库单"
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
      description "订单条目"
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

    belongs_to :warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "入库仓库"
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

    calculate :receipt_status, SynieCore.Purchase.ReceiptStatus, expr(receipt.status) do
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
