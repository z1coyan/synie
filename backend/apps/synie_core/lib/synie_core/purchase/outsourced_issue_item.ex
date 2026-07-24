defmodule SynieCore.Purchase.OutsourcedIssueItem.SyncIssue do
  @moduledoc """
  行与母单同步:发料单必须存在且草稿态;create 时冗余 company_id。
  构建期预检 + before_action 事务内 FOR UPDATE 权威复检(同 ReceiptItem.SyncReceipt 先例)。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    issue_id = changeset_issue_id(changeset)

    changeset =
      case read_issue(issue_id) do
        {:ok, %{status: :draft} = issue} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, issue.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :issue_id, message: "委外发料单不存在")

        {:ok, _issue} ->
          Ash.Changeset.add_error(changeset,
            field: :issue_id,
            message: "仅草稿委外发料单可编辑发料条目"
          )

        _ ->
          Ash.Changeset.add_error(changeset, field: :issue_id, message: "委外发料单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_issue(changeset_issue_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :issue_id, message: "委外发料单不存在")

        _ ->
          Ash.Changeset.add_error(cs,
            field: :issue_id,
            message: "仅草稿委外发料单可编辑发料条目"
          )
      end
    end)
  end

  defp changeset_issue_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :issue_id) || changeset.data.issue_id

  defp read_issue(nil), do: {:ok, nil}

  defp read_issue(id) do
    SynieCore.Purchase.OutsourcedIssue
    |> Ash.Query.filter(id == ^id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_issue(nil), do: {:ok, nil}

  defp lock_issue(id) do
    SynieCore.Purchase.OutsourcedIssue
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Purchase.OutsourcedIssueItem.BindMaterialLine do
  @moduledoc """
  绑定发料清单行:行必挂委外订单条目的发料清单行(唯一取行来源);
  构建期强制回填材料/单位(以清单行为准,不可手改)并写订单号快照;
  before_action 再校验订单状态(仅已审核委外订单可发料)与公司/对手一致性
  (可跨多张委外订单取行,全部行订单经头对手校验自然同公司同对手)。
  (同 ReceiptItem.BindOrderItem 先例)
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset = resolve_material_line(changeset)

    Ash.Changeset.before_action(changeset, fn cs ->
      line_id = Ash.Changeset.get_attribute(cs, :order_item_material_id)
      issue_id = Ash.Changeset.get_attribute(cs, :issue_id) || cs.data.issue_id

      if is_nil(line_id) or is_nil(issue_id) do
        cs
      else
        with {:ok, issue} <- get_issue(issue_id),
             {:ok, line} <- get_line(line_id),
             {:ok, order_item} <- get_order_item(line.order_item_id),
             {:ok, order} <- get_order(order_item.order_id),
             :ok <- check_order(order),
             :ok <- check_party_company(issue, order) do
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

  # 构建期:有清单行则强制材料/单位并先写订单号快照(before_action 再复核)
  defp resolve_material_line(changeset) do
    line_id = Ash.Changeset.get_attribute(changeset, :order_item_material_id)

    with {:ok, line} <- get_line(line_id),
         {:ok, order_item} <- get_order_item(line.order_item_id),
         {:ok, order} <- get_order(order_item.order_id) do
      changeset
      |> Ash.Changeset.force_change_attribute(:material_id, line.material_id)
      |> Ash.Changeset.force_change_attribute(:unit_id, line.unit_id)
      |> Ash.Changeset.force_change_attribute(:order_no, order.order_no)
    else
      _ -> changeset
    end
  end

  defp get_issue(id) do
    case Ash.get(SynieCore.Purchase.OutsourcedIssue, id, authorize?: false) do
      {:ok, issue} -> {:ok, issue}
      _ -> {:error, :issue_id, "委外发料单不存在"}
    end
  end

  defp get_line(id) do
    case Ash.get(SynieCore.Purchase.OrderItemMaterial, id, authorize?: false) do
      {:ok, line} -> {:ok, line}
      _ -> {:error, :order_item_material_id, "发料清单行不存在"}
    end
  end

  defp get_order_item(id) do
    case Ash.get(SynieCore.Purchase.OrderItem, id, authorize?: false) do
      {:ok, item} -> {:ok, item}
      _ -> {:error, :order_item_material_id, "订单条目不存在"}
    end
  end

  defp get_order(id) do
    case Ash.get(SynieCore.Purchase.Order, id, authorize?: false) do
      {:ok, order} -> {:ok, order}
      _ -> {:error, :order_item_material_id, "订单不存在"}
    end
  end

  defp check_order(order) do
    cond do
      not order.is_outsourced ->
        {:error, :order_item_material_id, "仅委外订单的发料清单行可取行"}

      order.status == :closed ->
        {:error, :order_item_material_id, "订单已关闭,不可发料"}

      order.status == :voided ->
        {:error, :order_item_material_id, "订单已作废,不可发料"}

      order.status != :audited ->
        {:error, :order_item_material_id, "仅已审核订单可发料"}

      true ->
        :ok
    end
  end

  defp check_party_company(issue, order) do
    cond do
      issue.company_id != order.company_id ->
        {:error, :order_item_material_id, "订单公司与发料单不一致"}

      issue.party_type != order.party_type or issue.party_id != order.party_id ->
        {:error, :order_item_material_id, "订单对手与发料单不一致"}

      true ->
        :ok
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedIssueItem.OutsourcedWarehouseForParty do
  @moduledoc """
  行外协仓校验:限绑定母单对手的外协仓(行上无对手属性,先取母单再复用
  `Inv.OutsourcedWarehouseUsable.check/4`);构建期预检,审核锁内还有权威复检。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    warehouse_id = Ash.Changeset.get_attribute(changeset, :outsourced_warehouse_id)
    issue_id = Ash.Changeset.get_attribute(changeset, :issue_id) || changeset.data.issue_id

    if is_nil(warehouse_id) or is_nil(issue_id) do
      :ok
    else
      case Ash.get(SynieCore.Purchase.OutsourcedIssue, issue_id, authorize?: false) do
        {:ok, issue} ->
          case SynieCore.Inv.OutsourcedWarehouseUsable.check(
                 warehouse_id,
                 issue.company_id,
                 issue.party_type,
                 issue.party_id
               ) do
            :ok -> :ok
            {:error, message} -> {:error, field: :outsourced_warehouse_id, message: message}
          end

        _ ->
          # 母单不存在由 SyncIssue 报出
          :ok
      end
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedIssueItem.WarehousesDistinct do
  @moduledoc "校验行调出仓与外协仓不能是同一仓(同仓移动无业务意义)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    from_id = Ash.Changeset.get_attribute(changeset, :from_warehouse_id)
    to_id = Ash.Changeset.get_attribute(changeset, :outsourced_warehouse_id)

    if is_nil(from_id) or is_nil(to_id) or from_id != to_id do
      :ok
    else
      {:error, field: :outsourced_warehouse_id, message: "调出仓与外协仓不能是同一仓"}
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedIssueItem do
  @moduledoc """
  委外发料条目,对应 `pur_outsourced_issue_item` 表。

  行必挂委外订单条目的发料清单行(`order_item_material`,唯一取行来源),
  材料/单位以清单行为准强制带出(不可手改),行保存冻结物料快照(编号/名称/规格)
  与单位名称、订单号快照;数量录入后系统折算 base_qty(材料默认单位,6 位);
  行调出仓必填(本公司启用叶子仓),行外协仓必填(限绑定母单对手的外协仓)。
  权限复用 `purchase.outsourced_issue`。
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
    table "pur_outsourced_issue_item"
    repo SynieCore.Repo

    references do
      reference :issue, on_delete: :delete

      # 发料清单行可能随草稿订单删除;有发料行引用时保留引用,删单被拒(on_delete nothing)
      reference :order_item_material, on_delete: :nothing
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"
    end
  end

  graphql do
    type :pur_outsourced_issue_item
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

  def permission_prefix, do: "purchase.outsourced_issue"
  def permission_actions, do: []

  def grid_calculations,
    do: [:issue_no, :issue_date, :issue_status, :party_type, :party_id]

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
        :issue_id,
        :idx,
        :order_item_material_id,
        :material_id,
        :unit_id,
        :qty,
        :from_warehouse_id,
        :outsourced_warehouse_id,
        :remarks
      ]

      # 顺序敏感:先同步母单(回填 company_id 并预检草稿),再做公司授权校验;
      # BindMaterialLine 强制材料/单位后折算与快照才有输入
      change {SynieCore.Purchase.OutsourcedIssueItem.SyncIssue, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Purchase.OutsourcedIssueItem.BindMaterialLine, []}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :from_warehouse_id}
      validate {SynieCore.Purchase.OutsourcedIssueItem.OutsourcedWarehouseForParty, []}
      validate {SynieCore.Purchase.OutsourcedIssueItem.WarehousesDistinct, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
    end

    update :update do
      accept [
        :idx,
        :order_item_material_id,
        :material_id,
        :unit_id,
        :qty,
        :from_warehouse_id,
        :outsourced_warehouse_id,
        :remarks
      ]

      require_atomic? false

      change {SynieCore.Purchase.OutsourcedIssueItem.SyncIssue, []}
      change {SynieCore.Purchase.OutsourcedIssueItem.BindMaterialLine, []}
      validate {SynieCore.Inv.WarehouseUsable, attribute: :from_warehouse_id}
      validate {SynieCore.Purchase.OutsourcedIssueItem.OutsourcedWarehouseForParty, []}
      validate {SynieCore.Purchase.OutsourcedIssueItem.WarehousesDistinct, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Purchase.OutsourcedIssueItem.SyncIssue, []}
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
      description "折算数量(材料默认单位,6 位)"
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
    belongs_to :issue, SynieCore.Purchase.OutsourcedIssue do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "委外发料单"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      description "公司"
    end

    belongs_to :order_item_material, SynieCore.Purchase.OrderItemMaterial do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "发料清单行"
    end

    belongs_to :material, SynieCore.Inv.Material do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "材料(以发料清单行为准)"
    end

    belongs_to :unit, SynieCore.Base.Unit do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "单位(以发料清单行为准)"
    end

    belongs_to :from_warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "调出仓(本公司启用叶子仓)"
    end

    belongs_to :outsourced_warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "外协仓(限绑定当前对手)"
    end
  end

  calculations do
    calculate :issue_no, :string, expr(issue.issue_no) do
      public? true
      description "发料单号"
    end

    calculate :issue_date, :date, expr(issue.issue_date) do
      public? true
      description "发料日期"
    end

    calculate :issue_status,
              SynieCore.Purchase.OutsourcedIssueStatus,
              expr(issue.status) do
      public? true
      description "发料单状态"
    end

    calculate :party_type, SynieCore.Acc.PartyType, expr(issue.party_type) do
      public? true
      description "对手类型(供应商/内部公司)"
    end

    calculate :party_id, :uuid, expr(issue.party_id) do
      public? true
      description "对手"
    end
  end
end
