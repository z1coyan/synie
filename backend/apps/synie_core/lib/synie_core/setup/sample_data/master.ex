defmodule SynieCore.Setup.SampleData.Master do
  @moduledoc """
  示例数据:前置补充与主数据。

  前置(各自幂等,不随整组跳过):1124 未开票应收 / 2204 未开票应付 两个一级
  叶子科目(:small 模板缺未开票往来角色科目,发货/入库/对账草稿即必填)、
  公司默认过账科目(发货借=1124、发货贷=5001、入库借=1405、入库贷=2204,
  对账单 create 据此自动代入)、叶子仓「{公司编码} - 成品仓」(调拨要求三仓两两不同)。
  主数据:客户 6、供应商 6、物料 17(客户料/通用成品/半成品/耗材/包材)、
  纸箱「个↔包」单位换算、员工 4。
  """

  require Ash.Query

  alias SynieCore.Base.Account
  alias SynieCore.Hr.Employee
  alias SynieCore.Inv.Material
  alias SynieCore.Inv.MaterialUnit
  alias SynieCore.Inv.Warehouse
  alias SynieCore.Purchase.Supplier
  alias SynieCore.Sales.CompanyAccountDefault
  alias SynieCore.Sales.Customer
  alias SynieCore.Setup.SampleData

  @customers [
    %{code: "C01", name: "宁波海纳电气有限公司", short_name: "海纳电气"},
    %{code: "C02", name: "温州联成机电有限公司", short_name: "联成机电"},
    %{code: "C03", name: "杭州远景新能源有限公司", short_name: "远景新能源"},
    %{code: "C04", name: "上海昊阳自动化设备有限公司", short_name: "昊阳自动化"},
    %{code: "C05", name: "苏州凯迪电子科技有限公司", short_name: "凯迪电子"},
    %{code: "C06", name: "广州南控电气有限公司", short_name: "南控电气"}
  ]

  @suppliers [
    %{code: "S01", name: "铜陵精铜材料有限公司", short_name: "精铜材料"},
    %{code: "S02", name: "义乌宏达标准件厂", short_name: "宏达标准件"},
    %{code: "S03", name: "上海申绝缘科技有限公司", short_name: "申绝缘"},
    %{code: "S04", name: "无锡恒力钣金有限公司", short_name: "恒力钣金"},
    %{code: "S05", name: "余姚创新塑业有限公司", short_name: "创新塑业"},
    %{code: "S06", name: "温州顺达包装有限公司", short_name: "顺达包装"}
  ]

  # 物料:key 供单据种子按名引用;原材料(铜棒/钢板/粒料)挂 F(S) 半成品,
  # 与初始化分类树先例一致(紫铜排即在 F(S))
  @materials [
    %{key: :box_shell, name: "配电箱壳体", spec: "HN-BX-100 定制", category: "F(P)",
      customer: "C01", customer_part_no: "HN-BX-100"},
    %{key: :busbar, name: "汇流铜排组件", spec: "HN-BB-08 8 路", category: "F(P)",
      customer: "C01", customer_part_no: "HN-BB-08"},
    %{key: :mount_plate, name: "断路器安装板", spec: "LC-MB-63", category: "F(P)",
      customer: "C02", customer_part_no: "LC-MB-63"},
    %{key: :terminal_assy, name: "端子排组件", spec: "YJ-TB-12", category: "F(P)",
      customer: "C03", customer_part_no: "YJ-TB-12"},
    %{key: :terminal_block, name: "接线端子座", spec: "UK-2.5B 灰", category: "F(G)"},
    %{key: :copper_terminal, name: "铜接线端子", spec: "OT-6", category: "F(G)"},
    %{key: :rail, name: "导轨", spec: "C45 35×7.5×1000", category: "F(G)"},
    %{key: :copper_bar, name: "紫铜排", spec: "T2 3×30×1000", category: "F(S)"},
    %{key: :copper_rod, name: "紫铜棒", spec: "T2 φ20", category: "F(S)"},
    %{key: :steel_sheet, name: "冷轧钢板", spec: "DC01 1.5×1250×2500", category: "F(S)"},
    %{key: :stamped_part, name: "冲压安装支架", spec: "ST-40", category: "F(S)"},
    %{key: :abs_pellet, name: "ABS 粒料", spec: "PA-757 白", category: "F(S)"},
    %{key: :scrap_copper, name: "废铜边角料", spec: "混合", category: "F(S)"},
    %{key: :screw, name: "十字盘头螺丝", spec: "M4×12 镀锌", category: "M(C)"},
    %{key: :insul_sleeve, name: "绝缘护套", spec: "φ6 黑 100m/卷", category: "M(C)"},
    %{key: :stretch_film, name: "缠绕膜", spec: "50cm×300m", category: "M(C)"},
    %{key: :carton, name: "五层纸箱", spec: "40×30×30", category: "P(C)"}
  ]

  @employees [
    %{name: "张伟强", phone: "13857610001", daily_wage: "260", monthly_allowance: "300"},
    %{name: "李秀英", phone: "13857610002", daily_wage: "220", monthly_allowance: "300"},
    %{name: "王建军", phone: "13857610003", daily_wage: "240", monthly_allowance: "500"},
    %{name: "陈晓梅", phone: "13857610004", daily_wage: "200", monthly_allowance: "200"}
  ]

  @doc """
  前置补充:未开票往来科目、默认过账科目、成品仓。
  返回 `{ctx, notifications}`;ctx 携带公司、全链路要用的科目与三个叶子仓。
  """
  def seed_prerequisites!(company) do
    {unbilled_ar, n1} =
      ensure_account!(company, "1124", "未开票应收", :debit, :unbilled_receivable, "1")

    {unbilled_ap, n2} =
      ensure_account!(company, "2204", "未开票应付", :credit, :unbilled_payable, "2")

    accounts = %{
      unbilled_ar: unbilled_ar,
      unbilled_ap: unbilled_ap,
      revenue: SampleData.account_by_code!(company.id, "5001"),
      inventory: SampleData.account_by_code!(company.id, "1405"),
      bank: SampleData.account_by_code!(company.id, "1002"),
      capital: SampleData.account_by_code!(company.id, "3001"),
      expense: SampleData.account_by_code!(company.id, "5602"),
      receivable: SampleData.account_by_code!(company.id, "1122"),
      payable: SampleData.account_by_code!(company.id, "2202"),
      tax: SampleData.account_by_code!(company.id, "2221")
    }

    n3 = ensure_company_account_default!(company, accounts)
    {finished, n4} = ensure_finished_warehouse!(company)

    ctx = %{
      company: company,
      accounts: accounts,
      warehouses: %{
        default: SampleData.warehouse_by_suffix!(company.id, "默认仓库"),
        transit: SampleData.warehouse_by_suffix!(company.id, "在途"),
        finished: finished
      }
    }

    {ctx, n1 ++ n2 ++ n3 ++ n4}
  end

  @doc "主数据:客户/供应商/物料/单位换算/员工。返回 `{master, notifications}`(各组按 code/key/name 索引)。"
  def seed!(company) do
    {customers, n1} = seed_customers!()
    {suppliers, n2} = seed_suppliers!()
    {materials, n3} = seed_materials!(customers)
    {conversions, n4} = seed_material_units!(materials)
    {employees, n5} = seed_employees!()

    master = %{
      company: company,
      customers: Map.new(customers, &{&1.code, &1}),
      suppliers: Map.new(suppliers, &{&1.code, &1}),
      materials: Map.new(materials),
      material_units: conversions,
      employees: Map.new(employees, &{&1.name, &1})
    }

    {master, n1 ++ n2 ++ n3 ++ n4 ++ n5}
  end

  # ---------------------------------------------------------------------------
  # 前置(按 code/company/name 幂等)
  # ---------------------------------------------------------------------------

  # 一级叶子科目:挂要素根(parent=根编码,如资产"1"/负债"2"),不用 1122.01
  # 子科目形式——1122 带 :receivable 角色,变 group 会被清角色
  defp ensure_account!(company, code, name, direction, role, root_code) do
    case Account
         |> Ash.Query.filter(company_id == ^company.id and code == ^code)
         |> Ash.read_one!(authorize?: false) do
      nil ->
        root = SampleData.account_by_code!(company.id, root_code)

        SampleData.create!(
          Account,
          %{
            code: code,
            name: name,
            direction: direction,
            role: role,
            parent_id: root.id,
            company_id: company.id
          },
          nil
        )

      account ->
        {account, []}
    end
  end

  # 默认过账科目(一公司一行):对账单 create 据此整组代入借贷科目
  defp ensure_company_account_default!(company, accounts) do
    case CompanyAccountDefault.get_for_company(company.id) do
      nil ->
        {_row, notifications} =
          SampleData.create!(
            CompanyAccountDefault,
            %{
              company_id: company.id,
              delivery_debit_account_id: accounts.unbilled_ar.id,
              delivery_credit_account_id: accounts.revenue.id,
              receipt_debit_account_id: accounts.inventory.id,
              receipt_credit_account_id: accounts.unbilled_ap.id
            },
            nil
          )

        notifications

      _row ->
        []
    end
  end

  # 叶子仓「成品仓」:调拨三仓两两不同,默认种子的两叶子仓不够
  defp ensure_finished_warehouse!(company) do
    name = "#{company.code} - 成品仓"

    case Warehouse
         |> Ash.Query.filter(company_id == ^company.id and name == ^name)
         |> Ash.read_one!(authorize?: false) do
      nil ->
        root = SampleData.warehouse_by_suffix!(company.id, "所有仓库")

        SampleData.create!(
          Warehouse,
          %{name: name, is_leaf: true, company_id: company.id, parent_id: root.id},
          nil
        )

      warehouse ->
        {warehouse, []}
    end
  end

  # ---------------------------------------------------------------------------
  # 主数据
  # ---------------------------------------------------------------------------

  defp seed_customers! do
    Enum.map_reduce(@customers, [], fn attrs, acc ->
      {row, notifications} = SampleData.create!(Customer, attrs, nil)
      {row, acc ++ notifications}
    end)
  end

  defp seed_suppliers! do
    Enum.map_reduce(@suppliers, [], fn attrs, acc ->
      {row, notifications} = SampleData.create!(Supplier, attrs, nil)
      {row, acc ++ notifications}
    end)
  end

  # 返回 [{key, 物料记录}];编号走物料规则自动取号
  defp seed_materials!(customers) do
    pcs = SampleData.unit_by_symbol!("pcs")
    by_code = Map.new(customers, &{&1.code, &1})

    Enum.map_reduce(@materials, [], fn spec, acc ->
      attrs = %{
        name: spec.name,
        spec: spec.spec,
        category_id: SampleData.leaf_category!(spec.category).id,
        default_unit_id: pcs.id,
        is_customer_material: Map.has_key?(spec, :customer)
      }

      attrs =
        case spec do
          %{customer: code} ->
            Map.merge(attrs, %{
              customer_id: by_code[code].id,
              customer_part_no: spec.customer_part_no
            })

          _ ->
            attrs
        end

      {row, notifications} = SampleData.create!(Material, attrs, nil)
      {{spec.key, row}, acc ++ notifications}
    end)
  end

  # 纸箱:默认单位「个」,挂换算单位「包」(1 个 = 0.05 包,即 20 个/包);须在库存动作前建
  defp seed_material_units!(materials) do
    pack = SampleData.unit_by_symbol!("包")

    {row, notifications} =
      SampleData.create!(
        MaterialUnit,
        %{material_id: materials[:carton].id, unit_id: pack.id, factor: Decimal.new("0.05")},
        nil
      )

    {%{carton_pack: row}, notifications}
  end

  defp seed_employees! do
    Enum.map_reduce(@employees, [], fn attrs, acc ->
      attrs = %{
        name: attrs.name,
        phone: attrs.phone,
        daily_wage: Decimal.new(attrs.daily_wage),
        monthly_allowance: Decimal.new(attrs.monthly_allowance)
      }

      {row, notifications} = SampleData.create!(Employee, attrs, nil)
      {row, acc ++ notifications}
    end)
  end
end
