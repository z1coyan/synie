defmodule SynieCore.Sales.OrderItem.SyncOrder do
  @moduledoc """
  行与父订单同步:订单必须存在且草稿态(增删改行的前提);
  create 时把订单 company_id 冗余到行(数据权限按公司过滤依赖此列)。

  构建期预检仅为友好报错(此时在动作事务之外,加锁不生效,故用普通读);
  create 时顺带回填 company_id——CompanyAccessible 的声明顺序依赖它,必须在构建期完成。
  权威复检在 before_action 钩子内进行:before_action 在动作事务内执行,FOR UPDATE
  持锁到事务提交,借此串行化行编辑与审核/关闭/作废,关闭构建期预检看到 stale 状态的竞态窗口。
  (同 GlJournalLine.SyncJournal 先例)
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    order_id = changeset_order_id(changeset)

    changeset =
      case read_order(order_id) do
        {:ok, %{status: :draft} = order} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, order.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :order_id, message: "订单不存在")

        {:ok, _order} ->
          Ash.Changeset.add_error(changeset, field: :order_id, message: "仅草稿订单可编辑条目")

        _ ->
          Ash.Changeset.add_error(changeset, field: :order_id, message: "订单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_order(changeset_order_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :order_id, message: "订单不存在")

        _ ->
          Ash.Changeset.add_error(cs, field: :order_id, message: "仅草稿订单可编辑条目")
      end
    end)
  end

  defp changeset_order_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :order_id) || changeset.data.order_id

  defp read_order(nil), do: {:ok, nil}

  defp read_order(order_id) do
    SynieCore.Sales.Order
    |> Ash.Query.filter(id == ^order_id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_order(nil), do: {:ok, nil}

  defp lock_order(order_id) do
    SynieCore.Sales.Order
    |> Ash.Query.filter(id == ^order_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Sales.OrderItem.DeriveQuotation do
  @moduledoc """
  按订单分型建行(构建期,在 ComputeAmount/SnapshotMaterial 之前跑):

  常规订单——必须挂有效报价条目(报价单已审核+订单日期在报价区间+公司/对手/币种一致,
  与审核复核同款判定,见 `Sales.QuotationLink`);物料/单位/单价由报价条目强制派生
  (忽略用户传值):固定价取报价单价,数量梯度按行数量套档(低于首档起订量无报价);
  税率用户未显式传时取报价条目税率;qty 变化(update)时重新套档派生 price。
  样品订单——不得挂报价条目,数量受 `sal_setting` 样品上限约束;
  物料/单位/单价走现状逻辑(MaterialUnitAllowed 等不动)。

  订单读不到时跳过,由 SyncOrder 兜底报错;强制派生只在值不同时才落 change,
  避免备注类更新在审计日志留下 material/unit/price 的假变更。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Sales.QuotationLink

  @impl true
  def change(changeset, _opts, _context) do
    order_id = Ash.Changeset.get_attribute(changeset, :order_id) || changeset.data.order_id

    case read_order(order_id) do
      {:ok, %{order_type: :regular} = order} -> derive_regular(changeset, order)
      {:ok, %{order_type: :sample}} -> validate_sample(changeset)
      _ -> changeset
    end
  end

  defp derive_regular(changeset, order) do
    case Ash.Changeset.get_attribute(changeset, :quotation_item_id) do
      nil ->
        Ash.Changeset.add_error(changeset,
          field: :quotation_item_id,
          message: "常规订单条目必须选择报价条目"
        )

      quotation_item_id ->
        case QuotationLink.load_item(quotation_item_id) do
          :error ->
            Ash.Changeset.add_error(changeset,
              field: :quotation_item_id,
              message: "报价条目不存在"
            )

          {:ok, quotation_item, quotation} ->
            case QuotationLink.check(order, quotation) do
              :ok ->
                derive_from_item(changeset, quotation_item)

              {:error, message} ->
                Ash.Changeset.add_error(changeset, field: :quotation_item_id, message: message)
            end
        end
    end
  end

  defp derive_from_item(changeset, quotation_item) do
    changeset
    |> force_if_different(:material_id, quotation_item.material_id)
    |> force_if_different(:unit_id, quotation_item.unit_id)
    |> derive_price(quotation_item)
    |> derive_tax_rate(quotation_item)
  end

  defp derive_price(changeset, %{pricing_mode: :fixed} = quotation_item) do
    force_if_different(changeset, :price, quotation_item.price)
  end

  defp derive_price(changeset, %{pricing_mode: :qty_tiered} = quotation_item) do
    case Ash.Changeset.get_attribute(changeset, :qty) do
      nil ->
        # qty 缺失由必填校验兜底报错
        changeset

      qty ->
        case QuotationLink.tier_price(quotation_item.id, qty) do
          {:ok, price} -> force_if_different(changeset, :price, price)
          :error -> Ash.Changeset.add_error(changeset, field: :qty, message: "低于首档起订量,无报价")
        end
    end
  end

  # 用户未显式传税率时取报价条目税率(显式传 0 也是显式,查 params 同 SyncCurrency 思路)
  defp derive_tax_rate(changeset, quotation_item) do
    if Map.has_key?(changeset.params, :tax_rate) or Map.has_key?(changeset.params, "tax_rate") do
      changeset
    else
      force_if_different(changeset, :tax_rate, quotation_item.tax_rate)
    end
  end

  defp validate_sample(changeset) do
    changeset =
      if Ash.Changeset.get_attribute(changeset, :quotation_item_id) do
        Ash.Changeset.add_error(changeset,
          field: :quotation_item_id,
          message: "样品订单条目不可选择报价条目"
        )
      else
        changeset
      end

    qty = Ash.Changeset.get_attribute(changeset, :qty)

    with %Decimal{} <- qty,
         %{sample_item_max_qty: max} <- SynieCore.Sales.Setting.get(),
         true <- Decimal.compare(qty, Decimal.new(max)) == :gt do
      Ash.Changeset.add_error(changeset, field: :qty, message: "样品条目数量超出上限(最大 #{max})")
    else
      _ -> changeset
    end
  end

  defp force_if_different(changeset, attribute, value) do
    if Ash.Changeset.get_attribute(changeset, attribute) == value do
      changeset
    else
      Ash.Changeset.force_change_attribute(changeset, attribute, value)
    end
  end

  defp read_order(nil), do: {:ok, nil}

  defp read_order(order_id) do
    SynieCore.Sales.Order
    |> Ash.Query.filter(id == ^order_id)
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Sales.OrderItem.ComputeAmount do
  @moduledoc """
  金额链系统算(ADR 2026-07-17-sales-order-currency),四列均不允许手改
  (属性 writable? false 兜底):
  原币金额 = 数量 × 原币单价(2位);本币金额 = 原币金额 × 汇率(2位,从金额换算,
  行内恒有 本币金额≡round(原币金额×汇率));本币单价 = 原币单价 × 汇率(4位,仅展示参考)。

  汇率取父订单头,且在 before_action 内取——此时 SyncOrder 的 FOR UPDATE 已锁住订单
  (changes 声明序在其后,钩子同序执行),读到的汇率不会被并发的头更新作废;
  构建期读会留下「行按旧汇率算、头已改」的竞态窗口。
  订单/数量/单价读不到时跳过,由 SyncOrder 与必填校验兜底报错。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      qty = Ash.Changeset.get_attribute(cs, :qty)
      price = Ash.Changeset.get_attribute(cs, :price)
      order_id = Ash.Changeset.get_attribute(cs, :order_id) || cs.data.order_id

      with false <- is_nil(qty) or is_nil(price),
           {:ok, %{exchange_rate: %Decimal{} = rate}} <- read_order(order_id) do
        amount = qty |> Decimal.mult(price) |> Decimal.round(2)

        cs
        |> Ash.Changeset.force_change_attribute(:amount, amount)
        |> Ash.Changeset.force_change_attribute(
          :base_amount,
          amount |> Decimal.mult(rate) |> Decimal.round(2)
        )
        |> Ash.Changeset.force_change_attribute(
          :base_price,
          price |> Decimal.mult(rate) |> Decimal.round(4)
        )
      else
        _ -> cs
      end
    end)
  end

  defp read_order(nil), do: :error

  defp read_order(order_id) do
    SynieCore.Sales.Order
    |> Ash.Query.filter(id == ^order_id)
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Sales.OrderItem.SyncDrawings do
  @moduledoc """
  图纸挂接复制:行 create/update 后(after_action,在动作事务内)把物料当前
  drawing 槽位的 sys_file 集合同步为行的挂接(owner_type `sal_order_item`、
  category `drawing`):旧的行挂接整删,按当前物料图纸整建——引用复制而非字节复制
  (文件字节不可变、有挂接不可删,引用即永恒,零存储放大)。
  挂接写失败随动作事务一起回滚(after_action 先例见 SynieCore.Audit.Track)。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Files.Attachment
  alias SynieCore.Sales.OrderItem.ClearDrawings

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn _changeset, item ->
      sync!(item)
      {:ok, item}
    end)
  end

  @doc false
  def sync!(item) do
    ClearDrawings.clear!(item.id)

    Attachment
    |> Ash.Query.filter(
      owner_type == "inv_material" and owner_id == ^item.material_id and category == "drawing"
    )
    |> Ash.read!(authorize?: false)
    |> Enum.each(fn %{file_id: file_id} ->
      Attachment
      |> Ash.Changeset.for_create(:create, %{
        file_id: file_id,
        owner_type: "sal_order_item",
        owner_id: item.id,
        category: "drawing",
        company_id: item.company_id
      })
      |> Ash.create!(authorize?: false)
    end)
  end
