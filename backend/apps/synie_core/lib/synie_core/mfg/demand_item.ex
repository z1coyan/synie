defmodule SynieCore.Mfg.FulfillmentMethod do
  @moduledoc "履约方式:自制/外购/委外/库存。"

  use Ash.Type.Enum,
    values: [make: "自制", buy: "外购", outsource: "委外", stock: "库存"]

  def graphql_type(_), do: :mfg_fulfillment_method
end

defmodule SynieCore.Mfg.DemandItemStatus do
  @moduledoc "履约需求行状态:待安排/已安排/已完成。"

  use Ash.Type.Enum,
    values: [pending: "待安排", scheduled: "已安排", completed: "已完成"]

  def graphql_type(_), do: :mfg_demand_item_status
end

defmodule SynieCore.Mfg.DemandItem.SalesSourceOk do
  @moduledoc """
  有销售来源时:订单条目须同公司、订单已审核未关闭;占用硬校验
  Σ 未作废需求行 base(含草稿,排除本行) + 本行 base ≤ 订单条目订购 base。

  权威复检(before_action)传 `lock: true`:先对销售订单条目行加 FOR UPDATE
  行锁再算占用,使同一销售条目的占用校验串行化,防两张草稿并发一起超占
  (US 46;照 lock_demand/lock_output 同一模式)。
  """

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    sales_order_item_id = Ash.Changeset.get_attribute(changeset, :sales_order_item_id)

    if is_nil(sales_order_item_id) do
      :ok
    else
      company_id = Ash.Changeset.get_attribute(changeset, :company_id) || changeset.data.company_id
      base_qty = Ash.Changeset.get_attribute(changeset, :base_qty) || changeset.data.base_qty
      exclude_id = if changeset.action_type == :update, do: changeset.data.id, else: nil

      case check(sales_order_item_id, company_id, base_qty, exclude_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: :sales_order_item_id, message: message}
      end
    end
  end

  @doc false
  def check(sales_order_item_id, company_id, base_qty, exclude_id, opts \\ []) do
    with {:ok, item, order} <- load_source(sales_order_item_id, Keyword.get(opts, :lock, false)),
         :ok <- check_company(item, company_id),
         :ok <- check_order_status(order),
         :ok <- check_occupancy(item, base_qty, exclude_id) do
      :ok
    end
  end

  defp load_source(id, false) do
    case Ash.get(SynieCore.Sales.OrderItem, id, authorize?: false) do
      {:ok, item} -> load_order(item)
      _ -> {:error, "销售订单条目不存在"}
    end
  end

  defp load_source(id, true) do
    case lock_sales_order_item(id) do
      {:ok, nil} -> {:error, "销售订单条目不存在"}
      {:ok, item} -> load_order(item)
      _ -> {:error, "销售订单条目不存在"}
    end
  end

  defp load_order(item) do
    case Ash.get(SynieCore.Sales.Order, item.order_id, authorize?: false) do
      {:ok, order} -> {:ok, item, order}
      _ -> {:error, "销售订单条目不存在"}
    end
  end

  defp lock_sales_order_item(id) do
    SynieCore.Sales.OrderItem
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  defp check_company(item, company_id) do
    if item.company_id == company_id, do: :ok, else: {:error, "销售订单条目不属于本公司"}
  end

  defp check_order_status(%{status: :audited}), do: :ok
  defp check_order_status(_), do: {:error, "仅已审核未关闭的销售订单条目可纳入"}

  defp check_occupancy(order_item, base_qty, exclude_id) do
    occupied = SynieCore.Mfg.DemandItem.occupied_base_qty(order_item.id, exclude_id)
    base_qty = base_qty || Decimal.new(0)
    total = Decimal.add(occupied, base_qty)

    if Decimal.compare(total, order_item.base_qty) == :gt do
      remaining = Decimal.sub(order_item.base_qty, occupied)

      {:error,
       "超出销售订单可占用数量(已占用#{Decimal.to_string(occupied)},剩余#{Decimal.to_string(remaining)},本行#{Decimal.to_string(base_qty)})"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Mfg.DemandItem.SnapshotMaterial do
  @moduledoc "物料/单位快照:行保存即重拍(同库存单据行)。"

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    material_id = Ash.Changeset.get_attribute(changeset, :material_id)
    unit_id = Ash.Changeset.get_attribute(changeset, :unit_id)

    with {:ok, material} <- get(SynieCore.Inv.Material, material_id),
         {:ok, unit} <- get(SynieCore.Base.Unit, unit_id) do
      changeset
      |> Ash.Changeset.force_change_attribute(:material_code, material.code)
      |> Ash.Changeset.force_change_attribute(:material_name, material.name)
      |> Ash.Changeset.force_change_attribute(:material_spec, material.spec)
      |> Ash.Changeset.force_change_attribute(:unit_name, unit.name)
    else
      _ -> changeset
    end
  end

  defp get(_resource, nil), do: :error
  defp get(resource, id), do: Ash.get(resource, id, authorize?: false)
end

defmodule SynieCore.Mfg.DemandItem do
  @moduledoc """
  履约需求行,对应 `mfg_demand_item` 表。物料+数量+需求日+履约方式+可选销售来源;
  无独立权限点,跟随 `mfg.demand`。

  行状态:外购/委外/库存 待安排→已完成(complete);自制 待安排→已安排(生成工单)→
  已完成(入库完工回写)。销售来源占用含草稿与已确认未作废需求单上的行。
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
    table "mfg_demand_item"
    repo SynieCore.Repo

    references do
      reference :demand, on_delete: :delete
      reference :sales_order_item, on_delete: :restrict
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"
    end
  end

  graphql do
    type :mfg_demand_item
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # complete / change_fulfillment 是编辑衍生,复用 update 码
    policy action([:complete, :change_fulfillment]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end

    # 勾选池占用查询是读取衍生,复用 read 码
    policy action(:sales_item_occupancy) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "mfg.demand"
  def permission_actions, do: []

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
        :demand_id,
        :idx,
        :material_id,
        :unit_id,
        :qty,
        :need_date,
        :fulfillment_method,
        :sales_order_item_id,
        :remarks
      ]

      change {SynieCore.Mfg.SyncParentDraft,
              parent: SynieCore.Mfg.Demand,
              parent_key: :demand_id,
              not_found_message: "履约需求单不存在",
              not_draft_message: "仅草稿履约需求单可编辑需求行"}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Mfg.DemandItem.SnapshotMaterial, []}
      # 占用校验依赖 base_qty,放在 before_action 之后的权威复检
      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          sales_id = Ash.Changeset.get_attribute(cs, :sales_order_item_id)
          base_qty = Ash.Changeset.get_attribute(cs, :base_qty)
          company_id = Ash.Changeset.get_attribute(cs, :company_id)

          if is_nil(sales_id) do
            cs
          else
            case SynieCore.Mfg.DemandItem.SalesSourceOk.check(sales_id, company_id, base_qty, nil,
                   lock: true
                 ) do
              :ok -> cs
              {:error, message} -> Ash.Changeset.add_error(cs, field: :sales_order_item_id, message: message)
            end
          end
        end)
      end
    end

    update :update do
      accept [
        :idx,
        :material_id,
        :unit_id,
        :qty,
        :need_date,
        :fulfillment_method,
        :sales_order_item_id,
        :remarks
      ]

      require_atomic? false

      change {SynieCore.Mfg.SyncParentDraft,
              parent: SynieCore.Mfg.Demand,
              parent_key: :demand_id,
              not_found_message: "履约需求单不存在",
              not_draft_message: "仅草稿履约需求单可编辑需求行"}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Mfg.DemandItem.SnapshotMaterial, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          sales_id = Ash.Changeset.get_attribute(cs, :sales_order_item_id)
          base_qty = Ash.Changeset.get_attribute(cs, :base_qty)
          company_id = Ash.Changeset.get_attribute(cs, :company_id) || cs.data.company_id

          if is_nil(sales_id) do
            cs
          else
            case SynieCore.Mfg.DemandItem.SalesSourceOk.check(
                   sales_id,
                   company_id,
                   base_qty,
                   cs.data.id,
                   lock: true
                 ) do
              :ok -> cs
              {:error, message} -> Ash.Changeset.add_error(cs, field: :sales_order_item_id, message: message)
            end
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Mfg.SyncParentDraft,
              parent: SynieCore.Mfg.Demand,
              parent_key: :demand_id,
              not_found_message: "履约需求单不存在",
              not_draft_message: "仅草稿履约需求单可编辑需求行"}
    end

    # 外购/委外/库存:待安排 → 已完成(计划一点离开待办)
    update :complete do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        demand = read_demand!(changeset.data.demand_id)

        cond do
          demand.status != :confirmed ->
            {:error, message: "仅已确认需求单上的行可点完成"}

          changeset.data.status != :pending ->
            {:error, message: "仅待安排的行可点完成"}

          changeset.data.fulfillment_method == :make ->
            {:error, message: "自制行不能直接点完成,须经生产入库完工"}

          true ->
            :ok
        end
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :completed)
        |> Ash.Changeset.before_action(fn cs ->
          demand = lock_demand!(cs.data.demand_id)
          item = lock_item!(cs.data.id)

          cond do
            demand.status != :confirmed ->
              Ash.Changeset.add_error(cs, message: "仅已确认需求单上的行可点完成")

            item.status != :pending ->
              Ash.Changeset.add_error(cs, message: "仅待安排的行可点完成")

            item.fulfillment_method == :make ->
              Ash.Changeset.add_error(cs, message: "自制行不能直接点完成,须经生产入库完工")

            true ->
              cs
          end
        end)
      end
    end

    # 内部:工单生成/作废/完工回写行状态。不注册 GraphQL。
    update :set_status do
      accept []
      require_atomic? false
      argument :status, SynieCore.Mfg.DemandItemStatus, allow_nil?: false

      change fn changeset, _context ->
        status = Ash.Changeset.get_argument(changeset, :status)
        Ash.Changeset.force_change_attribute(changeset, :status, status)
      end
    end

    # 确认后改履约方式:无未作废工单且未完成
    update :change_fulfillment do
      accept [:fulfillment_method]
      require_atomic? false

      validate fn changeset, _context ->
        demand = read_demand!(changeset.data.demand_id)

        cond do
          demand.status != :confirmed ->
            {:error, message: "仅已确认需求单上的行可改履约方式"}

          changeset.data.status == :completed ->
            {:error, message: "已完成行不可改履约方式"}

          has_active_work_order?(changeset.data.id) ->
            {:error, message: "存在未作废生产工单,不可改履约方式"}

          true ->
            :ok
        end
      end

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          demand = lock_demand!(cs.data.demand_id)
          item = lock_item!(cs.data.id)

          cond do
            demand.status != :confirmed ->
              Ash.Changeset.add_error(cs, message: "仅已确认需求单上的行可改履约方式")

            item.status == :completed ->
              Ash.Changeset.add_error(cs, message: "已完成行不可改履约方式")

            has_active_work_order?(item.id) ->
              Ash.Changeset.add_error(cs, message: "存在未作废生产工单,不可改履约方式")

            true ->
              # 改回/改为自制后保持待安排(已安排仅由工单生成)
              if item.status == :scheduled do
                Ash.Changeset.force_change_attribute(cs, :status, :pending)
              else
                cs
              end
          end
        end)
      end
    end

    # 勾选池:销售条目订购/已占用/剩余可占用(json 标量数组,不分页)
    action :sales_item_occupancy, {:array, :map} do
      description "销售订单条目占用:订购 base、已占用 base、剩余可占用 base(需求单勾选池用)"

      argument :sales_order_item_ids, {:array, :uuid}, allow_nil?: false

      run SynieCore.Mfg.SalesItemOccupancy
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
      description "数量"
    end

    attribute :base_qty, :decimal do
      allow_nil? false
      public? true
      writable? false
      default Decimal.new(0)
      description "折算默认单位数量"
    end

    attribute :need_date, :date do
      public? true
      description "需求日"
    end

    attribute :fulfillment_method, SynieCore.Mfg.FulfillmentMethod do
      allow_nil? false
      public? true
      default :make
      description "履约方式"
    end

    attribute :status, SynieCore.Mfg.DemandItemStatus do
      allow_nil? false
      writable? false
      default :pending
      public? true
      description "行状态"
    end

    attribute :material_code, :string do
      allow_nil? false
      public? true
      writable? false
      default ""
      description "物料编号快照"
    end

    attribute :material_name, :string do
      allow_nil? false
      public? true
      writable? false
      default ""
      description "物料名称快照"
    end

    attribute :material_spec, :string do
      public? true
      writable? false
      description "物料规格快照"
    end

    attribute :unit_name, :string do
      allow_nil? false
      public? true
      writable? false
      default ""
      description "单位名称快照"
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
    belongs_to :demand, SynieCore.Mfg.Demand do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "履约需求单"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
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

    belongs_to :sales_order_item, SynieCore.Sales.OrderItem do
      public? true
      attribute_public? true
      attribute_writable? true
      description "来源销售订单条目(可空)"
    end

    has_many :work_orders, SynieCore.Mfg.WorkOrder do
      destination_attribute :demand_item_id
      public? true
      description "生产工单"
    end
  end

  @doc "某销售订单条目在未作废需求单上的已占用 base 数量(可排除自身行)。"
  def occupied_base_qty(sales_order_item_id, exclude_item_id \\ nil) do
    query =
      __MODULE__
      |> Ash.Query.filter(
        sales_order_item_id == ^sales_order_item_id and demand.status != :voided
      )

    query =
      if exclude_item_id do
        Ash.Query.filter(query, id != ^exclude_item_id)
      else
        query
      end

    query
    |> Ash.read!(authorize?: false)
    |> Enum.map(& &1.base_qty)
    |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
  end

  @doc "可占用 = 订购 base − 已占用。"
  def remaining_occupiable(sales_order_item_id) do
    case Ash.get(SynieCore.Sales.OrderItem, sales_order_item_id, authorize?: false) do
      {:ok, item} ->
        Decimal.sub(item.base_qty, occupied_base_qty(sales_order_item_id))

      _ ->
        Decimal.new(0)
    end
  end

  defp has_active_work_order?(demand_item_id) do
    SynieCore.Mfg.WorkOrder
    |> Ash.Query.filter(demand_item_id == ^demand_item_id and status != :voided)
    |> Ash.exists?(authorize?: false)
  end

  defp read_demand!(id) do
    Ash.get!(SynieCore.Mfg.Demand, id, authorize?: false)
  end

  defp lock_demand!(id) do
    SynieCore.Mfg.Demand
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one!(authorize?: false)
  end

  defp lock_item!(id) do
    __MODULE__
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one!(authorize?: false)
  end
end
