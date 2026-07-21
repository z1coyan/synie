defmodule SynieCore.Sales.ReconciliationItem.SyncReconciliation do
  @moduledoc """
  行与母单同步:对账单必须存在且草稿态;create 时冗余 company_id。
  构建期预检 + before_action 事务内 FOR UPDATE 权威复检(同 DeliveryItem.SyncDelivery)。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    reconciliation_id = changeset_reconciliation_id(changeset)

    changeset =
      case read_reconciliation(reconciliation_id) do
        {:ok, %{status: :draft} = reconciliation} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(
              changeset,
              :company_id,
              reconciliation.company_id
            )
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset,
            field: :reconciliation_id,
            message: "销售对账单不存在"
          )

        {:ok, _reconciliation} ->
          Ash.Changeset.add_error(changeset,
            field: :reconciliation_id,
            message: "仅草稿销售对账单可编辑对账条目"
          )

        _ ->
          Ash.Changeset.add_error(changeset,
            field: :reconciliation_id,
            message: "销售对账单不存在"
          )
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_reconciliation(changeset_reconciliation_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :reconciliation_id, message: "销售对账单不存在")

        _ ->
          Ash.Changeset.add_error(cs,
            field: :reconciliation_id,
            message: "仅草稿销售对账单可编辑对账条目"
          )
      end
    end)
  end

  defp changeset_reconciliation_id(changeset),
    do:
      Ash.Changeset.get_attribute(changeset, :reconciliation_id) ||
        changeset.data.reconciliation_id

  defp read_reconciliation(nil), do: {:ok, nil}

  defp read_reconciliation(id) do
    SynieCore.Sales.Reconciliation
    |> Ash.Query.filter(id == ^id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_reconciliation(nil), do: {:ok, nil}

  defp lock_reconciliation(id) do
    SynieCore.Sales.Reconciliation
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Sales.ReconciliationItem.BindDeliveryItem do
  @moduledoc """
  绑定发货条目:构建期预检(存在性/发货已审核/公司对手一致/单内同币种/分型约束/
  剩余可对账量)并按金额链算行金额;before_action 事务内 FOR UPDATE 锁发货条目权威复检。

  数量口径:对账数量按发货条目行单位录入,base_qty 按发货条目 qty→base_qty
  比例折算(6 位);行金额=对账数量×发货条目快照原币含税单价(2 位),
  本币金额=行金额×源订单汇率(2 位)——均在 before_action 内取数,此时
  SyncReconciliation 已锁住母单(声明序在前,钩子同序执行),头字段不会被并发改。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset = precheck(changeset)

    Ash.Changeset.before_action(changeset, fn cs ->
      delivery_item_id = Ash.Changeset.get_attribute(cs, :delivery_item_id)

      reconciliation_id =
        Ash.Changeset.get_attribute(cs, :reconciliation_id) || cs.data.reconciliation_id

      with {:ok, delivery_item} <- lock_delivery_item(delivery_item_id),
           {:ok, reconciliation} <- get_reconciliation(reconciliation_id),
           {:ok, order} <- get_source_order(delivery_item),
           :ok <- check_delivery_status(delivery_item),
           :ok <- check_party_company(reconciliation, delivery_item),
           :ok <- check_currency(reconciliation_id, delivery_item, cs),
           :ok <- check_type_rules(reconciliation, delivery_item, order),
           :ok <- check_qty(cs, delivery_item) do
        apply_amounts(cs, delivery_item, order)
      else
        {:error, field, message} -> Ash.Changeset.add_error(cs, field: field, message: message)
      end
    end)
  end

  # 构建期预检(友好报错,不加锁):发货条目存在性与剩余量粗检;权威校验在钩子里
  defp precheck(changeset) do
    case Ash.Changeset.get_attribute(changeset, :delivery_item_id) do
      nil ->
        changeset

      delivery_item_id ->
        case Ash.get(SynieCore.Sales.DeliveryItem, delivery_item_id, authorize?: false) do
          {:ok, _delivery_item} -> changeset
          _ -> Ash.Changeset.add_error(changeset, field: :delivery_item_id, message: "发货条目不存在")
        end
    end
  end

  defp lock_delivery_item(nil), do: {:error, :delivery_item_id, "发货条目不能为空"}

  defp lock_delivery_item(id) do
    SynieCore.Sales.DeliveryItem
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
    |> case do
      {:ok, nil} -> {:error, :delivery_item_id, "发货条目不存在"}
      {:ok, delivery_item} -> {:ok, delivery_item}
      _ -> {:error, :delivery_item_id, "发货条目不存在"}
    end
  end

  defp get_reconciliation(nil), do: {:error, :reconciliation_id, "销售对账单不存在"}

  defp get_reconciliation(id) do
    case Ash.get(SynieCore.Sales.Reconciliation, id, authorize?: false) do
      {:ok, reconciliation} -> {:ok, reconciliation}
      _ -> {:error, :reconciliation_id, "销售对账单不存在"}
    end
  end

  # 源订单:经发货条目→订单条目→订单取汇率与订单类型(样品来源判定)
  defp get_source_order(delivery_item) do
    with {:ok, order_item} <-
           Ash.get(SynieCore.Sales.OrderItem, delivery_item.order_item_id, authorize?: false),
         {:ok, order} <- Ash.get(SynieCore.Sales.Order, order_item.order_id, authorize?: false) do
      {:ok, order}
    else
      _ -> {:error, :delivery_item_id, "发货条目的源订单不存在"}
    end
  end

  defp check_delivery_status(delivery_item) do
    case Ash.get(SynieCore.Sales.Delivery, delivery_item.delivery_id, authorize?: false) do
      {:ok, %{status: :audited}} -> :ok
      {:ok, %{status: :voided}} -> {:error, :delivery_item_id, "发货单已作废,不可对账"}
      {:ok, _} -> {:error, :delivery_item_id, "仅已审核发货单的条目可对账"}
      _ -> {:error, :delivery_item_id, "发货单不存在"}
    end
  end

  defp check_party_company(reconciliation, delivery_item) do
    delivery = Ash.get!(SynieCore.Sales.Delivery, delivery_item.delivery_id, authorize?: false)

    cond do
      delivery.company_id != reconciliation.company_id ->
        {:error, :delivery_item_id, "发货单公司与对账单不一致"}

      delivery.party_type != reconciliation.party_type or
          delivery.party_id != reconciliation.party_id ->
        {:error, :delivery_item_id, "发货单对手与对账单不一致"}

      true ->
        :ok
    end
  end

  defp check_currency(reconciliation_id, delivery_item, changeset) do
    # 单内同币种:同单已有其他行时,订单原币必须一致
    siblings =
      SynieCore.Sales.ReconciliationItem
      |> Ash.Query.filter(reconciliation_id == ^reconciliation_id)
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
        first_delivery_item =
          Ash.get!(SynieCore.Sales.DeliveryItem, first.delivery_item_id, authorize?: false)

        if first_delivery_item.order_currency_code == delivery_item.order_currency_code do
          :ok
        else
          {:error, :delivery_item_id, "同一对账单内订单原币必须一致"}
        end
    end
  end

  # 分型条目约束(不对称):常规单禁勾样品订单来源与零金额行;赠送/样品单不限来源
  defp check_type_rules(%{reconciliation_type: :regular}, delivery_item, order) do
    zero = Decimal.new(0)

    cond do
      order.order_type == :sample ->
        {:error, :delivery_item_id, "常规对账单不可勾选样品订单来源条目"}

      Decimal.compare(delivery_item.order_price, zero) != :gt ->
        {:error, :delivery_item_id, "常规对账单不可勾选零金额条目"}

      true ->
        :ok
    end
  end

  defp check_type_rules(_reconciliation, _delivery_item, _order), do: :ok

  # 对账数量 ≤ 剩余可对账量(发货 base − 已对账,按本行 base 折算比较);草稿期预消耗,
  # 生效时点(确认/结单)在母单动作里按分组复核——此处挡的是行保存即超限
  defp check_qty(changeset, delivery_item) do
    qty = Ash.Changeset.get_attribute(changeset, :qty)

    if is_nil(qty) do
      :ok
    else
      base_qty = base_qty(qty, delivery_item)
      remaining = Decimal.sub(delivery_item.base_qty, delivery_item.reconciled_qty)

      if Decimal.compare(base_qty, remaining) == :gt do
        {:error, :qty, "超出剩余可对账量(剩余 #{Decimal.to_string(remaining)})"}
      else
        :ok
      end
    end
  end

  # 金额链:行金额=对账数量×快照原币含税单价(2 位);本币=行金额×源订单汇率(2 位);
  # base_qty 按发货条目行单位→默认单位比例折算(6 位)
  defp apply_amounts(changeset, delivery_item, order) do
    qty = Ash.Changeset.get_attribute(changeset, :qty)

    if is_nil(qty) do
      changeset
    else
      amount = qty |> Decimal.mult(delivery_item.order_price) |> Decimal.round(2)

      changeset
      |> Ash.Changeset.force_change_attribute(:base_qty, base_qty(qty, delivery_item))
      |> Ash.Changeset.force_change_attribute(:amount, amount)
      |> Ash.Changeset.force_change_attribute(
        :base_amount,
        amount |> Decimal.mult(order.exchange_rate) |> Decimal.round(2)
      )
    end
  end

  defp base_qty(qty, delivery_item) do
    if Decimal.compare(delivery_item.qty, 0) == :eq do
      qty
    else
      qty
      |> Decimal.mult(delivery_item.base_qty)
      |> Decimal.div(delivery_item.qty)
      |> Decimal.round(6)
    end
  end
