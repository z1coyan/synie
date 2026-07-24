defmodule SynieCore.Purchase.OutsourcedReceiptStatus do
  @moduledoc "委外入库单状态:草稿/已审核/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]

  def graphql_type(_), do: :pur_outsourced_receipt_status
end

defmodule SynieCore.Purchase.OutsourcedReceiptDraft do
  @moduledoc "校验委外入库单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿委外入库单可修改或删除"}
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedReceipt.HeadFieldsFrozen do
  @moduledoc """
  头关键字段变更闸:入库单已有行时,公司/对手不可再改——行上订单条目已锚定
  公司/对手/币种,改头会让既有行口径漂移。按实际值对比,不动这些字段的更新
  (备注/仓/科目/日期等)不受拦。仅挂 update。(同 Receipt.HeadFieldsFrozen 先例)
  """

  use Ash.Resource.Validation

  @fields [:party_type, :party_id, :company_id]

  @impl true
  def validate(changeset, _opts, _context) do
    if head_changed?(changeset) and
         SynieCore.Purchase.OutsourcedReceipt.has_items?(changeset.data.id) do
      {:error, message: "请先删除入库条目"}
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

defmodule SynieCore.Purchase.OutsourcedReceipt.OptionalOutsourcedWarehouseUsable do
  @moduledoc """
  头默认外协仓可空(仅材料扣减行带出预填);有值时必须绑定当前对手的外协仓
  (复用 `Inv.OutsourcedWarehouseUsable.check/4`)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    warehouse_id = Ash.Changeset.get_attribute(changeset, :outsourced_warehouse_id)

    if is_nil(warehouse_id) do
      :ok
    else
      case SynieCore.Inv.OutsourcedWarehouseUsable.check(
             warehouse_id,
             Ash.Changeset.get_attribute(changeset, :company_id),
             Ash.Changeset.get_attribute(changeset, :party_type),
             Ash.Changeset.get_attribute(changeset, :party_id)
           ) do
        :ok -> :ok
        {:error, message} -> {:error, field: :outsourced_warehouse_id, message: message}
      end
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedReceipt.FillDefaultAccounts do
  @moduledoc """
  建单按「公司默认过账科目」整组代入借贷科目(可改):借方 ← 默认入库借方,
  贷方 ← 默认入库贷方(未开票应付);无默认则留空,由必填校验兜底。
  仅挂 create;只填未显式给的槽位(手填优先)。(同 Reconciliation.FillDefaultAccounts 先例)
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    case company_id && SynieCore.Sales.CompanyAccountDefault.get_for_company(company_id) do
      nil ->
        changeset

      defaults ->
        changeset
        |> fill_if_blank(:debit_account_id, defaults.receipt_debit_account_id)
        |> fill_if_blank(:credit_account_id, defaults.receipt_credit_account_id)
    end
  end

  defp fill_if_blank(changeset, attribute, value) do
    if is_nil(Ash.Changeset.get_attribute(changeset, attribute)) and not is_nil(value) do
      Ash.Changeset.force_change_attribute(changeset, attribute, value)
    else
      changeset
    end
  end
end