end

defmodule SynieCore.Sales.OrderItem.ClearDrawings do
  @moduledoc """
  清理行的图纸挂接。attachment 与行业务表之间没有外键,行删挂接不会跟着删,
  留着会让 sys_file 被 AttachmentGuard 永久锁死,故行 destroy 必须显式清。
  注意:订单删行走 DB 级联(postgres reference on_delete: :delete),本钩子不触发——
  订单侧的清理见 SynieCore.Sales.Order.ClearItemDrawings。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Files.Attachment

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn _changeset, item ->
      clear!(item.id)
      {:ok, item}
    end)
  end

  @doc false
  def clear!(item_id) do
    Attachment
    |> Ash.Query.filter(
      owner_type == "sal_order_item" and owner_id == ^item_id and category == "drawing"
    )
    |> Ash.read!(authorize?: false)
    |> Enum.each(&Ash.destroy!(&1, authorize?: false))
  end
end

defmodule SynieCore.Sales.OrderItem do
  @moduledoc """
  销售订单条目,对应 `sal_order_item` 表。

  `company_id` 冗余自父订单以复用公司数据权限;金额四列(原币/本币的单价与金额中
  除原币单价外)按金额链系统算不可手改(见 `ComputeAmount`,汇率取父订单头);
  头上币种/汇率变化时经 `:recalc_base` 内部动作同事务重算本币列;
  行单位限物料默认单位或其转换单位;仅父订单草稿态可增删改。
  按订单分型建行(见 `DeriveQuotation`):常规订单行必须挂有效报价条目,
  物料/单位/单价由报价强制派生(忽略用户传值);样品订单行不得挂报价条目,
  数量受 `sal_setting` 样品上限约束。
  物料编号/名称/规格/客户料号与单位名称是快照物理列:行保存(create/update)即按
  当前物料/单位重拍(见 `SnapshotMaterial`),审核锁行即冻结,主数据后续变更不回溯;
  物料 drawing 槽位的文件在行保存时复制挂接到行(见 `SyncDrawings`),
  行/订单删除时显式清理(见 `ClearDrawings` 与 `Order.ClearItemDrawings`)。
  v1 不拆未税金额/税额(将来开票对接时按 含税÷(1+税率) 拆)。
  无独立权限点:permission_actions 为空(不进权限目录),动作复用 `sales.order` 权限码。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment],
    # 主 read 上的兜底排序(idx 升序)是有意为之,行按录入顺序展示依赖此序
    primary_read_warning?: false

  postgres do
    table "sal_order_item"
    repo SynieCore.Repo

    references do
      # 删草稿订单 DB 级联删行(行不留单独审计,订单删除本身已审计)
      reference :order, on_delete: :delete

      # 报价条目是溯源链接(on_delete nothing):作废走状态不删行,行历史不随报价断链
      reference :quotation_item, on_delete: :nothing
    end

    check_constraints do
      check_constraint :qty, "qty_positive", check: "qty > 0", message: "数量必须大于零"
      check_constraint :price, "price_nonnegative", check: "price >= 0", message: "含税单价不能为负"

      check_constraint :tax_rate, "tax_rate_range",
        check: "tax_rate >= 0 AND tax_rate < 1",
        message: "税率必须在 0(含)与 1 之间"

      check_constraint :shipped_qty, "shipped_qty_nonnegative",
        check: "shipped_qty >= 0",
        message: "已发数量不能为负"
    end
  end

  graphql do
    type :sal_order_item
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

  # 复用订单权限码;actions 为空不进权限目录(同 GlJournalLine 跟随 acc.gl_journal 的先例)
  def permission_prefix, do: "sales.order"
  def permission_actions, do: []

  # 条目视图展示的订单头字段 calculation 白名单,GridMeta 只反射声明在列的 calculation
  # (opt-in 先例见 grid_actions/0、grid_capabilities/0)
  def grid_calculations,
    do: [:order_date, :order_status, :party_type, :party_id, :currency_code, :remaining_base_qty]

  # 头字段 party_id 是订单上的多态引用(经 calculation 暴露,判别字段 party_type 同为
  # calculation),声明给 GridMeta 反射成多态 fk 列;variants 与 Order.poly_refs/0 完全一致
  def poly_refs do
    %{
      party_id: %{
        discriminator: :party_type,
        variants: Map.take(SynieCore.Acc.PartyType.party_resources(), [:customer, :company])
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

      # 行按录入顺序展示:仅在请求未指定排序时兜底 idx 升序——显式传 sort
      # (条目视图按头字段排序)不被顶掉;drawer 查询显式传 IDX ASC,行为不变
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
        :order_id,
        :idx,
        :material_id,
        :unit_id,
        :qty,
        :price,
        :tax_rate,
        :remarks,
        :quotation_item_id
      ]

      # 顺序敏感:先回填 company_id,再做公司授权校验;
      # 分型派生在 MaterialUnitAllowed/ComputeAmount/SnapshotMaterial 之前,
      # 派生出的物料/单位/单价再经既有机制校验与计算
      change {SynieCore.Sales.OrderItem.SyncOrder, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      change {SynieCore.Sales.OrderItem.DeriveQuotation, []}
      validate {SynieCore.Sales.MaterialUnitAllowed, []}
      validate {SynieCore.Sales.MaterialCustomerAllowed, []}

      # 折默认单位数量:与已发 shipped_qty 同口径,供剩余可发筛选与发货超发校验
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Sales.OrderItem.ComputeAmount, []}
      change {SynieCore.Sales.SnapshotMaterial, []}
      change {SynieCore.Sales.OrderItem.SyncDrawings, []}
    end

    update :update do
      accept [:idx, :material_id, :unit_id, :qty, :price, :tax_rate, :remarks, :quotation_item_id]
      require_atomic? false

      change {SynieCore.Sales.OrderItem.SyncOrder, []}
      change {SynieCore.Sales.OrderItem.DeriveQuotation, []}
      validate {SynieCore.Sales.MaterialUnitAllowed, []}
      validate {SynieCore.Sales.MaterialCustomerAllowed, []}
      change {SynieCore.Inv.StockItemBaseQty, []}
      change {SynieCore.Sales.OrderItem.ComputeAmount, []}
      change {SynieCore.Sales.SnapshotMaterial, []}
      change {SynieCore.Sales.OrderItem.SyncDrawings, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      change {SynieCore.Sales.OrderItem.SyncOrder, []}
      change {SynieCore.Sales.OrderItem.ClearDrawings, []}
    end

    # 内部动作:头上币种/汇率变化时由 Order.RecalcItems 在同事务内逐行调用,
    # 按头的最新汇率重算本币列。不注册 GraphQL、不进权限目录;
    # 不挂 SyncOrder/SnapshotMaterial——调用方已持订单锁且订单必为草稿,
    # 快照语义是「行保存才重拍」,头改汇率不算行保存
    update :recalc_base do
      accept []
      require_atomic? false

      change {SynieCore.Sales.OrderItem.ComputeAmount, []}
    end

    # 内部动作:销售发货审核/作废时加减已发数量(默认单位)。调用方须已 FOR UPDATE
    # 锁住本行,并完成超发校验;不注册 GraphQL。
    update :adjust_shipped_qty do
      accept []
      require_atomic? false
      argument :delta, :decimal, allow_nil?: false

      change fn changeset, _context ->
        delta = Ash.Changeset.get_argument(changeset, :delta)
        current = changeset.data.shipped_qty || Decimal.new(0)
        next = Decimal.add(current, delta)

        if Decimal.compare(next, 0) == :lt do
          Ash.Changeset.add_error(changeset, field: :shipped_qty, message: "已发数量不能为负")
        else
          Ash.Changeset.force_change_attribute(changeset, :shipped_qty, next)
        end
      end
    end
  end

  validations do
    validate compare(:qty, greater_than: 0), message: "数量必须大于零"
    validate compare(:price, greater_than_or_equal_to: 0), message: "含税单价不能为负"

    validate compare(:tax_rate, greater_than_or_equal_to: 0, less_than: 1),
      message: "税率必须在 0(含)与 1 之间"
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

    # 订购数量折默认单位(系统算,与库存/已发同口径);StockItemBaseQty 写入
    attribute :base_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "订购数量(物料默认单位,系统折算)"
    end

    # 默认单位口径的已发累计:由销售发货审核/作废同步加减(投影列,见 ADR 2026-07-20)
    attribute :shipped_qty, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "已发数量(物料默认单位,系统维护)"
    end

    attribute :price, :decimal do
      allow_nil? false
      public? true
      description "原币含税单价"
    end

    attribute :amount, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "原币含税金额(系统算:数量×原币单价)"
    end

    # 双币列照 amount 先例 writable? false,只能由 ComputeAmount 写入;
    # 本币单(汇率1)两套同值,统一双套落库(ADR 2026-07-17-sales-order-currency)
    attribute :base_price, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "本币含税单价(系统算:原币单价×汇率,4位,仅展示参考)"
    end

    attribute :base_amount, :decimal do
      allow_nil? false
      writable? false
      default Decimal.new(0)
      public? true
      description "本币含税金额(系统算:原币金额×汇率)"
    end

    attribute :tax_rate, :decimal do
      allow_nil? false
      default Decimal.new("0.13")
      public? true
      description "税率(小数,如 0.13)"
    end

    # 物料信息快照:行保存时按当前物料/单位重拍(SnapshotMaterial),
    # writable? false 照 amount 先例只能由 change 写入;spec/customer_part_no 可空
    # (物料本身可空),审核锁行即冻结,主数据后续变更不回溯
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

    attribute :customer_part_no, :string do
      writable? false
      public? true
      description "客户料号"
    end

    attribute :unit_name, :string do
      allow_nil? false
      writable? false
      public? true
      description "单位名称"
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
    belongs_to :order, SynieCore.Sales.Order do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "订单"
    end

    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
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

    # 报价溯源链接:常规订单行必填(物料/单位/单价由此派生),样品订单行必须为空
    belongs_to :quotation_item, SynieCore.Sales.QuotationItem do
      public? true
      attribute_public? true
      attribute_writable? true
      description "报价条目"
    end
  end

  calculations do
    # 条目视图展示的订单头字段:沿 belongs_to :order 实时取数,不落物理列
    # (冗余列被否,见 ADR 2026-07-17);description 与 Order 对应属性保持一致
    calculate :order_date, :date, expr(order.order_date) do
      public? true
      description "订单日期"
    end

    calculate :order_status, SynieCore.Sales.OrderStatus, expr(order.status) do
      public? true
      description "状态"
    end

    calculate :party_type, SynieCore.Acc.PartyType, expr(order.party_type) do
      public? true
      description "对手类型(客户/内部公司)"
    end

    calculate :party_id, :uuid, expr(order.party_id) do
      public? true
      description "对手"
    end

    # 币种以 ISO 码文本呈现(混合行列表的口径标签),不做 fk 列——条目上它是头字段投影
    calculate :currency_code, :string, expr(order.currency.iso_code) do
      public? true
      description "币种"
    end

    # 未发数量(默认单位)=订购 base − 已发;发货选条目筛 remaining_base_qty > 0
    calculate :remaining_base_qty, :decimal, expr(base_qty - shipped_qty) do
      public? true
      description "未发数量(物料默认单位)"
    end
  end
end
