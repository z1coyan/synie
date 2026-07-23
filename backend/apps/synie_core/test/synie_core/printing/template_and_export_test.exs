defmodule SynieCore.Printing.TemplateAndExportTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Files
  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Printing.FieldCatalog
  alias SynieCore.Printing.Template
  alias SynieCore.PrintingFixture

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_print_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{
      name: "print_local_#{System.unique_integer([:positive])}",
      label: "打印测试存储",
      kind: :local,
      root: root
    })
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)

    on_exit(fn -> File.rm_rf!(base) end)
    :ok
  end

  defp actor!(perms) do
    user = user!()
    role = role!()
    Enum.each(perms, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  defp upload_xlsx!(actor, rows) do
    bin = PrintingFixture.build(rows: rows)
    path = Path.join(System.tmp_dir!(), "tpl_#{System.unique_integer([:positive])}.xlsx")
    File.write!(path, bin)

    {:ok, %{file: file}} =
      Files.upload(actor, %{
        path: path,
        filename: "order.xlsx",
        content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      })

    File.rm(path)
    file
  end

  test "FieldCatalog 校验未知占位符" do
    assert :ok =
             FieldCatalog.validate_placeholders("sales.order", ["order_no"], %{
               "items" => ["material_name", "_seq"]
             })

    assert {:error, msg} =
             FieldCatalog.validate_placeholders("sales.order", ["nope"], %{
               "items" => ["material_name"]
             })

    assert msg =~ "nope"

    assert {:error, _} = FieldCatalog.validate_placeholders("unknown.res", [], %{})
  end

  test "创建模板：合法 xlsx 成功；未知字段拒存；设默认唯一" do
    actor =
      actor!([
        "sys.file:create",
        "sys.print_template:create",
        "sys.print_template:read",
        "sys.print_template:update"
      ])

    good = upload_xlsx!(actor, [["${order_no}", "${items.material_name}"]])

    assert {:ok, t1} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "订单默认",
               resource: "sales.order",
               file_id: good.id
             })
             |> Ash.create(actor: actor)

    assert t1.resource == "sales.order"
    refute t1.is_default

    bad = upload_xlsx!(actor, [["${not_a_field}"]])

    assert {:error, %Ash.Error.Invalid{}} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "坏模板",
               resource: "sales.order",
               file_id: bad.id
             })
             |> Ash.create(actor: actor)

    assert {:ok, t1d} =
             t1
             |> Ash.Changeset.for_update(:set_default, %{})
             |> Ash.update(actor: actor)

    assert t1d.is_default

    good2 = upload_xlsx!(actor, [["${order_no}"]])

    assert {:ok, t2} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "另一份",
               resource: "sales.order",
               file_id: good2.id
             })
             |> Ash.create(actor: actor)

    assert {:ok, t2d} =
             t2
             |> Ash.Changeset.for_update(:set_default, %{})
             |> Ash.update(actor: actor)

    assert t2d.is_default

    t1_re = Ash.get!(Template, t1.id, authorize?: false)
    refute t1_re.is_default
  end

  test "非 xlsx 文件名拒存" do
    actor = actor!(["sys.file:create", "sys.print_template:create"])

    path = Path.join(System.tmp_dir!(), "x_#{System.unique_integer([:positive])}.txt")
    File.write!(path, "not xlsx")

    {:ok, %{file: file}} =
      Files.upload(actor, %{path: path, filename: "note.txt", content_type: "text/plain"})

    File.rm(path)

    assert {:error, %Ash.Error.Invalid{}} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "文本",
               resource: "sales.order",
               file_id: file.id
             })
             |> Ash.create(actor: actor)
  end

  test "旧拍平键模板上传被拒并点名" do
    actor = actor!(["sys.file:create", "sys.print_template:create"])
    file = upload_xlsx!(actor, [["${company_name}"]])

    assert {:error, %Ash.Error.Invalid{} = err} =
             Template
             |> Ash.Changeset.for_create(:create, %{
               name: "旧键",
               resource: "sales.order",
               file_id: file.id
             })
             |> Ash.create(actor: actor)

    assert Exception.message(err) =~ "company_name"
  end

  test "导出端到端：路径占位符（公司/对手/枚举/计算字段）与明细循环" do
    company = company!(%{name: "京泰电气有限公司", code: "JT"})

    # actor 快照公司授权，须先授权再构建
    actor =
      [
        "sys.file:create",
        "sys.print_template:create",
        "sys.print_template:read",
        "sales.order:read",
        "sales.order:export"
      ]
      |> actor_with_company!(company)

    customer =
      SynieCore.Sales.Customer
      |> Ash.Changeset.for_create(:create, %{
        code: "C-#{System.unique_integer([:positive])}",
        name: "测试客户甲"
      })
      |> Ash.create!(authorize?: false)

    kg =
      SynieCore.Base.Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kgs",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      SynieCore.Inv.MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "M#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material =
      Ash.Seed.seed!(SynieCore.Inv.Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "螺丝",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    order =
      SynieCore.Sales.Order
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        party_type: :customer,
        party_id: customer.id,
        order_no: "SO-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-23],
        order_type: :sample
      })
      |> Ash.create!(authorize?: false)

    SynieCore.Sales.OrderItem
    |> Ash.Changeset.for_create(:create, %{
      order_id: order.id,
      material_id: material.id,
      unit_id: kg.id,
      idx: 1,
      qty: 2,
      price: Decimal.new("3.50")
    })
    |> Ash.create!(authorize?: false)

    file =
      upload_xlsx!(actor, [
        ["${company.name}", "${party.name}", "${status}", "${gross_total}"],
        ["${items._seq}", "${items.material_name}", "${items.qty}"]
      ])

    {:ok, template} =
      Template
      |> Ash.Changeset.for_create(:create, %{
        name: "路径版",
        resource: "sales.order",
        file_id: file.id
      })
      |> Ash.create(actor: actor)

    assert {:ok, %{binary: bin, filename: filename}} =
             SynieCore.Printing.export("sales.order", [order.id], template.id, actor)

    assert filename =~ order.order_no

    sheets = Map.new(PrintingFixture.read_all_sheets(bin))
    assert [[company_name, party_name, status, gross_total], item_row] = sheets[order.order_no]

    assert company_name == "京泰电气有限公司"
    assert party_name == "测试客户甲"
    assert status == "草稿"
    assert gross_total == "7.00"
    assert item_row == ["1", "螺丝", "2"]
  end

  test "导出端到端：BOM 多循环区（配料/工艺路线/副产品各占一段）" do
    actor =
      actor!([
        "sys.file:create",
        "sys.print_template:create",
        "sys.print_template:read",
        "mfg.bom:read",
        "mfg.bom:export"
      ])

    kg =
      SynieCore.Base.Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kgs",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      SynieCore.Inv.MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "M#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    uniq = System.unique_integer([:positive])

    product =
      Ash.Seed.seed!(SynieCore.Inv.Material, %{
        code: "MAT-P-#{uniq}",
        name: "滤筒成品",
        spec: "S1",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    copper =
      Ash.Seed.seed!(SynieCore.Inv.Material, %{
        code: "MAT-C-#{uniq}",
        name: "铜排",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    scrap =
      Ash.Seed.seed!(SynieCore.Inv.Material, %{
        code: "MAT-S-#{uniq}",
        name: "铜屑",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    operation =
      SynieCore.Mfg.Operation
      |> Ash.Changeset.for_create(:create, %{code: "GX-#{uniq}", name: "冲网"})
      |> Ash.create!(authorize?: false)

    bom =
      SynieCore.Mfg.Bom
      |> Ash.Changeset.for_create(:create, %{material_id: product.id})
      |> Ash.create!(authorize?: false)

    SynieCore.Mfg.BomComponent
    |> Ash.Changeset.for_create(:create, %{
      bom_id: bom.id,
      material_id: copper.id,
      unit_id: kg.id,
      quantity: Decimal.new("2.5")
    })
    |> Ash.create!(authorize?: false)

    SynieCore.Mfg.BomRoute
    |> Ash.Changeset.for_create(:create, %{
      bom_id: bom.id,
      operation_id: operation.id,
      seq: 1,
      requirement: "慢速",
      is_outsourced: false
    })
    |> Ash.create!(authorize?: false)

    SynieCore.Mfg.BomByproduct
    |> Ash.Changeset.for_create(:create, %{
      bom_id: bom.id,
      material_id: scrap.id,
      unit_id: kg.id,
      quantity: Decimal.new("0.3")
    })
    |> Ash.create!(authorize?: false)

    file =
      upload_xlsx!(actor, [
        ["${material.name}", "${material.code}"],
        ["${components._seq}", "${components.material.name}", "${components.quantity}"],
        ["${routes._seq}", "${routes.operation.name}", "${routes.requirement}"],
        ["${byproducts._seq}", "${byproducts.material.name}", "${byproducts.quantity}"],
        ["尾注 ${material.spec}"]
      ])

    {:ok, template} =
      Template
      |> Ash.Changeset.for_create(:create, %{
        name: "BOM 多循环",
        resource: "mfg.bom",
        file_id: file.id
      })
      |> Ash.create(actor: actor)

    assert {:ok, %{binary: bin}} =
             SynieCore.Printing.export("mfg.bom", [bom.id], template.id, actor)

    [sheet | _] = PrintingFixture.read_all_sheets(bin)
    {_sheet_name, rows} = sheet

    assert rows == [
             ["滤筒成品", "MAT-P-#{uniq}"],
             ["1", "铜排", "2.5"],
             ["1", "冲网", "慢速"],
             ["1", "铜屑", "0.3"],
             ["尾注 S1"]
           ]
  end

  test "导出端到端：无 has_many 主数据资源（物料）纯字段替换" do
    actor =
      actor!([
        "sys.file:create",
        "sys.print_template:create",
        "sys.print_template:read",
        "inv.material:read",
        "inv.material:export"
      ])

    kg =
      SynieCore.Base.Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kgs",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      SynieCore.Inv.MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "M#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material =
      Ash.Seed.seed!(SynieCore.Inv.Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "螺丝",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    file =
      upload_xlsx!(actor, [
        ["${code}", "${name}", "${category.name}", "${default_unit.name}", "${active}"]
      ])

    {:ok, template} =
      Template
      |> Ash.Changeset.for_create(:create, %{
        name: "物料卡",
        resource: "inv.material",
        file_id: file.id
      })
      |> Ash.create(actor: actor)

    assert {:ok, %{binary: bin}} =
             SynieCore.Printing.export("inv.material", [material.id], template.id, actor)

    [{_sheet_name, rows} | _] = PrintingFixture.read_all_sheets(bin)
    assert rows == [[material.code, "螺丝", "原材料", "千克", "是"]]
  end

  test "含 map 数组属性的资源可装配导出（sys.numbering_rule）" do
    rule =
      Ash.Seed.seed!(SynieCore.Numbering.Rule, %{
        resource: "sales.order",
        name: "回归测试规则",
        segments: [%{"type" => "literal", "text" => "SO"}]
      })

    assert {:ok, %{fields: fields}} =
             SynieCore.Printing.DocBuilder.build("sys.numbering_rule", rule)

    assert fields["segments"] =~ "literal"

    # 契约：装配结果全部 value 均为字符串（map/嵌套结构安全序列化，不再崩）
    assert Enum.all?(fields, fn {_, v} -> is_binary(v) end)
  end

  # 带公司授权的 actor：先建用户/角色/权限与公司授权，再构建 actor（actor 快照公司集合）
  defp actor_with_company!(perms, company) do
    user = user!()
    role = role!()
    Enum.each(perms, &grant!(role, &1))
    assign!(user, role)
    grant_company!(user, company)
    Authz.build_actor(user)
  end
end
