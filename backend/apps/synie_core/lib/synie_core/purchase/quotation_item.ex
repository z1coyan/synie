defmodule SynieCore.Purchase.QuotationPricingMode do
  @moduledoc """
  报价条目定价模式:固定价/数量梯度。「行情挂钩」为预留模式,尚未实现
  (与销售报价同步预留,两侧将来一起落地,见 ADR 2026-07-20-purchase-line)。
  """

  use Ash.Type.Enum, values: [fixed: "固定价", qty_tiered: "数量梯度"]

  def graphql_type(_), do: :pur_quotation_pricing_mode
end

defmodule SynieCore.Purchase.QuotationItem.SyncQuotation do
  @moduledoc """
  行与父报价单同步:报价单必须存在且草稿态(增删改行的前提);
  create 时把报价单 company_id 冗余到行(数据权限按公司过滤依赖此列)。
  构建期预检仅为友好报错;权威复检在 before_action 钩子内(事务内 FOR UPDATE
  持锁到提交,串行化行编辑与审核/作废)。同 Sales.QuotationItem.SyncQuotation 先例。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    quotation_id = changeset_quotation_id(changeset)

    changeset =
      case read_quotation(quotation_id) do
        {:ok, %{status: :draft} = quotation} ->
          if changeset.action_type == :create do
            Ash.Changeset.force_change_attribute(changeset, :company_id, quotation.company_id)
          else
            changeset
          end

        {:ok, nil} ->
          Ash.Changeset.add_error(changeset, field: :quotation_id, message: "报价单不存在")

        {:ok, _quotation} ->
          Ash.Changeset.add_error(changeset, field: :quotation_id, message: "仅草稿报价单可编辑条目")

        _ ->
          Ash.Changeset.add_error(changeset, field: :quotation_id, message: "报价单不存在")
      end

    Ash.Changeset.before_action(changeset, fn cs ->
      case lock_quotation(changeset_quotation_id(cs)) do
        {:ok, %{status: :draft}} ->
          cs

        {:ok, nil} ->
          Ash.Changeset.add_error(cs, field: :quotation_id, message: "报价单不存在")

        _ ->
          Ash.Changeset.add_error(cs, field: :quotation_id, message: "仅草稿报价单可编辑条目")
      end
    end)
  end

  defp changeset_quotation_id(changeset),
    do: Ash.Changeset.get_attribute(changeset, :quotation_id) || changeset.data.quotation_id

  defp read_quotation(nil), do: {:ok, nil}

  defp read_quotation(quotation_id) do
    SynieCore.Purchase.Quotation
    |> Ash.Query.filter(id == ^quotation_id)
    |> Ash.read_one(authorize?: false)
  end

  defp lock_quotation(nil), do: {:ok, nil}

  defp lock_quotation(quotation_id) do
    SynieCore.Purchase.Quotation
    |> Ash.Query.filter(id == ^quotation_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end
end

defmodule SynieCore.Purchase.QuotationItem.PricingRules do
  @moduledoc """
  定价模式一致性(同销售报价条目先例):
  固定价条目必须填含税单价;数量梯度条目单价列强制空置(价在价格档上,
  行上留价会产生「按哪个价」的歧义)——梯度模式下无论传什么都被清空。
  DB check `pricing_price_consistency` 兜底。
  """

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :pricing_mode) do
      :qty_tiered ->
        Ash.Changeset.force_change_attribute(changeset, :price, nil)

      :fixed ->
        if Ash.Changeset.get_attribute(changeset, :price) do
          changeset
        else
          Ash.Changeset.add_error(changeset, field: :price, message: "固定价条目必须填写含税单价")
        end

      _ ->
        changeset
    end
  end
end

defmodule SynieCore.Purchase.QuotationItem.ClearTiersOnFixed do
  @moduledoc """
  条目从数量梯度切回固定价时清空其价格档(同订单「改头清行」先例):
  after_action 在动作事务内执行,与行更新同生共死;此时 SyncQuotation 的
  FOR UPDATE 仍持有报价单锁,档编辑被串行化在外。仅挂 update 动作。
  """

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.after_action(changeset, fn changeset, item ->
      if changeset.data.pricing_mode == :qty_tiered and item.pricing_mode == :fixed do
        SynieCore.Purchase.QuotationTier
        |> Ash.Query.filter(item_id == ^item.id)
        |> Ash.read!(authorize?: false)
        |> Enum.each(&Ash.destroy!(&1, action: :purge, authorize?: false))
      end

      {:ok, item}
    end)
  end
end

defmodule SynieCore.Purchase.QuotationItem do
  @moduledoc """
  采购报价条目,对应 `pur_quotation_item` 表。物料+单位粒度的价格承诺行:
  没有数量——报价单是价格清单,不是数量承诺;(物料, 单位) 单内唯一,
  同一物料同一单位两行两个价是歧义(同物料不同单位允许,是两种成交口径)。

  定价模式逐条目选择(`pricing_mode`):固定价用行上含税单价;数量梯度单价空置、
  挂 `QuotationTier` 价格档(起量价阶梯)。`company_id` 冗余自父报价单以复用
  公司数据权限;行单位限物料默认单位或其转换单位;仅父报价单草稿态可增删改;
  税率仅作口径标注(默认 13%,可手改),不参与任何计算。采购侧不校验客户物料约束,
  任何物料均可报价(ADR 2026-07-20-purchase-line)。
  物料编号/名称/规格/客户料号与单位名称是快照物理列:行保存即按当前物料/单位
  重拍(共享 `Sales.SnapshotMaterial`),审核锁行即冻结,主数据变更不回溯。
  无独立权限点:permission_actions 为空,动作复用 `purchase.quotation` 权限码。
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
    table "pur_quotation_item"
    repo SynieCore.Repo

    references do
      # 删草稿报价单 DB 级联删行(行不留单独审计,报价单删除本身已审计)
      reference :quotation, on_delete: :delete
    end

    check_constraints do
      check_constraint :price, "pricing_price_consistency",
        check:
          "(pricing_mode = 'fixed' AND price IS NOT NULL) OR (pricing_mode <> 'fixed' AND price IS NULL)",
        message: "固定价条目必须填写含税单价,梯度条目单价须留空"

      check_constraint :price, "price_nonnegative",
        check: "price IS NULL OR price >= 0",
        message: "含税单价不能为负"

      check_constraint :tax_rate, "tax_rate_range",
        check: "tax_rate >= 0 AND tax_rate < 1",
        message: "税率必须在 0(含)与 1 之间"
    end
  end

  graphql do
    type :pur_quotation_item
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

  # 复用报价单权限码;actions 为空不进权限目录(同 Sales.QuotationItem 先例)
  def permission_prefix, do: "purchase.quotation"
  def permission_actions, do: []

  # 条目视图展示的报价单头字段 calculation 白名单(GridMeta 只反射声明在列的 calculation)
  def grid_calculations,
    do: [:quotation_date, :valid_until, :quotation_status, :party_type, :party_id, :currency_code]

  # 头字段 party_id 是报价单上的多态引用(经 calculation 暴露),variants 与 Quotation 一致
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

      # 行按录入顺序展示:仅在请求未指定排序时兜底 idx 升序(同 OrderItem 先例)
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
        :quotation_id,
        :idx,
        :material_id,
        :unit_id,
        :pricing_mode,
        :price,
        :tax_rate,
        :remarks
      ]

      # 顺序敏感:先回填 company_id,再做公司授权校验
      change {SynieCore.Purchase.QuotationItem.SyncQuotation, []}
      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Sales.MaterialUnitAllowed, []}
      change {SynieCore.Purchase.QuotationItem.PricingRules, []}
      change {SynieCore.Sales.SnapshotMaterial, []}
    end

    update :update do
      accept [:idx, :material_id, :unit_id, :pricing_mode, :price, :tax_rate, :remarks]
      require_atomic? false

      change {SynieCore.Purchase.QuotationItem.SyncQuotation, []}
      validate {SynieCore.Sales.MaterialUnitAllowed, []}
      change {SynieCore.Purchase.QuotationItem.PricingRules, []}
      change {SynieCore.Sales.SnapshotMaterial, []}
      # 梯度切回固定价时同事务清空价格档
      change {SynieCore.Purchase.QuotationItem.ClearTiersOnFixed, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 价格档由 DB 级联删除(tier reference on_delete: :delete)
      change {SynieCore.Purchase.QuotationItem.SyncQuotation, []}
    end
  end

  validations do
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

    attribute :pricing_mode, SynieCore.Purchase.QuotationPricingMode do
      allow_nil? false
      default :fixed
      public? true
      description "定价模式"
    end

    # 固定价模式必填;数量梯度模式强制空置(价在价格档上,见 PricingRules)
    attribute :price, :decimal do
      public? true
      description "含税单价(固定价模式)"
    end

    attribute :tax_rate, :decimal do
      allow_nil? false
      default Decimal.new("0.13")
      public? true
      description "税率(小数,如 0.13)"
    end

    # 物料信息快照:行保存时按当前物料/单位重拍(共享 Sales.SnapshotMaterial),
    # writable? false 只能由 change 写入;spec/customer_part_no 可空(物料本身可空)
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
    belongs_to :quotation, SynieCore.Purchase.Quotation do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "报价单"
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

    has_many :tiers, SynieCore.Purchase.QuotationTier do
      destination_attribute :item_id
      sort min_qty: :asc
      public? true
      description "价格档(数量梯度)"
    end
  end

  aggregates do
    count :tier_count, :tiers do
      public? true
      description "价格档数"
    end
  end

  identities do
    identity :unique_material_unit, [:quotation_id, :material_id, :unit_id],
      message: "同一物料与单位在本报价单已有报价行"
  end

  calculations do
    # 条目视图展示的报价单头字段:沿 belongs_to :quotation 实时取数,不落物理列
    # (同 Sales.QuotationItem 先例);description 与 Quotation 对应属性保持一致
    calculate :quotation_date, :date, expr(quotation.quotation_date) do
      public? true
      description "报价日期"
    end

    calculate :valid_until, :date, expr(quotation.valid_until) do
      public? true
      description "报价截止(含当日)"
    end

    calculate :quotation_status, SynieCore.Purchase.QuotationStatus, expr(quotation.status) do
      public? true
      description "状态"
    end

    calculate :party_type, SynieCore.Acc.PartyType, expr(quotation.party_type) do
      public? true
      description "对手类型(供应商/内部公司)"
    end

    calculate :party_id, :uuid, expr(quotation.party_id) do
      public? true
      description "对手"
    end

    # 币种以 ISO 码文本呈现(混合行列表的口径标签),不做 fk 列——条目上它是头字段投影
    calculate :currency_code, :string, expr(quotation.currency.iso_code) do
      public? true
      description "币种"
    end
  end
end