end

defmodule SynieCore.Sales.ReconciliationItem do
  @moduledoc """
  销售对账条目,对应 `sal_reconciliation_item` 表。

  行必挂发货条目;对账数量按发货条目行单位录入,系统折算 base_qty 并校验
  剩余可对账量(发货 base − 已对账);金额两列系统算不可手改(金额链,
  见 `BindDeliveryItem`),物料/价税口径沿用发货条目快照(经 calculations 暴露)。
  草稿不占量——生效时点由母单动作累加/回滚发货条目 `reconciled_qty`。
  权限复用 `sales.reconciliation`。
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
    table "sal_reconciliation_item"
    repo SynieCore.Repo

    references do
      reference :reconciliation, on_delete: :delete

      # 发货条目长期存在;对账行保留引用,发货条目被发货单级联删除仅限草稿单(无对账行),on_delete nothing
      reference :delivery_item, on_delete: :nothing
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"
    end
  end

  graphql do
    type :sal_reconciliation_item
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

  def permission_prefix, do: "sales.reconciliation"
  def permission_actions, do: []

  def grid_calculations,
    do: [
      :reconciliation_no,
      :reconciliation_status,
      :delivery_no,
      :delivery_date,
      :material_name,
      :unit_name,
      :order_currency_code
    ]

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
      accept [:reconciliation_id, :idx, :delivery_item_id, :qty, :remarks]

      change {SynieCore.Sales.ReconciliationItem.SyncReconciliation, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Sales.ReconciliationItem.BindDeliveryItem, []}
    end

    update :update do
      accept [:idx, :delivery_item_id, :qty, :remarks]
      require_atomic? false

      change {SynieCore.Sales.ReconciliationItem.SyncReconciliation, []}
      change {SynieCore.Sales.ReconciliationItem.BindDeliveryItem, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Sales.ReconciliationItem.SyncReconciliation, []}
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
      description "对账数量(发货条目行单位)"
    end

    attribute :base_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "折算数量(物料默认单位,6 位;与已对账数量同口径)"
    end

    attribute :amount, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "原币含税金额(数量×快照原币含税单价,2 位)"
    end

    attribute :base_amount, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "本币含税金额(原币金额×源订单汇率,2 位)"
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
    belongs_to :reconciliation, SynieCore.Sales.Reconciliation do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "销售对账单"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :delivery_item, SynieCore.Sales.DeliveryItem do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "发货条目"
    end
  end

  calculations do
    calculate :reconciliation_no, :string, expr(reconciliation.reconciliation_no) do
      public? true
      description "对账单号"
    end

    calculate :reconciliation_status,
              SynieCore.Sales.ReconciliationStatus,
              expr(reconciliation.status) do
      public? true
      description "对账单状态"
    end

    calculate :delivery_no, :string, expr(delivery_item.delivery.delivery_no) do
      public? true
      description "发货单号"
    end

    calculate :delivery_date, :date, expr(delivery_item.delivery.delivery_date) do
      public? true
      description "发货日期"
    end

    calculate :material_name, :string, expr(delivery_item.material_name) do
      public? true
      description "物料名称(发货条目快照)"
    end

    calculate :unit_name, :string, expr(delivery_item.unit_name) do
      public? true
      description "单位名称(发货条目快照)"
    end

    calculate :order_currency_code, :string, expr(delivery_item.order_currency_code) do
      public? true
      description "订单原币代码"
    end
  end
end
