defmodule SynieCore.Purchase.ReceiptStatus do
  @moduledoc "采购入库单状态:草稿/已审核/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]

  def graphql_type(_), do: :pur_receipt_status
end

defmodule SynieCore.Purchase.ReceiptDraft do
  @moduledoc "校验入库单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿采购入库单可修改或删除"}
    end
  end
end

defmodule SynieCore.Purchase.ReceiptPartyType do
  @moduledoc "入库单对手类型限供应商/内部公司(与采购订单一致)。"

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

defmodule SynieCore.Purchase.Receipt.HeadFieldsFrozen do
  @moduledoc """
  头关键字段变更闸:入库单已有行时,公司/对手不可再改——行上订单条目已锚定
  公司/对手/币种,改头会让既有行口径漂移。按实际值对比,不动这些字段的更新
  (备注/仓/科目/日期等)不受拦。仅挂 update。
  """

  use Ash.Resource.Validation

  @fields [:party_type, :party_id, :company_id]

  @impl true
  def validate(changeset, _opts, _context) do
    if head_changed?(changeset) and SynieCore.Purchase.Receipt.has_items?(changeset.data.id) do
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

defmodule SynieCore.Purchase.Receipt.OptionalWarehouseUsable do
  @moduledoc """
  头仓可空(仅新建行预填);有值时必须本公司启用叶子仓(WarehouseUsable 同款)。
  """

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

defmodule SynieCore.Purchase.Receipt.DebitAccountOk do
  @moduledoc "借方科目必填,须本公司、启用、非汇总(不强制角色,存货/费用等会计自选)。草稿保存即校验。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :debit_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      {:error, field: :debit_account_id, message: "借方科目不能为空"}
    else
      case check_account(account_id, company_id) do
        :ok -> :ok
        {:error, message} -> {:error, field: :debit_account_id, message: message}
      end
    end
  end

  @doc false
  def check_account(account_id, company_id) do
    case Ash.get(SynieCore.Base.Account, account_id, authorize?: false) do
      {:ok, %{company_id: ^company_id, is_group: true}} ->
        {:error, "不能选择汇总科目"}

      {:ok, %{company_id: ^company_id, active: false}} ->
        {:error, "科目已停用"}

      {:ok, %{company_id: ^company_id}} ->
        :ok

      {:ok, _} ->
        {:error, "科目不属于本公司"}

      {:error, _} ->
        {:error, "科目不存在"}
    end
  end
end

defmodule SynieCore.Purchase.Receipt.CreditAccountRole do
  @moduledoc """
  贷方科目必填,必须挂「未开票应付」角色(ADR 2026-07-20-purchase-line / 2026-07-21);
  另须本公司、启用、非汇总。草稿保存即校验(与零金额是否过账无关)。
  """

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    account_id = Ash.Changeset.get_attribute(changeset, :credit_account_id)
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if is_nil(account_id) do
      {:error, field: :credit_account_id, message: "贷方科目不能为空"}
    else
      case check_account(account_id, company_id, :unbilled_payable) do
        :ok -> :ok
        {:error, message} -> {:error, field: :credit_account_id, message: message}
      end
    end
  end

  @doc false
  def check_account(account_id, company_id, required_role) do
    case Ash.get(SynieCore.Base.Account, account_id, authorize?: false) do
      {:ok, %{company_id: ^company_id, is_group: true}} ->
        {:error, "不能选择汇总科目"}

      {:ok, %{company_id: ^company_id, active: false}} ->
        {:error, "科目已停用"}

      {:ok, %{company_id: ^company_id, role: ^required_role}} ->
        :ok

      {:ok, %{company_id: ^company_id}} ->
        {:error, "贷方科目必须为未开票应付角色"}

      {:ok, _} ->
        {:error, "科目不属于本公司"}

      {:error, _} ->
        {:error, "科目不存在"}
    end
  end
end

