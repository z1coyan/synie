defmodule SynieCore.Sales.OrderStatus do
  @moduledoc "销售订单状态:草稿/已审核/已关闭/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", closed: "已关闭", voided: "已作废"]

  def graphql_type(_), do: :sal_order_status
end

defmodule SynieCore.Sales.OrderType do
  @moduledoc "销售订单类型:常规订单(条目挂报价派生)/样品订单(数量受 sal_setting 上限约束)。"

  use Ash.Type.Enum, values: [regular: "常规订单", sample: "样品订单"]

  def graphql_type(_), do: :sal_order_type
end

defmodule SynieCore.Sales.OrderDraft do
  @moduledoc "校验订单处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿订单可修改或删除"}
    end
  end
end

defmodule SynieCore.Sales.OrderTypeLocked do
  @moduledoc "订单类型锁死:新建时可选,后续不可变更(改型=重开一张单)。仅挂 update 动作。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if Ash.Changeset.get_attribute(changeset, :order_type) != changeset.data.order_type do
      {:error, field: :order_type, message: "订单类型不可变更"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Sales.Order.HeadFieldsFrozen do
  @moduledoc """
  头关键字段变更闸:订单已有条目(≥ 1 行)时,对手/公司/订单日期/币种不可再改——
  常规行的报价链接判定与派生价格锚定这些头字段,改头会让既有行口径漂移,
  报错引导先删条目再改头。按实际值对比(get_attribute vs changeset.data,
  同 RecalcItems.currency_changed? 思路),不动这些字段的更新(备注/条款等)不受拦。
  仅挂 update 动作(create 时无行)。
  """

  use Ash.Resource.Validation

  @fields [:party_type, :party_id, :company_id, :order_date, :currency_id]

  @impl true
  def validate(changeset, _opts, _context) do
    if head_changed?(changeset) and SynieCore.Sales.Order.has_items?(changeset.data.id) do
      {:error, message: "请先删除订单条目"}
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

defmodule SynieCore.Sales.Order.VerifyItems do
  @moduledoc """
  审核复核(第二道闸):审核前逐行重验分型规则,任一不满足即中止审核。
  常规订单每行:报价链接仍有效(已审核+订单日期在报价区间+公司/对手/币种一致,
  与行构建期同款判定,见 `Sales.QuotationLink`)且单价与报价一致
  (固定价相等;梯度按行数量套档,低于首档起订量报错);
  样品订单每行:不得挂报价条目且数量不超 `sal_setting` 样品上限。
  行构建期已校验过,这里拦的是建行后报价作废/配置收紧等漂移;
  before_action 在动作事务内执行,订单 FOR UPDATE 锁已由前一 change 持有,
  行编辑被串行化在外(锁内重读行,看到的是定稿)。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Sales.QuotationLink

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      items =
        SynieCore.Sales.OrderItem
        |> Ash.Query.filter(order_id == ^cs.data.id)
        |> Ash.read!(authorize?: false)

      case verify(cs.data, items) do
        :ok -> cs
        {:error, message} -> Ash.Changeset.add_error(cs, message: message)
      end
    end)
  end

  defp verify(%{order_type: :regular} = order, items) do
    first_error(items, &verify_regular_item(order, &1))
  end

  defp verify(%{order_type: :sample}, items) do
    max_qty =
      case SynieCore.Sales.Setting.get() do
        %{sample_item_max_qty: max} -> max
        _ -> nil
      end

    first_error(items, &verify_sample_item(&1, max_qty))
  end

  defp first_error(items, check_fun) do
    Enum.reduce_while(items, :ok, fn item, :ok ->
      case check_fun.(item) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, "第#{item.idx}行:#{reason}"}}
      end
    end)
  end

  defp verify_regular_item(order, item) do
    case item.quotation_item_id do
      nil ->
        {:error, "缺少报价条目"}

      quotation_item_id ->
        case QuotationLink.load_item(quotation_item_id) do
          :error ->
            {:error, "报价条目不存在"}

          {:ok, quotation_item, quotation} ->
            with :ok <- QuotationLink.check(order, quotation),
                 :ok <- check_price(item, quotation_item) do
              :ok
            end
        end
    end
  end

  defp check_price(item, %{pricing_mode: :fixed} = quotation_item) do
    if Decimal.equal?(item.price, quotation_item.price) do
      :ok
    else
      {:error, "单价与报价不一致"}
    end
  end

  defp check_price(item, %{pricing_mode: :qty_tiered} = quotation_item) do
    case QuotationLink.tier_price(quotation_item.id, item.qty) do
      {:ok, price} ->
        if Decimal.equal?(item.price, price), do: :ok, else: {:error, "单价与报价不一致"}

      :error ->
        {:error, "数量低于首档起订量,无报价"}
    end
  end

  defp verify_sample_item(item, max_qty) do
    cond do
      item.quotation_item_id ->
        {:error, "样品订单条目不可挂报价条目"}

      is_integer(max_qty) and Decimal.compare(item.qty, Decimal.new(max_qty)) == :gt ->
        {:error, "样品条目数量超出上限(最大 #{max_qty})"}

      true ->
        :ok
    end
  end
end

defmodule SynieCore.Sales.OrderPartyType do
  @moduledoc "销售订单对手类型限客户/内部公司(供应商留给将来的采购订单);必填由属性兜底。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :party_type) do
      nil -> :ok
      t when t in [:customer, :company] -> :ok
      _ -> {:error, field: :party_type, message: "对手类型只能为客户或内部公司"}
    end
  end
end

defmodule SynieCore.Sales.Order.SyncCurrency do
  @moduledoc """
  订单头币种/汇率归一(ADR 2026-07-17-sales-order-currency):
  币种留空默认单据公司本币;币种即本币时汇率强制为 1(用户不可指定);
  外币必须显式提供汇率——按 params 判断,属性 default 1 不算数
  (create 与「改币种为外币」的 update 都要求显式给;>0 由 validation 与 DB 约束兜底)。
  构建期执行——汇率参与行金额计算,必须在保存前就位;
  公司读不到时跳过,由 CompanyAccessible 校验/外键兜底报错。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id) || changeset.data.company_id

    case base_currency_id(company_id) do
      nil ->
        changeset

      base_currency_id ->
        changeset =
          if Ash.Changeset.get_attribute(changeset, :currency_id) == nil do
            Ash.Changeset.force_change_attribute(changeset, :currency_id, base_currency_id)
          else
            changeset
          end

        cond do
          Ash.Changeset.get_attribute(changeset, :currency_id) == base_currency_id ->
            Ash.Changeset.force_change_attribute(changeset, :exchange_rate, Decimal.new(1))

          rate_provided?(changeset) ->
            changeset

          # 外币 update 未动币种:沿用存量汇率,只有改成外币那一下才强制显式给
          changeset.action_type == :update and
              Ash.Changeset.get_attribute(changeset, :currency_id) == changeset.data.currency_id ->
            changeset

          true ->
            Ash.Changeset.add_error(changeset, field: :exchange_rate, message: "外币订单必须填写汇率")
        end
    end
  end

  defp rate_provided?(changeset) do
    Map.has_key?(changeset.params, :exchange_rate) or
      Map.has_key?(changeset.params, "exchange_rate")
  end

  defp base_currency_id(nil), do: nil

  defp base_currency_id(company_id) do
    case Ash.get(SynieCore.Base.Company, company_id, authorize?: false) do
      {:ok, %{base_currency_id: id}} -> id
      _ -> nil
    end
  end
