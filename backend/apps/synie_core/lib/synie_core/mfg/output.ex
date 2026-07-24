defmodule SynieCore.Mfg.OutputStatus do
  @moduledoc "生产入库单状态:草稿/已审核/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]

  def graphql_type(_), do: :mfg_output_status
end

defmodule SynieCore.Mfg.OutputDraft do
  @moduledoc "校验生产入库单处于草稿态。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿生产入库单可修改或删除"}
    end
  end
end

defmodule SynieCore.Mfg.Output.OptionalWarehouseUsable do
  @moduledoc "头仓可空(新建行预填);有值时须本公司启用叶子仓。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    warehouse_id = Ash.Changeset.get_attribute(changeset, :warehouse_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(warehouse_id) do
      :ok
    else
      case SynieCore.Inv.WarehouseUsable.check(warehouse_id, company_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: :warehouse_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Mfg.Output do
  @moduledoc """
  生产入库单(头),对应 `mfg_output` 表。对生产工单的成品入账:审核写正向库存分录、
  累加工单已入、满量/容差内超入后工单完工并回写需求行;作废回滚。第一期只数量账,
  不过生产成本总账。

  生命周期:草稿 → 已审核 → 已作废;仅草稿可改可删;无反审核。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "mfg_output"
    repo SynieCore.Repo
  end

  graphql do
    type :mfg_output
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
  def permission_label, do: "生产入库单"
  def permission_actions, do: ~w(create read update delete audit void)

  def grid_actions do
    [
      %{key: "audit", label: "审核", scope: "row", mutation: "auditMfgOutput", is_danger: false},
      %{key: "void", label: "作废", scope: "row", mutation: "voidMfgOutput", is_danger: true}
    ]
  end

  def display_field, do: :output_no

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
      accept [:company_id, :output_no, :output_date, :warehouse_id, :remarks]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Mfg.Output.OptionalWarehouseUsable, []}
      change {SynieCore.Numbering.AutoNumber, attribute: :output_no}

      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end
    end

    update :update do
      accept [:output_no, :output_date, :warehouse_id, :remarks]
      require_atomic? false

      validate {SynieCore.Mfg.OutputDraft, []}
      validate {SynieCore.Mfg.Output.OptionalWarehouseUsable, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_output(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿生产入库单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Mfg.OutputDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_output(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿生产入库单可修改或删除")
          end
        end)
      end
    end

    update :audit do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.status == :draft,
          do: :ok,
          else: {:error, message: "仅草稿生产入库单可审核"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "审核前必须至少填写一行入库条目"}
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :audited)
        |> Ash.Changeset.force_change_attribute(:audited_at, DateTime.utc_now())
        |> then(fn cs ->
          case context.actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :audited_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_output(cs.data.id) do
            {:ok, %{status: :draft} = locked} ->
              case __MODULE__.fulfill!(locked) do
                :ok -> cs
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿生产入库单可审核")
          end
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.status == :audited,
          do: :ok,
          else: {:error, message: "仅已审核生产入库单可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_output(cs.data.id) do
            {:ok, %{status: :audited} = locked} ->
              case __MODULE__.unfulfill!(locked) do
                :ok -> cs
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅已审核生产入库单可作废")
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :output_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "入库单号"
    end

    attribute :output_date, :date do
      allow_nil? false
      public? true
      default &Date.utc_today/0
      description "入库日期(库存分录业务日)"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "备注"
    end

    attribute :status, SynieCore.Mfg.OutputStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
    end

    attribute :audited_at, :utc_datetime_usec do
      writable? false
      public? true
      description "审核时间"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :warehouse, SynieCore.Inv.Warehouse do
      public? true
      attribute_public? true
      attribute_writable? true
      description "默认仓库(可空,仅新建行预填)"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end

    belongs_to :audited_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "审核人"
    end

    has_many :items, SynieCore.Mfg.OutputItem do
      destination_attribute :output_id
      sort idx: :asc
      public? true
      description "入库行"
    end
  end

  identities do
    identity :unique_output_no, [:output_no], message: "入库单号已存在"
  end

  @doc false
  def lock_output(id) do
    __MODULE__
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  def has_items?(output_id) do
    SynieCore.Mfg.OutputItem
    |> Ash.Query.filter(output_id == ^output_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  def load_items(output_id) do
    SynieCore.Mfg.OutputItem
    |> Ash.Query.filter(output_id == ^output_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  @doc false
  def fulfill!(output) do
    items = load_items(output.id)

    with :ok <- check_items_present(items),
         :ok <- check_warehouses(items, output.company_id),
         :ok <- check_work_orders_and_overreceive(items),
         :ok <- post_stock(output, items),
         :ok <- adjust_work_orders(items, :add) do
      :ok
    end
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  @doc false
  def unfulfill!(output) do
    items = load_items(output.id)

    with :ok <- cancel_stock(output),
         :ok <- adjust_work_orders(items, :sub) do
      :ok
    end
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  defp check_items_present([]), do: {:error, "审核前必须至少填写一行入库条目"}
  defp check_items_present(_), do: :ok

  defp check_warehouses(items, company_id) do
    Enum.reduce_while(items, :ok, fn item, :ok ->
      case SynieCore.Inv.WarehouseUsable.check(item.warehouse_id, company_id) do
        :ok -> {:cont, :ok}
        {:error, msg} -> {:halt, {:error, "第#{item.idx}行:#{msg}"}}
      end
    end)
  end

  defp check_work_orders_and_overreceive(items) do
    ratio =
      case SynieCore.Mfg.Setting.get() do
        %{output_overreceive_ratio: r} when not is_nil(r) -> r
        _ -> Decimal.new(0)
      end

    items
    |> Enum.group_by(& &1.work_order_id)
    |> Enum.reduce_while(:ok, fn {wo_id, group}, :ok ->
      case check_one_work_order(wo_id, group, ratio) do
        :ok -> {:cont, :ok}
        {:error, _} = err -> {:halt, err}
      end
    end)
  end

  defp check_one_work_order(wo_id, group, ratio) do
    wo =
      SynieCore.Mfg.WorkOrder
      |> Ash.Query.filter(id == ^wo_id)
      |> Ash.Query.lock("FOR UPDATE")
      |> Ash.read_one!(authorize?: false)

    cond do
      wo.status == :voided ->
        {:error, "第#{hd(group).idx}行:生产工单已作废,不可入库"}

      wo.status not in [:in_progress, :completed] ->
        {:error, "第#{hd(group).idx}行:生产工单状态不可入库"}

      true ->
        add_base =
          group
          |> Enum.map(& &1.base_qty)
          |> Enum.reduce(Decimal.new(0), &Decimal.add/2)

        received = wo.received_base_qty || Decimal.new(0)
        after_receive = Decimal.add(received, add_base)
        max_allowed = Decimal.mult(wo.base_qty, Decimal.add(Decimal.new(1), ratio))

        if Decimal.compare(after_receive, max_allowed) == :gt do
          {:error,
           "第#{hd(group).idx}行:超出生产入库容差(已入#{Decimal.to_string(received)}+本单#{Decimal.to_string(add_base)} > 工单#{Decimal.to_string(wo.base_qty)}×(1+#{Decimal.to_string(ratio)}))"}
        else
          :ok
        end
    end
  end

  defp post_stock(output, items) do
    SynieCore.Inv.Stock.post!(
      %{
        voucher_type: "mfg.output",
        voucher_id: output.id,
        voucher_no: output.output_no,
        company_id: output.company_id,
        posting_date: output.output_date
      },
      Enum.map(items, fn item ->
        %{
          warehouse_id: item.warehouse_id,
          material_id: item.material_id,
          quantity: item.base_qty,
          remarks: item.remarks || output.remarks
        }
      end)
    )

    :ok
  end

  defp cancel_stock(output) do
    SynieCore.Inv.Stock.cancel!("mfg.output", output.id)
    :ok
  end

  defp adjust_work_orders(items, :add) do
    items
    |> Enum.group_by(& &1.work_order_id)
    |> Enum.reduce_while(:ok, fn {wo_id, group}, :ok ->
      add =
        group
        |> Enum.map(& &1.base_qty)
        |> Enum.reduce(Decimal.new(0), &Decimal.add/2)

      case SynieCore.Mfg.WorkOrder.adjust_received!(wo_id, add) do
        :ok -> {:cont, :ok}
        {:error, msg} -> {:halt, {:error, msg}}
      end
    end)
  end

  defp adjust_work_orders(items, :sub) do
    items
    |> Enum.group_by(& &1.work_order_id)
    |> Enum.reduce_while(:ok, fn {wo_id, group}, :ok ->
      sub =
        group
        |> Enum.map(& &1.base_qty)
        |> Enum.reduce(Decimal.new(0), &Decimal.add/2)

      case SynieCore.Mfg.WorkOrder.adjust_received!(wo_id, Decimal.negate(sub)) do
        :ok -> {:cont, :ok}
        {:error, msg} -> {:halt, {:error, msg}}
      end
    end)
  end
end
