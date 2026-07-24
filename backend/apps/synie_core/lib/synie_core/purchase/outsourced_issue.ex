defmodule SynieCore.Purchase.OutsourcedIssueStatus do
  @moduledoc "委外发料单状态:草稿/已审核/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]

  def graphql_type(_), do: :pur_outsourced_issue_status
end

defmodule SynieCore.Purchase.OutsourcedIssueDraft do
  @moduledoc "校验委外发料单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿委外发料单可修改或删除"}
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedIssuePartyType do
  @moduledoc "发料单对手类型限供应商/内部公司(与委外订单一致)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :party_type) do
      nil -> :ok
      t when t in [:supplier, :company] -> :ok
      _ -> {:error, field: :party_type, message: "对手类型只能为供应商或内部公司"}
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedIssue.HeadFieldsFrozen do
  @moduledoc """
  头关键字段变更闸:发料单已有行时,公司/对手不可再改——行上发料清单行已锚定
  公司/对手,改头会让既有行口径漂移。按实际值对比,不动这些字段的更新
  (备注/头仓/日期等)不受拦。仅挂 update。(同 Receipt.HeadFieldsFrozen 先例)
  """

  use Ash.Resource.Validation

  @fields [:party_type, :party_id, :company_id]

  @impl true
  def validate(changeset, _opts, _context) do
    if head_changed?(changeset) and SynieCore.Purchase.OutsourcedIssue.has_items?(changeset.data.id) do
      {:error, message: "请先删除发料条目"}
    else
      :ok
    end
  end

  defp head_changed?(changeset) do
    Enum.any?(@fields, fn field ->
      Ash.Changeset.get_attribute(changeset, field) != Map.get(changeset.data, field)
    end)
  end
end