defmodule SynieCore.Purchase.OutsourcedReceipt do
  @moduledoc """
  委外入库单(头),对应 `pur_outsourced_receipt` 表(ADR 2026-07-24-outsourced-purchase)。
  委外成品回库的履约入库单据:行必挂委外订单条目;财务行为完整镜像采购入库
  (借贷科目槽草稿保存即必填、按公司默认过账科目整组代入、贷方强制「未开票应付」
  角色、本币金额为零跳过总账、双币金额链按订单条目快照折算)。

  审核同一事务三个副作用同生同灭(单一 Stock.post!/cancel! 分录组):
  成品入本公司仓(正向)＋材料扣减(外协仓负向,不过总账)＋副产物入库
  (本公司仓正向,无金额);并累加订单条目已收数量(复用入库超收比例容差)、
  本币过账金额大于零时按借贷科目写总账(贷方带对手)。行冗余已对账数量进
  采购对账条目池;任一条目有非零已对账数量时不可作废。

  生命周期:草稿→已审核→(已作废);仅草稿可改可删;无反审核/红冲/关闭态;
  作废回滚全部库存分录、总账分录与已收数量投影,照常过负库存校验。
  单号全局唯一,留空按 `purchase.outsourced_receipt` 编号规则取号(独立系列
  随迁移种子,见 `SynieCore.Purchase.OutsourcedReceiptNumberingSeed`)。
  行见 `OutsourcedReceiptItem`(材料扣减行/副产物行挂其下)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "pur_outsourced_receipt"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :party_type, "party_pair",
        check: "(party_type IS NULL) = (party_id IS NULL)",
        message: "对手类型与对手必须同时填写"
    end
  end

  graphql do
    type :pur_outsourced_receipt
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
  def permission_label, do: "委外入库单"
  def permission_actions, do: ~w(create read update delete audit void)

  def grid_actions do
    [
      %{
        key: "audit",
        label: "审核",
        scope: "row",
        mutation: "auditPurOutsourcedReceipt",
        is_danger: false
      },
      %{
        key: "void",
        label: "作废",
        scope: "row",
        mutation: "voidPurOutsourcedReceipt",
        is_danger: true
      }
    ]
  end

  # fk 标签用入库单号(默认约定取 :name,本资源没有)
  def display_field, do: :receipt_no

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
        :receipt_no,
        :receipt_date,
        :posting_date,
        :party_type,
        :party_id,
        :warehouse_id,
        :outsourced_warehouse_id,
        :debit_account_id,
        :credit_account_id,
        :remarks
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Purchase.ReceiptPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}
      validate {SynieCore.Purchase.Receipt.OptionalWarehouseUsable, []}
      validate {SynieCore.Purchase.OutsourcedReceipt.OptionalOutsourcedWarehouseUsable, []}

      # 默认科目代入须先于必填校验(声明序即执行序,同 Reconciliation 先例)
      change {SynieCore.Purchase.OutsourcedReceipt.FillDefaultAccounts, []}

      validate {SynieCore.Purchase.Receipt.DebitAccountOk, []}
      validate {SynieCore.Purchase.Receipt.CreditAccountRole, []}

      change {SynieCore.Numbering.AutoNumber, attribute: :receipt_no}

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
        :receipt_no,
        :receipt_date,
        :posting_date,
        :party_type,
        :party_id,
        :warehouse_id,
        :outsourced_warehouse_id,
        :debit_account_id,
        :credit_account_id,
        :remarks
      ]

      require_atomic? false

      validate {SynieCore.Purchase.OutsourcedReceiptDraft, []}
      validate {SynieCore.Purchase.OutsourcedReceipt.HeadFieldsFrozen, []}
      validate {SynieCore.Purchase.ReceiptPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}
      validate {SynieCore.Purchase.Receipt.OptionalWarehouseUsable, []}
      validate {SynieCore.Purchase.OutsourcedReceipt.OptionalOutsourcedWarehouseUsable, []}
      validate {SynieCore.Purchase.Receipt.DebitAccountOk, []}
      validate {SynieCore.Purchase.Receipt.CreditAccountRole, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_receipt(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿委外入库单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Purchase.OutsourcedReceiptDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_receipt(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿委外入库单可修改或删除")
          end
        end)
      end
    end

    update :audit do
      accept [:posting_date]
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.status == :draft,
          do: :ok,
          else: {:error, message: "仅草稿委外入库单可审核"}
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
          # 权威复检:before_action 在动作事务内执行,FOR UPDATE 持锁到事务提交,
          # 借此串行化审核与行编辑/作废;锁内复检状态后派生分录并累加已收数量
          case __MODULE__.lock_receipt(cs.data.id) do
            {:ok, %{status: :draft} = locked} ->
              # 过账日期:有金额时必填;未传则默认入库日期
              cs = ensure_posting_date(cs, locked)

              case __MODULE__.fulfill!(cs, locked) do
                :ok -> cs
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿委外入库单可审核")
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
          else: {:error, message: "仅已审核委外入库单可作废"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_reconciled_items?(changeset.data.id) do
          {:error, message: "存在已对账条目,不可作废,请先撤回/作废相关采购对账单"}
        else
          :ok
        end
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          case __MODULE__.lock_receipt(cs.data.id) do
            {:ok, %{status: :audited} = locked} ->
              case __MODULE__.unfulfill!(cs, locked) do
                :ok -> cs
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅已审核委外入库单可作废")
          end
        end)
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :receipt_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "入库单号"
    end

    attribute :receipt_date, :date do
      allow_nil? false
      public? true
      default &Date.utc_today/0
      description "入库日期(库存分录业务日)"
    end

    attribute :posting_date, :date do
      public? true
      description "过账日期(总账;有金额审核时必填)"
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

    attribute :status, SynieCore.Purchase.OutsourcedReceiptStatus do
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
      description "默认入仓(可空,成品行/副产物行新建与带出预填)"
    end

    belongs_to :outsourced_warehouse, SynieCore.Inv.Warehouse do
      public? true
      attribute_public? true
      attribute_writable? true
      description "默认外协仓(可空,材料扣减行带出预填;限绑定当前对手)"
    end

    belongs_to :debit_account, SynieCore.Base.Account do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "借方科目(自选:存货/费用等;草稿必填)"
    end

    belongs_to :credit_account, SynieCore.Base.Account do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "贷方科目(未开票应付;草稿必填)"
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

    has_many :items, SynieCore.Purchase.OutsourcedReceiptItem do
      destination_attribute :receipt_id
      sort idx: :asc
      public? true
      description "入库条目"
    end
  end

  identities do
    identity :unique_receipt_no, [:receipt_no], message: "入库单号已存在"
  end

  @doc false
  def lock_receipt(receipt_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^receipt_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  def has_items?(receipt_id) do
    SynieCore.Purchase.OutsourcedReceiptItem
    |> Ash.Query.filter(receipt_id == ^receipt_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  # 任一条目存在非零已对账数量(被生效中采购对账单消耗)则整单不可作废
  def has_reconciled_items?(receipt_id) do
    SynieCore.Purchase.OutsourcedReceiptItem
    |> Ash.Query.filter(receipt_id == ^receipt_id and reconciled_qty > 0)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  def load_items(receipt_id) do
    SynieCore.Purchase.OutsourcedReceiptItem
    |> Ash.Query.filter(receipt_id == ^receipt_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  @doc false
  def load_material_rows(receipt_id) do
    SynieCore.Purchase.OutsourcedReceiptItemMaterial
    |> Ash.Query.filter(receipt_item.receipt_id == ^receipt_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  @doc false
  def load_byproduct_rows(receipt_id) do
    SynieCore.Purchase.OutsourcedReceiptItemByproduct
    |> Ash.Query.filter(receipt_item.receipt_id == ^receipt_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  # 审核履约:仓复检 + 超收校验 + 三副作用库存分录(同事务同分录组) + 可选总账 + 已收累加
  @doc false
  def fulfill!(changeset, receipt) do
    items = load_items(receipt.id)
    material_rows = load_material_rows(receipt.id)
    byproduct_rows = load_byproduct_rows(receipt.id)

    with :ok <- check_items_present(items),
         :ok <- check_warehouses(receipt, items, material_rows, byproduct_rows),
         :ok <- check_orders_and_overreceive(items),
         gl_amount <- gl_amount(items),
         :ok <- check_gl_prereqs(changeset, receipt, gl_amount),
         :ok <- post_stock(receipt, items, material_rows, byproduct_rows),
         :ok <- post_gl(changeset, receipt, gl_amount),
         :ok <- adjust_received(items, :add) do
      :ok
    end
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  # 作废:回滚库存/总账/已收(作废减库存,仍过负库存校验)
  @doc false
  def unfulfill!(_changeset, receipt) do
    items = load_items(receipt.id)

    with :ok <- check_not_reconciled(items),
         :ok <- cancel_stock(receipt),
         :ok <- cancel_gl(receipt),
         :ok <- adjust_received(items, :sub) do
      :ok
    end
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
  end

  # 权威复检(锁内):任一条目已被对账消耗则不可作废
  defp check_not_reconciled(items) do
    if Enum.any?(items, &(Decimal.compare(&1.reconciled_qty || Decimal.new(0), 0) == :gt)) do
      {:error, "存在已对账条目,不可作废,请先撤回/作废相关采购对账单"}
    else
      :ok
    end
  end

  defp ensure_posting_date(cs, locked) do
    posting =
      Ash.Changeset.get_attribute(cs, :posting_date) ||
        locked.posting_date ||
        locked.receipt_date

    Ash.Changeset.force_change_attribute(cs, :posting_date, posting)
  end

  defp check_items_present([]), do: {:error, "审核前必须至少填写一行入库条目"}
  defp check_items_present(_items), do: :ok

  # 锁内逐行复检三仓:成品行仓/副产物行仓走 WarehouseUsable,材料扣减行外协仓
  # 走 OutsourcedWarehouseUsable(绑定本单对手);带出行为空仓(头默认仓未填)在此报出
  defp check_warehouses(receipt, items, material_rows, byproduct_rows) do
    with :ok <- check_item_warehouses(items, receipt.company_id),
         :ok <- check_material_warehouses(material_rows, receipt),
         :ok <- check_byproduct_warehouses(byproduct_rows, receipt.company_id) do
      :ok
    end
  end

  defp check_item_warehouses(items, company_id) do
    Enum.reduce_while(items, :ok, fn item, :ok ->
      case SynieCore.Inv.WarehouseUsable.check(item.warehouse_id, company_id) do
        :ok -> {:cont, :ok}
        {:error, msg} -> {:halt, {:error, "第#{item.idx}行:#{msg}"}}
      end
    end)
  end

  defp check_material_warehouses(rows, receipt) do
    Enum.reduce_while(rows, :ok, fn row, :ok ->
      if is_nil(row.outsourced_warehouse_id) do
        {:halt, {:error, "材料扣减第#{row.idx}行:外协仓不能为空"}}
      else
        case SynieCore.Inv.OutsourcedWarehouseUsable.check(
               row.outsourced_warehouse_id,
               receipt.company_id,
               receipt.party_type,
               receipt.party_id
             ) do
          :ok -> {:cont, :ok}
          {:error, msg} -> {:halt, {:error, "材料扣减第#{row.idx}行:#{msg}"}}
        end
      end
    end)
  end

  defp check_byproduct_warehouses(rows, company_id) do
    Enum.reduce_while(rows, :ok, fn row, :ok ->
      if is_nil(row.warehouse_id) do
        {:halt, {:error, "副产物第#{row.idx}行:入仓不能为空"}}
      else
        case SynieCore.Inv.WarehouseUsable.check(row.warehouse_id, company_id) do
          :ok -> {:cont, :ok}
          {:error, msg} -> {:halt, {:error, "副产物第#{row.idx}行:#{msg}"}}
        end
      end
    end)
  end

  # 已收数量容差(口径同采购入库):累计已收(含本单) ≤ 订购 base × (1 + 入库超收比例)
  defp check_orders_and_overreceive(items) do
    ratio =
      case SynieCore.Sales.Setting.get() do
        %{receipt_overreceive_ratio: r} when not is_nil(r) -> r
        _ -> Decimal.new(0)
      end

    items
    |> Enum.group_by(& &1.order_item_id)
    |> Enum.reduce_while(:ok, fn {order_item_id, group}, :ok ->
      case check_one_order_item(order_item_id, group, ratio) do
        :ok -> {:cont, :ok}
        {:error, _} = err -> {:halt, err}
      end
    end)
  end

  defp check_one_order_item(order_item_id, group, ratio) do
    order_item =
      SynieCore.Purchase.OrderItem
      |> Ash.Query.filter(id == ^order_item_id)
      |> Ash.Query.lock("FOR UPDATE")
      |> Ash.read_one!(authorize?: false)

    order =
      SynieCore.Purchase.Order
      |> Ash.Query.filter(id == ^order_item.order_id)
      |> Ash.Query.lock("FOR UPDATE")
      |> Ash.read_one!(authorize?: false)

    cond do
      not order.is_outsourced ->
        {:error, "第#{hd(group).idx}行:仅委外订单条目可委外入库"}

      order.status != :audited ->
        {:error, "第#{hd(group).idx}行:订单未处于已审核状态,不可入库"}

      true ->
        add_base =
          group
          |> Enum.map(& &1.base_qty)
          |> Enum.reduce(Decimal.new(0), &Decimal.add/2)

        order_base = order_item.base_qty
        received = order_item.received_qty || Decimal.new(0)
        after_receive = Decimal.add(received, add_base)
        max_allowed = Decimal.mult(order_base, Decimal.add(Decimal.new(1), ratio))

        if Decimal.compare(after_receive, max_allowed) == :gt do
          {:error,
           "第#{hd(group).idx}行:超出入库容差(已收#{Decimal.to_string(received)}+本单#{Decimal.to_string(add_base)} > 订购#{Decimal.to_string(order_base)}×(1+#{Decimal.to_string(ratio)}))"}
        else
          :ok
        end
    end
  end

  # 过账金额:按订单条目快照本币含税金额 × 本行 base 占订购 base 比例汇总(同采购入库)
  defp gl_amount(items) do
    items
    |> Enum.map(fn item ->
      if Decimal.compare(item.order_base_qty, 0) == :eq do
        Decimal.new(0)
      else
        item.order_base_amount
        |> Decimal.mult(item.base_qty)
        |> Decimal.div(item.order_base_qty)
      end
    end)
    |> Enum.reduce(Decimal.new(0), &Decimal.add/2)
    |> Decimal.round(2)
  end

  defp check_gl_prereqs(changeset, receipt, gl_amount) do
    if Decimal.compare(gl_amount, 0) != :gt do
      :ok
    else
      debit =
        Ash.Changeset.get_attribute(changeset, :debit_account_id) || receipt.debit_account_id

      credit =
        Ash.Changeset.get_attribute(changeset, :credit_account_id) || receipt.credit_account_id

      posting =
        Ash.Changeset.get_attribute(changeset, :posting_date) || receipt.posting_date ||
          receipt.receipt_date

      cond do
        is_nil(posting) ->
          {:error, "有金额入库审核前必须填写过账日期"}

        is_nil(debit) ->
          {:error, "有金额入库审核前必须选择借方科目"}

        is_nil(credit) ->
          {:error, "有金额入库审核前必须选择贷方科目(未开票应付)"}

        true ->
          with :ok <-
                 SynieCore.Purchase.Receipt.DebitAccountOk.check_account(
                   debit,
                   receipt.company_id
                 ),
               :ok <-
                 SynieCore.Purchase.Receipt.CreditAccountRole.check_account(
                   credit,
                   receipt.company_id,
                   :unbilled_payable
                 ) do
            :ok
          else
            {:error, msg} -> {:error, msg}
          end
      end
    end
  end

  # 三副作用同一分录组:成品正(本公司仓)＋材料扣减负(外协仓)＋副产物正(本公司仓);
  # 单一 post! 同生同灭,负库存校验与 (仓,物料) 咨询锁在 Inv.Stock.post! 内
  defp post_stock(receipt, items, material_rows, byproduct_rows) do
    product_entries =
      Enum.map(items, fn item ->
        %{
          warehouse_id: item.warehouse_id,
          material_id: item.material_id,
          quantity: item.base_qty,
          remarks: receipt.remarks
        }
      end)

    material_entries =
      Enum.map(material_rows, fn row ->
        %{
          warehouse_id: row.outsourced_warehouse_id,
          material_id: row.material_id,
          quantity: Decimal.negate(row.base_qty),
          remarks: receipt.remarks
        }
      end)

    byproduct_entries =
      Enum.map(byproduct_rows, fn row ->
        %{
          warehouse_id: row.warehouse_id,
          material_id: row.material_id,
          quantity: row.base_qty,
          remarks: receipt.remarks
        }
      end)

    SynieCore.Inv.Stock.post!(
      %{
        voucher_type: "purchase.outsourced_receipt",
        voucher_id: receipt.id,
        voucher_no: receipt.receipt_no,
        company_id: receipt.company_id,
        posting_date: receipt.receipt_date
      },
      product_entries ++ material_entries ++ byproduct_entries
    )

    :ok
  end

  # 总账镜像采购入库:贷方(未开票应付)带对手,借方不带;金额为零跳过(科目仍草稿必填)
  defp post_gl(changeset, receipt, gl_amount) do
    if Decimal.compare(gl_amount, 0) != :gt do
      :ok
    else
      debit =
        Ash.Changeset.get_attribute(changeset, :debit_account_id) || receipt.debit_account_id

      credit =
        Ash.Changeset.get_attribute(changeset, :credit_account_id) || receipt.credit_account_id

      posting =
        Ash.Changeset.get_attribute(changeset, :posting_date) || receipt.posting_date ||
          receipt.receipt_date

      currencies =
        SynieCore.Base.Account
        |> Ash.Query.filter(id in ^[debit, credit])
        |> Ash.read!(authorize?: false)
        |> Map.new(&{&1.id, &1.currency_id})

      zero = Decimal.new(0)

      entries = [
        %{
          account_id: debit,
          currency_id: currencies[debit],
          debit: gl_amount,
          credit: zero,
          party_type: nil,
          party_id: nil,
          remarks: nil
        },
        %{
          account_id: credit,
          currency_id: currencies[credit],
          debit: zero,
          credit: gl_amount,
          party_type: receipt.party_type,
          party_id: receipt.party_id,
          remarks: nil
        }
      ]

      SynieCore.Acc.GL.post!(
        %{
          voucher_type: "purchase.outsourced_receipt",
          voucher_id: receipt.id,
          voucher_no: receipt.receipt_no,
          company_id: receipt.company_id,
          posting_date: posting
        },
        entries
      )

      :ok
    end
  end

  defp cancel_stock(receipt) do
    SynieCore.Inv.Stock.cancel!("purchase.outsourced_receipt", receipt.id)
    :ok
  end

  defp cancel_gl(receipt) do
    # 零金额入库无总账分录,cancel! 空集亦成功
    SynieCore.Acc.GL.cancel!("purchase.outsourced_receipt", receipt.id)
    :ok
  end

  defp adjust_received(items, direction) do
    items
    |> Enum.group_by(& &1.order_item_id)
    |> Enum.each(fn {order_item_id, group} ->
      delta =
        group
        |> Enum.map(& &1.base_qty)
        |> Enum.reduce(Decimal.new(0), &Decimal.add/2)

      delta = if direction == :sub, do: Decimal.negate(delta), else: delta

      order_item =
        SynieCore.Purchase.OrderItem
        |> Ash.Query.filter(id == ^order_item_id)
        |> Ash.Query.lock("FOR UPDATE")
        |> Ash.read_one!(authorize?: false)

      order_item
      |> Ash.Changeset.for_update(:adjust_received_qty, %{delta: delta})
      |> Ash.update!(authorize?: false)
    end)

    :ok
  end
end
