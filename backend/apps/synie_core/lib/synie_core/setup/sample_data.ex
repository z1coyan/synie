defmodule SynieCore.Setup.SampleData do
  @moduledoc """
  初始化向导可选的示例业务数据:客户、供应商、物料、销售/采购报价单。

  场景面向电气/机加工制造(如台州京泰电气),便于新部署立刻走通主数据与报价主路径。
  幂等:以客户编号 `C01` 为标记,已有则整组跳过、不覆盖。
  受信内部路径(`authorize?: false`);由 `Setup.complete/3` 在完成旗标落库前调用。
  """

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Company
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.Material
  alias SynieCore.Inv.MaterialCategory
  alias SynieCore.Purchase.Supplier
  alias SynieCore.Sales.Customer

  # 示例客商固定编号:既作展示用编号,也作幂等标记
  @marker_customer_code "C01"

  @customers [
    %{code: "C01", name: "宁波海纳电气有限公司", short_name: "海纳电气"},
    %{code: "C02", name: "温州联成机电有限公司", short_name: "联成机电"},
    %{code: "C03", name: "杭州远景新能源有限公司", short_name: "远景新能源"}
  ]

  @suppliers [
    %{code: "S01", name: "铜陵精铜材料有限公司", short_name: "精铜材料"},
    %{code: "S02", name: "义乌宏达标准件厂", short_name: "宏达标准件"},
    %{code: "S03", name: "上海申绝缘科技有限公司", short_name: "申绝缘"}
  ]

  @doc """
  为指定公司写入示例业务数据。

  返回 `{创建摘要 map, notifications}`。已种子过时摘要各计数为 0、notifications 为空列表。
  `actor` 可选,用于报价单录入人;nil 时录入人留空。
  """
  @spec seed!(String.t(), Actor.t() | nil) :: {map(), list()}
  def seed!(company_id, actor \\ nil) when is_binary(company_id) do
    if already_seeded?() do
      {%{customers: 0, suppliers: 0, materials: 0, sales_quotations: 0, purchase_quotations: 0}, []}
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
  # 内部
  # ---------------------------------------------------------------------------

  defp do_seed!(company, actor) do
    {customers, n1} = seed_customers!()
    {suppliers, n2} = seed_suppliers!()
    {materials, n3} = seed_materials!(customers)
    {sales_qs, n4} = seed_sales_quotations!(company, customers, materials, actor)
    {pur_qs, n5} = seed_purchase_quotations!(company, suppliers, materials, actor)

    summary = %{
      customers: length(customers),
      suppliers: length(suppliers),
      materials: length(materials),
      sales_quotations: length(sales_qs),
      purchase_quotations: length(pur_qs)
    }

    {summary, n1 ++ n2 ++ n3 ++ n4 ++ n5}
  end

  defp seed_customers! do
    Enum.map_reduce(@customers, [], fn attrs, acc ->
      {row, notifications} =
        Customer
        |> Ash.Changeset.for_create(:create, attrs)
        |> Ash.create!(authorize?: false, return_notifications?: true)

      {row, acc ++ notifications}
    end)
  end

  defp seed_suppliers! do
    Enum.map_reduce(@suppliers, [], fn attrs, acc ->
      {row, notifications} =
        Supplier
        |> Ash.Changeset.for_create(:create, attrs)
        |> Ash.create!(authorize?: false, return_notifications?: true)

      {row, acc ++ notifications}
    end)
  end

  defp seed_materials!(customers) do
    pcs = unit_by_symbol!("pcs")
    by_code = Map.new(customers, &{&1.code, &1})
    cat = leaf_category!("F(G)")
    cat_product = leaf_category!("F(P)")
    cat_half = leaf_category!("F(S)")
    cat_consumable = leaf_category!("M(C)")

    # 通用料 + 客户料(挂 C01),编号走物料规则自动取号
    specs = [
      %{
        name: "接线端子座",
        spec: "UK-2.5B 灰",
        category_id: cat.id,
        default_unit_id: pcs.id,
        is_customer_material: false
      },
      %{
        name: "紫铜排",
        spec: "T2 3×30×1000",
        category_id: cat_half.id,
        default_unit_id: pcs.id,
        is_customer_material: false
      },
      %{
        name: "十字盘头螺丝",
        spec: "M4×12 镀锌",
        category_id: cat_consumable.id,
        default_unit_id: pcs.id,
        is_customer_material: false
      },
      %{
        name: "绝缘护套",
        spec: "φ6 黑 100m/卷",
        category_id: cat_consumable.id,
        default_unit_id: pcs.id,
        is_customer_material: false
      },
      %{
        name: "配电箱壳体",
        spec: "HN-BX-100 定制",
        category_id: cat_product.id,
        default_unit_id: pcs.id,
        is_customer_material: true,
        customer_id: by_code["C01"].id,
        customer_part_no: "HN-BX-100"
      },
      %{
        name: "汇流铜排组件",
        spec: "HN-BB-08 8 路",
        category_id: cat_product.id,
        default_unit_id: pcs.id,
        is_customer_material: true,
        customer_id: by_code["C01"].id,
        customer_part_no: "HN-BB-08"
      }
    ]

    Enum.map_reduce(specs, [], fn attrs, acc ->
      {row, notifications} =
        Material
        |> Ash.Changeset.for_create(:create, attrs)
        |> Ash.create!(authorize?: false, return_notifications?: true)

      {row, acc ++ notifications}
    end)
  end

  defp seed_sales_quotations!(company, customers, materials, actor) do
    by_code = Map.new(customers, &{&1.code, &1})
    today = Date.utc_today()
    general = Enum.reject(materials, & &1.is_customer_material)
    c01_mats = Enum.filter(materials, &(&1.customer_id == by_code["C01"].id))

    # 1) 已审核报价:海纳电气 — 客户料 + 通用端子
    {q1, n1} =
      create_sales_quotation!(
        company,
        by_code["C01"],
        today,
        Date.add(today, 60),
        "示例:含税交货,账期月结 30 天",
        "初始化示例报价(已审核)",
        actor
      )

    items1 =
      [
        {hd(c01_mats), "128.00"},
        {Enum.at(c01_mats, 1) || hd(c01_mats), "86.50"},
        {hd(general), "2.35"}
      ]
      |> Enum.with_index(1)

    n1b =
      Enum.flat_map(items1, fn {{mat, price}, idx} ->
        create_sales_item!(q1, idx, mat, price)
      end)

    {q1_audited, n1c} =
      q1
      |> Ash.Changeset.for_update(:audit, %{}, actor: actor)
      |> Ash.update!(authorize?: false, return_notifications?: true)

    # 2) 草稿报价:联成机电 — 通用料
    {q2, n2} =
      create_sales_quotation!(
        company,
        by_code["C02"],
        today,
        Date.add(today, 30),
        nil,
        "初始化示例报价(草稿,可改后审核)",
        actor
      )

    n2b =
      general
      |> Enum.take(3)
      |> Enum.with_index(1)
      |> Enum.flat_map(fn {mat, idx} ->
        price =
          case idx do
            1 -> "2.35"
            2 -> "48.00"
            _ -> "0.12"
          end

        create_sales_item!(q2, idx, mat, price)
      end)

    {[q1_audited, q2], n1 ++ n1b ++ n1c ++ n2 ++ n2b}
  end

  defp seed_purchase_quotations!(company, suppliers, materials, actor) do
    by_code = Map.new(suppliers, &{&1.code, &1})
    today = Date.utc_today()
    general = Enum.reject(materials, & &1.is_customer_material)

    # 1) 已审核:精铜 — 铜排
    copper = Enum.find(general, &(&1.name == "紫铜排")) || hd(general)

    {q1, n1} =
      create_purchase_quotation!(
        company,
        by_code["S01"],
        today,
        Date.add(today, 45),
        "到厂价含税,运费另计",
        "初始化示例采购报价(已审核)",
        actor
      )

    n1b = create_purchase_item!(q1, 1, copper, "36.80")

    {q1_audited, n1c} =
      q1
      |> Ash.Changeset.for_update(:audit, %{}, actor: actor)
      |> Ash.update!(authorize?: false, return_notifications?: true)

    # 2) 草稿:宏达 — 螺丝
    screw = Enum.find(general, &(&1.name == "十字盘头螺丝")) || hd(general)

    {q2, n2} =
      create_purchase_quotation!(
        company,
        by_code["S02"],
        today,
        Date.add(today, 30),
        nil,
        "初始化示例采购报价(草稿)",
        actor
      )

    n2b = create_purchase_item!(q2, 1, screw, "0.045")

    {[q1_audited, q2], n1 ++ n1b ++ n1c ++ n2 ++ n2b}
  end

  defp create_sales_quotation!(company, customer, date, valid_until, terms, remarks, actor) do
    SynieCore.Sales.Quotation
    |> Ash.Changeset.for_create(:create, %{
      company_id: company.id,
      quotation_date: date,
      valid_until: valid_until,
      party_type: :customer,
      party_id: customer.id,
      terms: terms,
      remarks: remarks
    })
    |> Ash.create!(create_opts(actor))
  end

  defp create_purchase_quotation!(company, supplier, date, valid_until, terms, remarks, actor) do
    SynieCore.Purchase.Quotation
    |> Ash.Changeset.for_create(:create, %{
      company_id: company.id,
      quotation_date: date,
      valid_until: valid_until,
      party_type: :supplier,
      party_id: supplier.id,
      terms: terms,
      remarks: remarks
    })
    |> Ash.create!(create_opts(actor))
  end

  defp create_sales_item!(quotation, idx, material, price) do
    {_item, notifications} =
      SynieCore.Sales.QuotationItem
      |> Ash.Changeset.for_create(:create, %{
        quotation_id: quotation.id,
        idx: idx,
        material_id: material.id,
        unit_id: material.default_unit_id,
        pricing_mode: :fixed,
        price: Decimal.new(price),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false, return_notifications?: true)

    notifications
  end

  defp create_purchase_item!(quotation, idx, material, price) do
    {_item, notifications} =
      SynieCore.Purchase.QuotationItem
      |> Ash.Changeset.for_create(:create, %{
        quotation_id: quotation.id,
        idx: idx,
        material_id: material.id,
        unit_id: material.default_unit_id,
        pricing_mode: :fixed,
        price: Decimal.new(price),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false, return_notifications?: true)

    notifications
  end

  defp create_opts(nil), do: [authorize?: false, return_notifications?: true]
  defp create_opts(%Actor{} = actor),
    do: [authorize?: false, actor: actor, return_notifications?: true]

  defp unit_by_symbol!(symbol) do
    case Unit |> Ash.Query.filter(symbol == ^symbol) |> Ash.read_one!(authorize?: false) do
      nil -> raise "示例数据需要计量单位 #{symbol},请先完成初始化单位种子"
      unit -> unit
    end
  end

  defp leaf_category!(code) do
    case MaterialCategory
         |> Ash.Query.filter(code == ^code)
         |> Ash.read_one!(authorize?: false) do
      nil -> raise "示例数据需要物料分类 #{code},请先完成初始化分类种子"
      cat -> cat
    end
  end
end
