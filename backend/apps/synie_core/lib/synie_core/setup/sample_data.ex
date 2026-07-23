defmodule SynieCore.Setup.SampleData do
  @moduledoc """
  初始化向导可选的示例业务数据:覆盖全业务链的可信演示数据。

  场景面向电气/机加工制造(如台州京泰电气),近 3 个月真实分布(已完成旧单 +
  进行中单 + 少量草稿),新部署可立刻走通:主数据(客商/物料/单位换算/员工)、
  销售链与采购链(报价→订单→发货/入库→对账→发票,各一条链走到发票结单)、
  库存(期初入库/领料出库/调拨/盘点)、生产主数据(工序/工艺模板/BOM)与
  财务(银行账户与流水、手工凭证、报销单、工资单与发放)。

  前置补充(:small 科目模板缺未开票往来科目):1124 未开票应收、2204 未开票应付、
  公司默认过账科目、叶子仓「成品仓」,各自按 编码/公司/名称 幂等;
  数量账按「期初+采购入库 ≥ 销售发货+出库+调拨+盘亏」写死并逐料算平。
  幂等:以客户编号 `C01` 为标记,已有则整组跳过、不覆盖。
  受信内部路径(`authorize?: false`);由 `Setup.complete/3` 在完成旗标落库前调用。
  分域实现见 `SampleData.Master/Inventory/Purchase/Sales/Mfg/Finance` 子模块。
  """

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Account
  alias SynieCore.Base.Company
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.MaterialCategory
  alias SynieCore.Inv.Warehouse
  alias SynieCore.Sales.Customer
  alias SynieCore.Setup.SampleData.{Finance, Inventory, Master, Mfg, Purchase, Sales}

  # 示例客商固定编号:既作展示用编号,也作幂等标记
  @marker_customer_code "C01"

  # summary 键清单:已种子跳过时同键置 0(保留原有 5 键,追加新链计数)
  @summary_keys [
    :customers,
    :suppliers,
    :materials,
    :employees,
    :sales_quotations,
    :purchase_quotations,
    :sales_orders,
    :purchase_orders,
    :sales_deliveries,
    :purchase_receipts,
    :sales_reconciliations,
    :purchase_reconciliations,
    :stock_docs,
    :stock_transfers,
    :stock_counts,
    :operations,
    :process_templates,
    :boms,
    :bank_accounts,
    :bank_transactions,
    :gl_journals,
    :expense_reports,
    :payrolls,
    :vat_invoices
  ]

  @doc """
  为指定公司写入示例业务数据。

  返回 `{创建摘要 map, notifications}`。已种子过时摘要各计数为 0、notifications 为空列表。
  `actor` 可选,用于单据录入人;nil 时录入人留空。
  """
  @spec seed!(String.t(), Actor.t() | nil) :: {map(), list()}
  def seed!(company_id, actor \\ nil) when is_binary(company_id) do
    if already_seeded?() do
      {Map.new(@summary_keys, &{&1, 0}), []}
    else
      company = Ash.get!(Company, company_id, authorize?: false)
      do_seed!(company, actor)
    end
  end

  @doc "是否已写入过示例数据(以客户 C01 为标记)。"
  @spec already_seeded?() :: boolean()
  def already_seeded? do
    Customer
    |> Ash.Query.filter(code == ^@marker_customer_code)
    |> Ash.exists?(authorize?: false)
  end

  # ---------------------------------------------------------------------------
  # 共享 helper(子模块共用)
  # ---------------------------------------------------------------------------

  @doc false
  # 受信创建:返回 {记录, notifications}(沿用既有 map_reduce 收集先例)
  def create!(resource, attrs, actor) do
    resource
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(create_opts(actor))
  end

  @doc false
  # 受信动作(update 系:audit/confirm/ship/receive/approve/apply_route_template 等)
  def run_action!(record, action, attrs, actor) do
    record
    |> Ash.Changeset.for_update(action, attrs, actor: actor)
    |> Ash.update!(authorize?: false, return_notifications?: true)
  end

  @doc false
  # 单据行按创建序转整数键 map,便于按位置引用(如发货/对账挂第 N 行)
  def index_items(items), do: items |> Enum.with_index() |> Map.new(fn {item, idx} -> {idx, item} end)

  @doc false
  def create_opts(nil), do: [authorize?: false, return_notifications?: true]

  def create_opts(%Actor{} = actor),
    do: [authorize?: false, actor: actor, return_notifications?: true]

  @doc false
  # 相对日期:全部示例单据日期自今日回溯,保证演示库任何时候初始化都「新鲜」
  def days_ago(n) when is_integer(n), do: Date.add(Date.utc_today(), -n)

  @doc false
  def unit_by_symbol!(symbol) do
    case Unit |> Ash.Query.filter(symbol == ^symbol) |> Ash.read_one!(authorize?: false) do
      nil -> raise "示例数据需要计量单位 #{symbol},请先完成初始化单位种子"
      unit -> unit
    end
  end

  @doc false
  def leaf_category!(code) do
    case MaterialCategory
         |> Ash.Query.filter(code == ^code)
         |> Ash.read_one!(authorize?: false) do
      nil -> raise "示例数据需要物料分类 #{code},请先完成初始化分类种子"
      cat -> cat
    end
  end

  @doc false
  def account_by_code!(company_id, code) do
    case Account
         |> Ash.Query.filter(company_id == ^company_id and code == ^code)
         |> Ash.read_one!(authorize?: false) do
      nil -> raise "示例数据需要科目 #{code}(按小企业会计准则模板),请先完成科目表初始化"
      account -> account
    end
  end

  @doc false
  # 按名称后缀找仓库(公司编码前缀各异,如「JT - 默认仓库」)
  def warehouse_by_suffix!(company_id, suffix) do
    Warehouse
    |> Ash.Query.filter(company_id == ^company_id)
    |> Ash.read!(authorize?: false)
    |> Enum.find(&String.ends_with?(&1.name, suffix))
    |> case do
      nil -> raise "示例数据需要名称以「#{suffix}」结尾的仓库,请先完成默认仓库种子"
      warehouse -> warehouse
    end
  end

  # ---------------------------------------------------------------------------
  # 内部
  # ---------------------------------------------------------------------------

  # 编排顺序:前置(科目/默认科目/成品仓)→ 主数据 → 期初入库 → 采购链(入库增库存)→
  # 销售链(发货减库存)→ 库存(出库/调拨/盘点,盘点永远最后)→ 生产 → 财务(发票最后,读对账合计)
  defp do_seed!(company, actor) do
    {ctx, n0} = Master.seed_prerequisites!(company)
    {master, n1} = Master.seed!(company)
    {_opening, n2} = Inventory.seed_opening!(ctx, master, actor)
    {purchase, n3} = Purchase.seed!(ctx, master, actor)
    {sales, n4} = Sales.seed!(ctx, master, actor)
    {inv_docs, n5} = Inventory.seed_documents!(ctx, master, actor)
    {mfg, n6} = Mfg.seed!(master)
    {finance, n7} = Finance.seed!(ctx, master, sales, purchase, actor)

    summary = %{
      customers: map_size(master.customers),
      suppliers: map_size(master.suppliers),
      materials: map_size(master.materials),
      employees: map_size(master.employees),
      sales_quotations: length(sales.quotations),
      purchase_quotations: length(purchase.quotations),
      sales_orders: length(sales.orders),
      purchase_orders: length(purchase.orders),
      sales_deliveries: length(sales.deliveries),
      purchase_receipts: length(purchase.receipts),
      sales_reconciliations: length(sales.reconciliations),
      purchase_reconciliations: length(purchase.reconciliations),
      stock_docs: length(inv_docs.stock_docs),
      stock_transfers: 1,
      stock_counts: 1,
      operations: length(mfg.operations),
      process_templates: length(mfg.process_templates),
      boms: length(mfg.boms),
      bank_accounts: 1,
      bank_transactions: length(finance.bank_transactions),
      gl_journals: length(finance.gl_journals),
      expense_reports: 1,
      payrolls: length(finance.payrolls),
      vat_invoices: length(finance.vat_invoices)
    }

    {summary, n0 ++ n1 ++ n2 ++ n3 ++ n4 ++ n5 ++ n6 ++ n7}
  end
end
