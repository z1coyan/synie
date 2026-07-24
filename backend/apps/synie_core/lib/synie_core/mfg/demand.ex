defmodule SynieCore.Mfg.DemandStatus do
  @moduledoc "履约需求单状态:草稿/已确认/已关闭/已作废。"

  use Ash.Type.Enum,
    values: [draft: "草稿", confirmed: "已确认", closed: "已关闭", voided: "已作废"]

  def graphql_type(_), do: :mfg_demand_status
end

defmodule SynieCore.Mfg.DemandDraft do
  @moduledoc "校验需求单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿履约需求单可修改或删除"}
    end
  end
end

defmodule SynieCore.Mfg.Demand.NoActiveWorkOrders do
  @moduledoc "作废前提:不存在未作废生产工单(避免断链孤儿)。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    if SynieCore.Mfg.Demand.has_active_work_orders?(changeset.data.id) do
      {:error, message: "存在未作废生产工单,不可作废需求单"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Mfg.Demand do
  @moduledoc """
  履约需求单(头),对应 `mfg_demand` 表。销售承诺与车间/采购执行之间的内部需求
  中间层:计划从销售订单条目勾选纳入或手工建独立需求;确认后锁口径,下游按行
  履约方式分流(自制→生产工单,外购/委外/库存→计划点完成)。

  生命周期:草稿 → 已确认 → 已关闭;另可作废(仅无未作废工单时)。
  仅草稿可改可删;关闭后不可再生成工单或点完成。
  单号全局唯一,留空按 `mfg.demand` 编号规则取号。行见 `DemandItem`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "mfg_demand"
    repo SynieCore.Repo
  end

  graphql do
    type :mfg_demand
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

  def permission_prefix, do: "mfg.demand"
  def permission_label, do: "履约需求单"
  def permission_actions, do: ~w(create read update delete confirm close void)

  def grid_actions do
    [
      %{
        key: "confirm",
        label: "确认",
        scope: "row",
        mutation: "confirmMfgDemand",
        is_danger: false
      },
      %{key: "close", label: "关闭", scope: "row", mutation: "closeMfgDemand", is_danger: false},
      %{key: "void", label: "作废", scope: "row", mutation: "voidMfgDemand", is_danger: true}
    ]
  end

  def display_field, do: :demand_no

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
      accept [:company_id, :demand_no, :demand_date, :remarks]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Numbering.AutoNumber, attribute: :demand_no}

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
      accept [:demand_no, :demand_date, :remarks]
      require_atomic? false

      validate {SynieCore.Mfg.DemandDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_demand(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿履约需求单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Mfg.DemandDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_demand(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿履约需求单可修改或删除")
          end
        end)
      end
    end

    update :confirm do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.status == :draft,
          do: :ok,
          else: {:error, message: "仅草稿履约需求单可确认"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "确认前必须至少填写一行需求行"}
        end
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :confirmed)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_demand(cs.data.id) do
            {:ok, %{status: :draft}} ->
              if __MODULE__.has_items?(cs.data.id) do
                cs
              else
                Ash.Changeset.add_error(cs, message: "确认前必须至少填写一行需求行")
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿履约需求单可确认")
          end
        end)
      end
    end

    update :close do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.status == :confirmed,
          do: :ok,
          else: {:error, message: "仅已确认履约需求单可关闭"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :closed)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_demand(cs.data.id) do
            {:ok, %{status: :confirmed}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已确认履约需求单可关闭")
          end
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.status in [:draft, :confirmed],
          do: :ok,
          else: {:error, message: "仅草稿或已确认履约需求单可作废"}
      end

      validate {SynieCore.Mfg.Demand.NoActiveWorkOrders, []}

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_demand(cs.data.id) do
            {:ok, %{status: status}} when status in [:draft, :confirmed] ->
              if __MODULE__.has_active_work_orders?(cs.data.id) do
                Ash.Changeset.add_error(cs, message: "存在未作废生产工单,不可作废需求单")
              else
                cs
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿或已确认履约需求单可作废")
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :demand_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "需求单号"
    end

    attribute :demand_date, :date do
      allow_nil? false
      public? true
      default &Date.utc_today/0
      description "业务日期"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "备注"
    end

    attribute :status, SynieCore.Mfg.DemandStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
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

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end

    has_many :items, SynieCore.Mfg.DemandItem do
      destination_attribute :demand_id
      sort idx: :asc
      public? true
      description "需求行"
    end
  end

  identities do
    identity :unique_demand_no, [:demand_no], message: "需求单号已存在"
  end

  @doc false
  def lock_demand(demand_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^demand_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  def has_items?(demand_id) do
    SynieCore.Mfg.DemandItem
    |> Ash.Query.filter(demand_id == ^demand_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  def has_active_work_orders?(demand_id) do
    SynieCore.Mfg.WorkOrder
    |> Ash.Query.filter(demand_id == ^demand_id and status != :voided)
    |> Ash.exists?(authorize?: false)
  end
end