defmodule SynieCore.Purchase.Receipt.ClearItemDrawings do
  @moduledoc """
  删入库单前显式清理所有行的图纸挂接:入库单删行走 DB 级联
  (receipt_item postgres reference on_delete: :delete),ReceiptItem 的
  destroy 钩子不触发,不清会让挂接的 sys_file 被 AttachmentGuard 永久锁死。
  before_action 在动作事务内执行,清理与删单同生共死。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      cs.data.id
      |> item_ids()
      |> Enum.each(&SynieCore.Purchase.ReceiptItem.ClearDrawings.clear!/1)

      cs
    end)
  end

  defp item_ids(receipt_id) do
    SynieCore.Purchase.ReceiptItem
    |> Ash.Query.filter(receipt_id == ^receipt_id)
    |> Ash.read!(authorize?: false)
    |> Enum.map(& &1.id)
  end
end

defmodule SynieCore.Purchase.Receipt do
  @moduledoc """
  采购入库单(头),对应 `pur_receipt` 表。履约入库事实:审核同一事务内写正向
  库存分录、累加订单条目已收数量,本币过账金额大于零时按借贷科目写总账
  (贷方强制未开票应付角色、借方自选,贷方行带对手)。与销售发货逐点对称
  (借贷镜像),详见 docs/adr/2026-07-20-purchase-line.md。

  生命周期:草稿→已审核→(已作废);仅草稿可改可删;无反审核/红冲/关闭态。
  单号全局唯一,留空按 `purchase.receipt` 编号规则取号。行见 `ReceiptItem`。
  内部公司对手只记买方账,不自动镜像卖方出库。删单前须清理行图纸挂接
  (见 `ClearItemDrawings`)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "pur_receipt"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :party_type, "party_pair",
        check: "(party_type IS NULL) = (party_id IS NULL)",
        message: "对手类型与对手必须同时填写"
    end
  end

  graphql do
    type :pur_receipt
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
  def permission_actions, do: ~w(create read update delete audit void)

  def grid_actions do
    [
      %{key: "audit", label: "审核", scope: "row", mutation: "auditPurReceipt", is_danger: false},
      %{key: "void", label: "作废", scope: "row", mutation: "voidPurReceipt", is_danger: true}
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
        :debit_account_id,
        :credit_account_id,
        :remarks
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Purchase.ReceiptPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}
      validate {SynieCore.Purchase.Receipt.OptionalWarehouseUsable, []}
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
      accept [
        :receipt_no,
        :receipt_date,
        :posting_date,
        :party_type,
        :party_id,
        :warehouse_id,
        :debit_account_id,
        :credit_account_id,
        :remarks
      ]

      require_atomic? false

      validate {SynieCore.Purchase.ReceiptDraft, []}
      validate {SynieCore.Purchase.Receipt.HeadFieldsFrozen, []}
      validate {SynieCore.Purchase.ReceiptPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}
      validate {SynieCore.Purchase.Receipt.OptionalWarehouseUsable, []}
      validate {SynieCore.Purchase.Receipt.DebitAccountOk, []}
      validate {SynieCore.Purchase.Receipt.CreditAccountRole, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_receipt(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿采购入库单可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      validate {SynieCore.Purchase.ReceiptDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          case __MODULE__.lock_receipt(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿采购入库单可修改或删除")
          end
        end)
      end

      # 行由 DB 级联删除(不走 ReceiptItem destroy 钩子),行的图纸挂接须在此显式清
      change {SynieCore.Purchase.Receipt.ClearItemDrawings, []}
    end

    update :audit do
      accept [:posting_date]
      require_atomic? false

      validate fn changeset, _context ->
        if changeset.data.status == :draft,
          do: :ok,
          else: {:error, message: "仅草稿采购入库单可审核"}
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
          case __MODULE__.lock_receipt(cs.data.id) do
            {:ok, %{status: :draft} = locked} ->
              # 过账日期:有金额时必填;未传则默认入库日期
              cs = ensure_posting_date(cs, locked)

              case __MODULE__.fulfill!(cs, locked) do
                :ok -> cs
                {:error, message} -> Ash.Changeset.add_error(cs, message: message)
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿采购入库单可审核")
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
          else: {:error, message: "仅已审核采购入库单可作废"}
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
              Ash.Changeset.add_error(cs, message: "仅已审核采购入库单可作废")
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
      description "对手类型(供应商/内部公司)"
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

    attribute :status, SynieCore.Purchase.ReceiptStatus do
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

    has_many :items, SynieCore.Purchase.ReceiptItem do
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
    SynieCore.Purchase.ReceiptItem
    |> Ash.Query.filter(receipt_id == ^receipt_id)
    |> Ash.exists?(authorize?: false)
  end

  @doc false
  def load_items(receipt_id) do
    SynieCore.Purchase.ReceiptItem
    |> Ash.Query.filter(receipt_id == ^receipt_id)
    |> Ash.Query.sort(idx: :asc)
    |> Ash.read!(authorize?: false)
  end

  # 审核履约:超收校验 + 已收累加 + 库存入库 + 可选总账
  @doc false
  def fulfill!(changeset, receipt) do
    items = load_items(receipt.id)

    with :ok <- check_items_present(items),
         :ok <- check_warehouses(items, receipt.company_id),
         :ok <- check_orders_and_overreceive(items),
         gl_amount <- gl_amount(items),
         :ok <- check_gl_prereqs(changeset, receipt, gl_amount),
         :ok <- post_stock(receipt, items),
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

    with :ok <- cancel_stock(receipt),
         :ok <- cancel_gl(receipt),
         :ok <- adjust_received(items, :sub) do
      :ok
    end
  rescue
    e in ArgumentError -> {:error, Exception.message(e)}
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

  defp check_warehouses(items, company_id) do
    Enum.reduce_while(items, :ok, fn item, :ok ->
      case SynieCore.Inv.WarehouseUsable.check(item.warehouse_id, company_id) do
        :ok -> {:cont, :ok}
        {:error, msg} -> {:halt, {:error, "第#{item.idx}行:#{msg}"}}
      end
    end)
  end

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

  defp post_stock(receipt, items) do
    SynieCore.Inv.Stock.post!(
      %{
        voucher_type: "purchase.receipt",
        voucher_id: receipt.id,
        voucher_no: receipt.receipt_no,
        company_id: receipt.company_id,
        posting_date: receipt.receipt_date
      },
      Enum.map(items, fn item ->
        %{
          warehouse_id: item.warehouse_id,
          material_id: item.material_id,
          quantity: item.base_qty,
          remarks: receipt.remarks
        }
      end)
    )

    :ok
  end

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

      # 与销售发货借贷镜像:贷方(未开票应付)带对手,借方不带
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
          voucher_type: "purchase.receipt",
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
    SynieCore.Inv.Stock.cancel!("purchase.receipt", receipt.id)
    :ok
  end

  defp cancel_gl(receipt) do
    # 零金额入库无总账分录,cancel! 空集亦成功
    SynieCore.Acc.GL.cancel!("purchase.receipt", receipt.id)
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
