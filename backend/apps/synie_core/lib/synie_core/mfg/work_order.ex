defmodule SynieCore.Mfg.WorkOrderStatus do
  @moduledoc "生产工单状态:进行中/已完工/已作废。"

  use Ash.Type.Enum,
    values: [in_progress: "进行中", completed: "已完工", voided: "已作废"]

  def graphql_type(_), do: :mfg_work_order_status
end

defmodule SynieCore.Mfg.WorkOrder do
  @moduledoc """
  生产工单,对应 `mfg_work_order` 表。自制执行容器:由已确认、履约方式=自制、
  尚无未作废工单的需求行生成;一需求行至多一张未作废工单;不存客户。

  本质是未完成数量容器:未完成 = 工单 base 数量 − 累计生产入库 base;
  完工靠生产入库削量(累计已入 ≥ 工单数量),不靠报工。无已审核未作废生产入库
  时可作废,作废后需求行回待安排。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "mfg_work_order"
    repo SynieCore.Repo

    references do
      reference :demand_item, on_delete: :restrict
      reference :demand, on_delete: :restrict
      reference :material, on_delete: :restrict
    end

    custom_indexes do
      # 一需求行至多一张未作废工单(部分唯一)
      index [:demand_item_id],
        unique: true,
        where: "status <> 'voided'",
        name: "mfg_work_order_active_demand_item_index"
    end
  end

  graphql do
    type :mfg_work_order
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

  def permission_prefix, do: "mfg.work_order"
  def permission_label, do: "生产工单"
  def permission_actions, do: ~w(create read update delete void)

  def grid_actions do
    [
      %{key: "void", label: "作废", scope: "row", mutation: "voidMfgWorkOrder", is_danger: true}
    ]
  end

  # 未完成数量计算列进表格(GridMeta 仅反射声明的 calc)
  def grid_calculations, do: [:remaining_base_qty]

  def display_field, do: :work_order_no

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    # 从需求行生成工单(create 权限);字段由需求行派生
    create :create do
      accept [:work_order_no]

      argument :demand_item_id, :uuid, allow_nil?: false

      change set_attribute(:demand_item_id, arg(:demand_item_id))

      # 构建期回填派生字段:CompanyAccessible 与 AutoNumber(need_date 段)依赖
      change fn changeset, _context ->
        demand_item_id =
          Ash.Changeset.get_argument(changeset, :demand_item_id) ||
            Ash.Changeset.get_attribute(changeset, :demand_item_id)

        case demand_item_id && Ash.get(SynieCore.Mfg.DemandItem, demand_item_id, authorize?: false) do
          {:ok, item} ->
            changeset
            |> Ash.Changeset.force_change_attribute(:company_id, item.company_id)
            |> Ash.Changeset.force_change_attribute(:demand_id, item.demand_id)
            |> Ash.Changeset.force_change_attribute(:material_id, item.material_id)
            |> Ash.Changeset.force_change_attribute(:unit_id, item.unit_id)
            |> Ash.Changeset.force_change_attribute(:qty, item.qty)
            |> Ash.Changeset.force_change_attribute(:base_qty, item.base_qty)
            |> Ash.Changeset.force_change_attribute(
              :need_date,
              item.need_date || Date.utc_today()
            )
            |> Ash.Changeset.force_change_attribute(:material_code, item.material_code)
            |> Ash.Changeset.force_change_attribute(:material_name, item.material_name)
            |> Ash.Changeset.force_change_attribute(:material_spec, item.material_spec)
            |> Ash.Changeset.force_change_attribute(:unit_name, item.unit_name)

          _ ->
            # 编号 need_date 段兜底
            Ash.Changeset.force_change_attribute(changeset, :need_date, Date.utc_today())
        end
      end

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Numbering.AutoNumber, attribute: :work_order_no}

      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          demand_item_id =
            Ash.Changeset.get_argument(cs, :demand_item_id) ||
              Ash.Changeset.get_attribute(cs, :demand_item_id)

          case generate_from_item(cs, demand_item_id) do
            {:ok, cs} -> cs
            {:error, message} -> Ash.Changeset.add_error(cs, message: message)
          end
        end)
      end
    end

    update :update do
      accept [:work_order_no]
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.status == :in_progress,
          do: :ok,
          else: {:error, message: "仅进行中的生产工单可修改"}
      end
    end

    # 无已审核入库时可删(矩阵写侧净零与草稿误建清理);业务上更常用作废
    destroy :destroy do
      primary? true
      require_atomic? false

      validate fn changeset, _context ->
        cond do
          changeset.data.status == :voided ->
            :ok

          changeset.data.status != :in_progress ->
            {:error, message: "仅进行中的生产工单可删除"}

          has_audited_output?(changeset.data.id) ->
            {:error, message: "存在已审核生产入库,不可删除工单"}

          true ->
            :ok
        end
      end

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case lock_wo(cs.data.id) do
            {:ok, %{status: :voided}} ->
              cs

            {:ok, %{status: :in_progress} = wo} ->
              if has_audited_output?(wo.id) do
                Ash.Changeset.add_error(cs, message: "存在已审核生产入库,不可删除工单")
              else
                :ok = set_demand_item_status!(wo.demand_item_id, :pending)
                cs
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅进行中的生产工单可删除")
          end
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        cond do
          changeset.data.status != :in_progress ->
            {:error, message: "仅进行中的生产工单可作废"}

          has_audited_output?(changeset.data.id) ->
            {:error, message: "存在已审核生产入库,不可作废工单"}

          true ->
            :ok
        end
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          case lock_wo(cs.data.id) do
            {:ok, %{status: :in_progress} = wo} ->
              if has_audited_output?(wo.id) do
                Ash.Changeset.add_error(cs, message: "存在已审核生产入库,不可作废工单")
              else
                :ok = set_demand_item_status!(wo.demand_item_id, :pending)
                cs
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅进行中的生产工单可作废")
          end
        end)
      end
    end

    # 内部:生产入库审核/作废时加减已入数量并维护完工状态。不注册 GraphQL。
    update :adjust_received do
      accept []
      require_atomic? false
      argument :delta, :decimal, allow_nil?: false

      change fn changeset, _context ->
        delta = Ash.Changeset.get_argument(changeset, :delta)
        current = changeset.data.received_base_qty || Decimal.new(0)
        next = Decimal.add(current, delta)

        if Decimal.compare(next, 0) == :lt do
          Ash.Changeset.add_error(changeset, field: :received_base_qty, message: "已入数量不能为负")
        else
          base_qty = changeset.data.base_qty
          demand_item_id = changeset.data.demand_item_id

          status =
            if Decimal.compare(next, base_qty) != :lt do
              :completed
            else
              :in_progress
            end

          item_status =
            if status == :completed do
              :completed
            else
              :scheduled
            end

          changeset
          |> Ash.Changeset.force_change_attribute(:received_base_qty, next)
          |> Ash.Changeset.force_change_attribute(:status, status)
          |> Ash.Changeset.after_action(fn _cs, wo ->
            :ok = set_demand_item_status!(demand_item_id, item_status)
            {:ok, wo}
          end)
        end
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :work_order_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "工单号"
    end

    attribute :qty, :decimal do
      allow_nil? false
      public? true
      writable? false
      default Decimal.new(0)
      description "工单数量(与需求行同单位)"
    end

    attribute :base_qty, :decimal do
      allow_nil? false
      public? true
      writable? false
      default Decimal.new(0)
      description "工单数量(默认单位)"
    end

    attribute :received_base_qty, :decimal do
      allow_nil? false
      public? true
      writable? false
      default Decimal.new(0)
      description "累计已入(默认单位)"
    end

    attribute :need_date, :date do
      public? true
      writable? false
      description "需求日/交期"
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

    attribute :status, SynieCore.Mfg.WorkOrderStatus do
      allow_nil? false
      writable? false
      default :in_progress
      public? true
      description "状态"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  calculations do
    calculate :remaining_base_qty, :decimal, expr(base_qty - received_base_qty) do
      public? true
      description "未完成数量(默认单位)"
    end
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :demand, SynieCore.Mfg.Demand do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "来源需求单"
    end

    belongs_to :demand_item, SynieCore.Mfg.DemandItem do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "来源需求行"
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

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "生成人"
    end
  end

  identities do
    identity :unique_work_order_no, [:work_order_no], message: "工单号已存在"
  end

  @doc false
  def lock_wo(id) do
    __MODULE__
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  def has_audited_output?(work_order_id) do
    SynieCore.Mfg.OutputItem
    |> Ash.Query.filter(work_order_id == ^work_order_id and output.status == :audited)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  def adjust_received!(wo_id, delta) do
    wo =
      __MODULE__
      |> Ash.Query.filter(id == ^wo_id)
      |> Ash.Query.lock("FOR UPDATE")
      |> Ash.read_one!(authorize?: false)

    wo
    |> Ash.Changeset.for_update(:adjust_received, %{delta: delta})
    |> Ash.update!(authorize?: false)

    :ok
  rescue
    e in Ash.Error.Invalid ->
      msg =
        e
        |> Exception.message()
        |> to_string()

      {:error, msg}
  end

  defp generate_from_item(cs, demand_item_id) do
    item =
      SynieCore.Mfg.DemandItem
      |> Ash.Query.filter(id == ^demand_item_id)
      |> Ash.Query.lock("FOR UPDATE")
      |> Ash.read_one!(authorize?: false)

    if is_nil(item) do
      {:error, "需求行不存在"}
    else
      demand =
        SynieCore.Mfg.Demand
        |> Ash.Query.filter(id == ^item.demand_id)
        |> Ash.Query.lock("FOR UPDATE")
        |> Ash.read_one!(authorize?: false)

      cond do
        demand.status != :confirmed ->
          {:error, "仅已确认需求单的行可生成工单"}

        item.fulfillment_method != :make ->
          {:error, "仅自制行可生成生产工单"}

        item.status == :completed ->
          {:error, "已完成的需求行不可生成工单"}

        active_wo_exists?(item.id) ->
          {:error, "该需求行已有未作废生产工单"}

        true ->
          :ok = set_demand_item_status!(item.id, :scheduled)

          cs =
            cs
            |> Ash.Changeset.force_change_attribute(:company_id, item.company_id)
            |> Ash.Changeset.force_change_attribute(:demand_id, item.demand_id)
            |> Ash.Changeset.force_change_attribute(:demand_item_id, item.id)
            |> Ash.Changeset.force_change_attribute(:material_id, item.material_id)
            |> Ash.Changeset.force_change_attribute(:unit_id, item.unit_id)
            |> Ash.Changeset.force_change_attribute(:qty, item.qty)
            |> Ash.Changeset.force_change_attribute(:base_qty, item.base_qty)
            |> Ash.Changeset.force_change_attribute(
              :need_date,
              item.need_date || Date.utc_today()
            )
            |> Ash.Changeset.force_change_attribute(:material_code, item.material_code)
            |> Ash.Changeset.force_change_attribute(:material_name, item.material_name)
            |> Ash.Changeset.force_change_attribute(:material_spec, item.material_spec)
            |> Ash.Changeset.force_change_attribute(:unit_name, item.unit_name)
            |> Ash.Changeset.force_change_attribute(:status, :in_progress)
            |> Ash.Changeset.force_change_attribute(:received_base_qty, Decimal.new(0))

          {:ok, cs}
      end
    end
  end

  defp active_wo_exists?(demand_item_id) do
    __MODULE__
    |> Ash.Query.filter(demand_item_id == ^demand_item_id and status != :voided)
    |> Ash.exists?(authorize?: false)
  end

  defp set_demand_item_status!(id, status) do
    item = Ash.get!(SynieCore.Mfg.DemandItem, id, authorize?: false)

    item
    |> Ash.Changeset.for_update(:set_status, %{status: status})
    |> Ash.update!(authorize?: false)

    :ok
  end
end