end

defmodule SynieCore.Sales.Order.RecalcItems do
  @moduledoc """
  头上币种/汇率实际变化时重算全部行的本币列(本币金额=原币金额×汇率):
  after_action 在动作事务内执行,与头更新同生共死;此时头的 FOR UPDATE 锁
  (update 动作 before_action 所加)仍持有,行编辑被串行化在外。
  逐行走 OrderItem :recalc_base 内部动作(保留审计),行数受单据规模约束。
  仅挂 update 动作(create 时无行)。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn changeset, order ->
      if currency_changed?(changeset.data, order) do
        SynieCore.Sales.OrderItem
        |> Ash.Query.filter(order_id == ^order.id)
        |> Ash.read!(authorize?: false)
        |> Enum.each(fn item ->
          item
          |> Ash.Changeset.for_update(:recalc_base, %{})
          |> Ash.update!(authorize?: false)
        end)
      end

      {:ok, order}
    end)
  end

  # 按实际值比较(而非 changing_attribute?):本币单 update 每次都会被 SyncCurrency
  # force 汇率=1,若按「是否被写」判断会次次触发全行空重算
  defp currency_changed?(old, new) do
    old.currency_id != new.currency_id or
      Decimal.compare(old.exchange_rate || Decimal.new(0), new.exchange_rate) != :eq
  end
end

defmodule SynieCore.Sales.Order.ClearItemDrawings do
  @moduledoc """
  删订单前显式清理所有行的图纸挂接:订单删行走 DB 级联
  (order_item postgres reference on_delete: :delete),OrderItem 的 destroy 钩子
  不触发,不清会让挂接的 sys_file 被 AttachmentGuard 永久锁死。
  before_action 在动作事务内执行,清理与订单删除同生共死(删单失败整体回滚)。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      cs.data.id
      |> item_ids()
      |> Enum.each(&SynieCore.Sales.OrderItem.ClearDrawings.clear!/1)

      cs
    end)
  end

  defp item_ids(order_id) do
    SynieCore.Sales.OrderItem
    |> Ash.Query.filter(order_id == ^order_id)
    |> Ash.read!(authorize?: false)
    |> Enum.map(& &1.id)
  end