defmodule SynieCore.Purchase.OutsourcedIssue.OptionalFromWarehouseUsable do
  @moduledoc """
  头调出仓可空(仅新建行预填);有值时必须本公司启用叶子仓(WarehouseUsable 同款)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    warehouse_id = Ash.Changeset.get_attribute(changeset, :from_warehouse_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(warehouse_id) do
      :ok
    else
      case SynieCore.Inv.WarehouseUsable.check(warehouse_id, company_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: :from_warehouse_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedIssue do
  @moduledoc """
  委外发料单(头),对应 `pur_outsourced_issue` 表(ADR 2026-07-24-outsourced-purchase)。
  对协作方的委外材料发出单据:无金额、不过总账(仓间移动、所有权不变,
  同手工调拨不生凭证先例)。行必挂委外订单条目的发料清单行,可跨多张
  同公司同对手委外订单取行。

  生命周期:草稿→已审核→(已作废);仅草稿可改可删;无反审核/红冲/关闭态。
  审核同一事务写「调出仓负＋外协仓正」库存分录(voucher_type
  `purchase.outsourced_issue`)并累加发料清单行已发料量;超发不硬拦(无容差
  设置),超额仅展示;作废回滚分录与已发料量,照常过负库存校验。
  单号全局唯一,留空按 `purchase.outsourced_issue` 编号规则取号(独立系列
  随迁移种子,见 `SynieCore.Purchase.OutsourcedIssueNumberingSeed`)。
  行见 `OutsourcedIssueItem`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "pur_outsourced_issue"
    repo SynieCore.Repo
  end

  graphql do
    type :pur_outsourced_issue
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
  def permission_label, do: "委外发料单"
  def permission_actions, do: ~w(create read update delete audit void)

  def grid_actions do
    [
      %{
        key: "audit",
        label: "审核",
        scope: "row",
        mutation: "auditPurOutsourcedIssue",
        is_danger: false
      },
      %{
        key: "void",
        label: "作废",
        scope: "row",
        mutation: "voidPurOutsourcedIssue",
        is_danger: true
      }
    ]
  end

  # fk 标签用发料单号(默认约定取 :name,本资源没有)
  def display_field, do: :issue_no

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
    end

    create :create do
      accept [
        :company_id,
        :issue_no,
        :issue_date,
        :party_type,
        :party_id,
        :from_warehouse_id,
        :outsourced_warehouse_id,
        :remarks
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Purchase.OutsourcedIssuePartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}
      validate {SynieCore.Purchase.OutsourcedIssue.OptionalFromWarehouseUsable, []}
      validate {SynieCore.Inv.OutsourcedWarehouseUsable, []}

      change {SynieCore.Numbering.AutoNumber, attribute: :issue_no}

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
      # 不接受 company_id:单据公司创建后不可换(同采购入库先例)
      accept [
        :issue_no,
        :issue_date,
        :party_type,
        :party_id,
        :from_warehouse_id,
        :outsourced_warehouse_id,
        :remarks
      ]

      require_atomic? false

      validate {SynieCore.Purchase.OutsourcedIssueDraft, []}
      validate {SynieCore.Purchase.OutsourcedIssue.HeadFieldsFrozen, []}
      validate {SynieCore.Purchase.OutsourcedIssuePartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}
      validate {SynieCore.Purchase.OutsourcedIssue.OptionalFromWarehouseUsable, []}
      validate {SynieCore.Inv.OutsourcedWarehouseUsable, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_issue(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿委外发料单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Purchase.OutsourcedIssueDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_issue(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿委外发料单可修改或删除")
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
          else: {:error, message: "仅草稿委外发料单可审核"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "审核前必须至少填写一行发料条目"}
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
          # 权威复检:before_action 在动作事务内执行,FOR UPDATE 持锁到事务提交,
          # 借此串行化审核与行编辑/作废;锁内复检状态后派生分录并累加已发料量
          # (同事务,负库存校验与 (仓,物料) 咨询锁在 Inv.Stock.post! 内)
          case __MODULE__.lock_issue(cs.data.id) do
            {:ok, %{status: :draft} = locked} ->
              case __MODULE__.fulfill!(locked) do
                :ok -> cs
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿委外发料单可审核")
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
          else: {:error, message: "仅已审核委外发料单可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_issue(cs.data.id) do
            {:ok, %{status: :audited} = locked} ->
              case __MODULE__.unfulfill!(locked) do
                :ok -> cs
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅已审核委外发料单可作废")
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :issue_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "发料单号"
    end

    attribute :issue_date, :date do
      allow_nil? false
      public? true
      default &Date.utc_today/0
      description "发料日期(库存分录业务日)"
    end

    attribute :party_type, SynieCore.Acc.PartyType do
      allow_nil? false
      public? true
      description "对手类型(供应商/内部公司,须与所引委外订单一致)"
    end

    attribute :party_id, :uuid do
      allow_nil? false
      public? true
      description "对手"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "备注(对内;可带入库存分录)"
    end

    attribute :status, SynieCore.Purchase.OutsourcedIssueStatus do
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

    belongs_to :from_warehouse, SynieCore.Inv.Warehouse do
      public? true
      attribute_public? true
      attribute_writable? true
      description "默认调出仓(可空,仅新建行预填)"
    end

    belongs_to :outsourced_warehouse, SynieCore.Inv.Warehouse do
      public? true
      attribute_public? true
      attribute_writable? true
      description "默认外协仓(可空,仅新建行预填)"
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

    has_many :items, SynieCore.Purchase.OutsourcedIssueItem do
      destination_attribute :issue_id
      sort idx: :asc
      public? true
      description "发料条目"
    end
  end

  identities do
    identity :unique_issue_no, [:issue_no], message: "发料单号已存在"
  end

  @doc false
  def lock_issue(issue_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^issue_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  def has_items?(issue_id) do
    SynieCore.Purchase.OutsourcedIssueItem
    |> Ash.Query.filter(issue_id == ^issue_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  def load_items(issue_id) do
    SynieCore.Purchase.OutsourcedIssueItem
    |> Ash.Query.filter(issue_id == ^issue_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  # 审核履约:行仓复检 + 订单状态权威复检 + 库存移动 + 已发料量累加
  @doc false
  def fulfill!(issue) do
    items = load_items(issue.id)

    with :ok <- check_items_present(items),
         :ok <- check_warehouses(items, issue),
         :ok <- check_orders(items, issue),
         :ok <- post_stock(issue, items),
         :ok <- adjust_issued(items, :add) do
      :ok
    end
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  # 作废:回滚库存分录与已发料量(作废减库存,仍过负库存校验)
  @doc false
  def unfulfill!(issue) do
    items = load_items(issue.id)

    with :ok <- cancel_stock(issue),
         :ok <- adjust_issued(items, :sub) do
      :ok
    end
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  defp check_items_present([]), do: {:error, "审核前必须至少填写一行发料条目"}
  defp check_items_present(_items), do: :ok

  # 锁内逐行复检两仓:调出仓走 WarehouseUsable(停用「拦新不拦旧」,审核只认
  # 存在/同公司/叶子的结构约束由 Inv.Stock.post! 兜底,此处同采购入库先例按保存口径复检)
  defp check_warehouses(items, issue) do
    Enum.reduce_while(items, :ok, fn item, :ok ->
      with :ok <- check_from_warehouse(item, issue),
           :ok <- check_outsourced_warehouse(item, issue) do
        {:cont, :ok}
      else
        {:error, msg} -> {:halt, {:error, "第#{item.idx}行:#{msg}"}}
      end
    end)
  end

  defp check_from_warehouse(item, issue) do
    case SynieCore.Inv.WarehouseUsable.check(item.from_warehouse_id, issue.company_id) do
      :ok -> :ok
      {:error, msg} -> {:error, msg}
    end
  end

  defp check_outsourced_warehouse(item, issue) do
    case SynieCore.Inv.OutsourcedWarehouseUsable.check(
           item.outsourced_warehouse_id,
           issue.company_id,
           issue.party_type,
           issue.party_id
         ) do
      :ok -> :ok
      {:error, msg} -> {:error, msg}
    end
  end

  # 权威复检(锁内):发料清单行所属订单仍已审核且公司/对手与本单一致
  # (行保存时已校验,此处防行保存后订单被作废/关闭)
  defp check_orders(items, issue) do
    items
    |> Enum.group_by(& &1.order_item_material_id)
    |> Enum.reduce_while(:ok, fn {line_id, group}, :ok ->
      line =
        SynieCore.Purchase.OrderItemMaterial
        |> Ash.Query.filter(id == ^line_id)
        |> Ash.Query.lock("FOR UPDATE")
        |> Ash.read_one!(authorize?: false)

      order_item = Ash.get!(SynieCore.Purchase.OrderItem, line.order_item_id, authorize?: false)

      order =
        SynieCore.Purchase.Order
        |> Ash.Query.filter(id == ^order_item.order_id)
        |> Ash.Query.lock("FOR UPDATE")
        |> Ash.read_one!(authorize?: false)

      idx = hd(group).idx

      cond do
        order.status != :audited ->
          {:halt, {:error, "第#{idx}行:订单未处于已审核状态,不可发料"}}

        order.company_id != issue.company_id ->
          {:halt, {:error, "第#{idx}行:订单公司与发料单不一致"}}

        order.party_type != issue.party_type or order.party_id != issue.party_id ->
          {:halt, {:error, "第#{idx}行:订单对手与发料单不一致"}}

        true ->
          {:cont, :ok}
      end
    end)
  end

  # 审核派生分录:逐行「调出仓负＋外协仓正」;备注带入分录 remarks
  defp post_stock(issue, items) do
    entries =
      Enum.flat_map(items, fn item ->
        [
          %{
            warehouse_id: item.from_warehouse_id,
            material_id: item.material_id,
            quantity: Decimal.negate(item.base_qty),
            remarks: issue.remarks
          },
          %{
            warehouse_id: item.outsourced_warehouse_id,
            material_id: item.material_id,
            quantity: item.base_qty,
            remarks: issue.remarks
          }
        ]
      end)

    SynieCore.Inv.Stock.post!(
      %{
        voucher_type: "purchase.outsourced_issue",
        voucher_id: issue.id,
        voucher_no: issue.issue_no,
        company_id: issue.company_id,
        posting_date: issue.issue_date
      },
      entries
    )

    :ok
  end

  defp cancel_stock(issue) do
    SynieCore.Inv.Stock.cancel!("purchase.outsourced_issue", issue.id)
    :ok
  end

  # 已发料量受控投影:按发料清单行分组汇总(默认单位口径),审核加/作废减;
  # 超发不硬拦(无容差设置),超额仅展示
  defp adjust_issued(items, direction) do
    items
    |> Enum.group_by(& &1.order_item_material_id)
    |> Enum.each(fn {line_id, group} ->
      delta =
        group
        |> Enum.map(& &1.base_qty)
        |> Enum.reduce(Decimal.new(0), &Decimal.add/2)

      delta = if direction == :sub, do: Decimal.negate(delta), else: delta

      line =
        SynieCore.Purchase.OrderItemMaterial
        |> Ash.Query.filter(id == ^line_id)
        |> Ash.Query.lock("FOR UPDATE")
        |> Ash.read_one!(authorize?: false)

      line
      |> Ash.Changeset.for_update(:adjust_issued_qty, %{delta: delta})
      |> Ash.update!(authorize?: false)
    end)

    :ok
  end
end
