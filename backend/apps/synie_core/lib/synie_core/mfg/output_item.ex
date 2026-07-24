defmodule SynieCore.Mfg.OutputItem.WorkOrderOk do
  @moduledoc """
  行挂工单:工单须存在、同公司、未作废;物料强制与工单一致(忽略用户传的 material_id)。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    work_order_id = Ash.Changeset.get_attribute(changeset, :work_order_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id) || changeset.data.company_id

    case load_wo(work_order_id) do
      {:ok, wo} ->
        cond do
          wo.status == :voided ->
            Ash.Changeset.add_error(changeset, field: :work_order_id, message: "生产工单已作废")

          not is_nil(company_id) and wo.company_id != company_id ->
            Ash.Changeset.add_error(changeset, field: :work_order_id, message: "生产工单不属于本公司")

          true ->
            changeset
            |> Ash.Changeset.force_change_attribute(:material_id, wo.material_id)
            |> Ash.Changeset.force_change_attribute(:material_code, wo.material_code)
            |> Ash.Changeset.force_change_attribute(:material_name, wo.material_name)
            |> Ash.Changeset.force_change_attribute(:material_spec, wo.material_spec)
        end

      :error ->
        if is_nil(work_order_id) do
          changeset
        else
          Ash.Changeset.add_error(changeset, field: :work_order_id, message: "生产工单不存在")
        end
    end
  end

  defp load_wo(nil), do: :error

  defp load_wo(id) do
    case Ash.get(SynieCore.Mfg.WorkOrder, id, authorize?: false) do
      {:ok, wo} -> {:ok, wo}
      _ -> :error
    end
  end
end

defmodule SynieCore.Mfg.OutputItem do
  @moduledoc """
  生产入库行,对应 `mfg_output_item` 表。必挂生产工单、物料与工单一致、仓为启用叶子;
  无独立权限点,跟随 `mfg.output`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    primary_read_warning?: false

  postgres do
    table "mfg_output_item"
    repo SynieCore.Repo

    references do
      reference :output, on_delete: :delete
      reference :work_order, on_delete: :restrict
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"
    end
  end

  graphql do
    type :mfg_output_item
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

  def permission_prefix, do: "mfg.output"
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
      accept [:output_id, :idx, :work_order_id, :unit_id, :qty, :warehouse_id, :remarks]

      change {SynieCore.Mfg.SyncParentDraft,
              parent: SynieCore.Mfg.Output,
              parent_key: :output_id,
              not_found_message: "生产入库单不存在",
              not_draft_message: "仅草稿生产入库单可编辑单据行"}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Mfg.OutputItem.WorkOrderOk, []}
      validate {SynieCore.Inv.WarehouseUsable, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
    end

    update :update do
      accept [:idx, :work_order_id, :unit_id, :qty, :warehouse_id, :remarks]
      require_atomic? false

      change {SynieCore.Mfg.SyncParentDraft,
              parent: SynieCore.Mfg.Output,
              parent_key: :output_id,
              not_found_message: "生产入库单不存在",
              not_draft_message: "仅草稿生产入库单可编辑单据行"}
      change {SynieCore.Mfg.OutputItem.WorkOrderOk, []}
      validate {SynieCore.Inv.WarehouseUsable, []}
      validate {SynieCore.Inv.StockItemUnitAllowed, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Inv.StockItemSnapshot, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Mfg.SyncParentDraft,
              parent: SynieCore.Mfg.Output,
              parent_key: :output_id,
              not_found_message: "生产入库单不存在",
              not_draft_message: "仅草稿生产入库单可编辑单据行"}
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
    belongs_to :output, SynieCore.Mfg.Output do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "生产入库单"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :work_order, SynieCore.Mfg.WorkOrder do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "生产工单"
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
end