end

defmodule SynieCore.Sales.Order do
  @moduledoc """
  销售订单(头),对应 `sal_order` 表。公司向客户承诺供货的订货单据,纯业务承诺:
  审核不派生 GL 分录也不动库存,履行(发货/开票)由将来的下游模块承载。

  订单分型(`order_type`,新建时可选、建后锁死):常规订单条目必须挂有效报价条目,
  物料/单位/单价由报价派生;样品订单条目不挂报价,数量受 `sal_setting` 样品上限约束。
  两道闸护航:草稿改头关键字段(对手/公司/订单日期/币种)且已有条目时报错先删条目
  (HeadFieldsFrozen);审核时逐行复核分型规则(VerifyItems),任一不满足即中止。

  生命周期:草稿(可改可删)→ 已审核(audit,锁死,无反审核)→ 已关闭(close)/
  已作废(void)两个终态,均不可逆;仅已审核单可关闭/作废(关闭=生效后提前终止,
  作废=单据不该存在)。订单号全局唯一:留空按 `sales.order` 编号规则自动取号
  (AutoNumber),手填原样保留。对手为多态引用(客户/内部公司,无真外键),
  审核业务门槛是行数 ≥ 1 且逐行通过分型复核。行见 `OrderItem`,删除草稿时行由 DB 级联删除
  (不走 OrderItem destroy 钩子,行的图纸挂接由 ClearItemDrawings 在删单前显式清理)。

  双币:币种(原币)与汇率挂头,一单一币,留空默认公司本币;本币单汇率强制 1,
  外币单必填(SyncCurrency);草稿改币种/汇率同事务重算全部行本币列(RecalcItems),
  审核锁单即冻结。ADR 2026-07-17-sales-order-currency。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "sal_order"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :party_type, "party_pair",
        check: "(party_type IS NULL) = (party_id IS NULL)",
        message: "对手类型与对手必须同时填写"

      check_constraint :exchange_rate, "exchange_rate_positive",
        check: "exchange_rate > 0",
        message: "汇率必须大于零"
    end
  end

  graphql do
    type :sal_order
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

  def permission_prefix, do: "sales.order"
  def permission_actions, do: ~w(create read update delete audit close void)

  def grid_actions do
    [
      %{key: "audit", label: "审核", scope: "row", mutation: "auditSalOrder", is_danger: false},
      %{key: "close", label: "关闭", scope: "row", mutation: "closeSalOrder", is_danger: false},
      %{key: "void", label: "作废", scope: "row", mutation: "voidSalOrder", is_danger: true}
    ]
  end

  # 对手是多态引用(party_type 判别、无 belongs_to),声明给 GridMeta 反射成多态 fk 列;
  # 取值限客户/内部公司(见 OrderPartyType)
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
    end

    create :create do
      accept [
        :company_id,
        :order_no,
        :order_date,
        :order_type,
        :party_type,
        :party_id,
        :currency_id,
        :exchange_rate,
        :terms,
        :remarks
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Sales.OrderPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      # 币种默认公司本币/本币强制汇率1/外币必填汇率
      change {SynieCore.Sales.Order.SyncCurrency, []}

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :order_no}

      # 录入人自动取 actor;nil actor 只出现在受信内部路径,允许留空
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
        :order_no,
        :order_date,
        :order_type,
        :party_type,
        :party_id,
        :currency_id,
        :exchange_rate,
        :terms,
        :remarks
      ]

      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Sales.OrderDraft, []}
      validate {SynieCore.Sales.OrderTypeLocked, []}
      validate {SynieCore.Sales.Order.HeadFieldsFrozen, []}
      validate {SynieCore.Sales.OrderPartyType, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      # 币种默认公司本币/本币强制汇率1/外币必填汇率
      change {SynieCore.Sales.Order.SyncCurrency, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后头字段被改"竞态
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿订单可修改或删除")
          end
        end)
      end

      # 币种/汇率实际变化时同事务重算全部行的本币列
      change {SynieCore.Sales.Order.RecalcItems, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Sales.OrderDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后订单被删、行成孤儿"竞态
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿订单可修改或删除")
          end
        end)
      end

      # 行由 DB 级联删除(不走 OrderItem destroy 钩子),行的图纸挂接须在此显式清
      change {SynieCore.Sales.Order.ClearItemDrawings, []}
    end

    update :audit do
      accept []
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿订单可审核"}
      end

      validate fn changeset, _context ->
        if __MODULE__.has_items?(changeset.data.id) do
          :ok
        else
          {:error, message: "审核前必须至少填写一行条目"}
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
          # 借此串行化审核与行编辑/并发审核——关闭双审核竞态(构建期预检看到的状态可能已过期)
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :draft}} ->
              if __MODULE__.has_items?(cs.data.id) do
                cs
              else
                Ash.Changeset.add_error(cs, message: "审核前必须至少填写一行条目")
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿订单可审核")
          end
        end)
      end

      # 审核复核(第二道闸):锁内逐行重验分型规则,任一不满足即中止
      change {SynieCore.Sales.Order.VerifyItems, []}
    end

    update :close do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核订单可关闭"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :closed)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭并发竞态(与审核同根因)
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :audited}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核订单可关闭")
          end
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核订单可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭并发竞态(与审核同根因)
          case __MODULE__.lock_order(cs.data.id) do
            {:ok, %{status: :audited}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核订单可作废")
          end
        end)
      end
    end
  end

  validations do
    validate compare(:exchange_rate, greater_than: 0), message: "汇率必须大于零"
  end

  attributes do
    uuid_primary_key :id

    attribute :order_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "订单号"
    end

    attribute :order_date, :date do
      allow_nil? false
      public? true
      default &Date.utc_today/0
      description "订单日期"
    end

    # 分型建后锁死(OrderTypeLocked):常规行挂报价派生,样品行受数量上限约束
    attribute :order_type, SynieCore.Sales.OrderType do
      allow_nil? false
      default :regular
      public? true
      description "订单类型"
    end

    attribute :party_type, SynieCore.Acc.PartyType do
      allow_nil? false
      public? true
      description "对手类型(客户/内部公司)"
    end

    attribute :party_id, :uuid do
      allow_nil? false
      public? true
      description "对手"
    end

    # 汇率:原币→本币换算率,手工填写(无汇率主数据表);本币单由 SyncCurrency 强制为 1,
    # 外币单必须显式提供(SyncCurrency 查 params,默认值不算数)。
    # default 1 的另一职责:让 GraphQL create input 的该字段可空——无默认时 ash_graphql
    # 生成 Decimal! 非空,本币单前端不传汇率会在 GraphQL 校验层被拒,到不了 SyncCurrency。
    # 金额链见 OrderItem.ComputeAmount(ADR 2026-07-17-sales-order-currency)
    attribute :exchange_rate, :decimal do
      allow_nil? false
      default Decimal.new(1)
      public? true
      description "汇率(原币→本币)"
    end

    attribute :terms, :string do
      public? true
      description "交易条款(对客户,自由文本)"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "订单备注(对内)"
    end

    attribute :status, SynieCore.Sales.OrderStatus do
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

    # 原币(交易货币):一单一币,行金额跟随换算;留空由 SyncCurrency 默认公司本币
    belongs_to :currency, SynieCore.Base.Currency do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "币种(原币)"
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

    has_many :items, SynieCore.Sales.OrderItem do
      destination_attribute :order_id
      sort idx: :asc
      public? true
      description "订单条目"
    end
  end

  aggregates do
    sum :gross_total, :items, :amount do
      public? true
      description "原币含税总额(行原币含税金额合计)"
    end

    sum :base_gross_total, :items, :base_amount do
      public? true
      description "本币含税总额(行本币含税金额合计)"
    end
  end

  identities do
    identity :unique_order_no, [:order_no], message: "订单号已存在"
  end

  @doc false
  # 订单粒度锁:FOR UPDATE 锁住订单行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化行编辑/审核/关闭/作废
  def lock_order(order_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^order_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 审核门槛:订单至少一行条目
  def has_items?(order_id) do
    SynieCore.Sales.OrderItem
    |> Ash.Query.filter(order_id == ^order_id)
    |> Ash.exists?(authorize?: false)
  end
end
