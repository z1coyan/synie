defmodule SynieCore.Mfg.MfgTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, MaterialUnit}

  alias SynieCore.Mfg.{
    Bom,
    BomByproduct,
    BomComponent,
    BomRoute,
    Operation,
    ProcessTemplate,
    ProcessTemplateItem
  }

  alias SynieCore.Numbering.Rule

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    n = System.unique_integer([:positive])
    leaf = category!(%{code: "01#{n}", name: "原材料"})

    kg = unit!(%{unit_type: :weight, name: "千克#{n}", symbol: "kg#{n}", ratio: 1})
    pcs = unit!(%{unit_type: :quantity, name: "只#{n}", symbol: "p#{n}", ratio: 1})

    %{leaf: leaf, kg: kg, pcs: pcs}
  end

  defp category!(attrs) do
    MaterialCategory
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp unit!(attrs) do
    Unit
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp material!(attrs) do
    ensure_numbering_rule!("inv.material", "物料编号", [
      %{"type" => "field", "field" => "category.code"},
      %{"type" => "field", "field" => "customer.code"},
      %{"type" => "text", "value" => "-"},
      %{"type" => "seq", "padding" => 0}
    ])

    Material
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp material_unit!(attrs) do
    MaterialUnit
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # 编号留空自动取号、手填原样保留:夹具一律显式给唯一编号,避免并发测试在
  # 「resource 唯一」的编号规则表上互插同一键而锁冲突(同表 SetupTest 种子也会插);
  # 自动取号本身由「编号」describe 单独覆盖(仅此两处插规则行)
  defp operation!(attrs) do
    attrs = Map.put_new_lazy(attrs, :code, fn -> "GX-#{System.unique_integer([:positive])}" end)

    Operation
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp template!(attrs) do
    attrs = Map.put_new_lazy(attrs, :code, fn -> "MB-#{System.unique_integer([:positive])}" end)

    ProcessTemplate
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp ensure_numbering_rule!(resource, name, segments) do
    exists? =
      Rule
      |> Ash.Query.filter(resource == ^resource and enabled == true)
      |> Ash.exists?(authorize?: false)

    unless exists? do
      Rule
      |> Ash.Changeset.for_create(:create, %{
        resource: resource,
        name: name,
        segments: segments,
        per_company: false,
        enabled: true
      })
      |> Ash.create!(authorize?: false)
    end
  end

  defp template_item!(attrs) do
    ProcessTemplateItem
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp bom!(material, attrs \\ %{}) do
    Bom
    |> Ash.Changeset.for_create(:create, Map.merge(%{material_id: material.id}, attrs))
    |> Ash.create!(authorize?: false)
  end

  defp component!(attrs) do
    BomComponent
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp route!(attrs) do
    BomRoute
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp byproduct!(attrs) do
    BomByproduct
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp actor(permissions) do
    %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(permissions)}
  end

  defp product(%{leaf: leaf, kg: kg}, name \\ "成品") do
    material!(%{name: name, category_id: leaf.id, default_unit_id: kg.id})
  end

  describe "编号" do
    test "留空自动取号:M(O)-4 位序号 / M(T)-4 位序号" do
      ensure_numbering_rule!("mfg.operation", "工序编号", [
        %{"type" => "text", "value" => "M(O)-"},
        %{"type" => "seq", "padding" => 4}
      ])

      ensure_numbering_rule!("mfg.route_template", "工艺模板编号", [
        %{"type" => "text", "value" => "M(T)-"},
        %{"type" => "seq", "padding" => 4}
      ])

      op =
        Operation
        |> Ash.Changeset.for_create(:create, %{name: "冲网"})
        |> Ash.create!(authorize?: false)

      assert op.code == "M(O)-0001"

      template =
        ProcessTemplate
        |> Ash.Changeset.for_create(:create, %{name: "标准工艺"})
        |> Ash.create!(authorize?: false)

      assert template.code == "M(T)-0001"
    end
  end

  describe "工序" do
    test "基本 CRUD:手填原样保留,编号唯一" do
      manual = operation!(%{code: "GX-99", name: "焊接", note: "外发"})
      assert manual.code == "GX-99"
      assert manual.note == "外发"

      updated =
        manual
        |> Ash.Changeset.for_update(:update, %{name: "焊接成筒"})
        |> Ash.update!(authorize?: false)

      assert updated.name == "焊接成筒"

      assert_raise Ash.Error.Invalid, ~r/工序编号已存在/, fn ->
        operation!(%{code: "GX-99", name: "重复编号"})
      end

      :ok = updated |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
      assert match?({:error, _}, Ash.get(Operation, updated.id, authorize?: false))
    end

    test "编号创建后不可修改" do
      op = operation!(%{name: "分切"})

      assert_raise Ash.Error.Invalid, fn ->
        op
        |> Ash.Changeset.for_update(:update, %{code: "X-1"})
        |> Ash.update!(authorize?: false)
      end
    end

    test "被工艺路线或模板行引用后不可删除,无引用可删", %{leaf: leaf, kg: kg} do
      op_route = operation!(%{name: "冲网"})
      op_tpl = operation!(%{name: "CNC"})
      op_free = operation!(%{name: "分切"})

      bom = product(%{leaf: leaf, kg: kg}) |> bom!()
      route!(%{bom_id: bom.id, operation_id: op_route.id, seq: 1})

      template = template!(%{name: "标准工艺"})
      template_item!(%{template_id: template.id, operation_id: op_tpl.id, seq: 1})

      assert_raise Ash.Error.Invalid, ~r/工序已被工艺路线或工艺模板引用,不能删除/, fn ->
        op_route |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
      end

      assert_raise Ash.Error.Invalid, ~r/工序已被工艺路线或工艺模板引用,不能删除/, fn ->
        op_tpl |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
      end

      :ok = op_free |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    end
  end

  describe "工艺模板" do
    test "基本 CRUD:行随模板级联删" do
      op = operation!(%{name: "冲网"})
      template = template!(%{name: "标准工艺", note: "v1"})
      assert template.note == "v1"

      item =
        template_item!(%{
          template_id: template.id,
          operation_id: op.id,
          seq: 1,
          requirement: "毛刺≤0.1",
          is_outsourced: true
        })

      assert item.seq == 1
      assert item.requirement == "毛刺≤0.1"
      assert item.is_outsourced == true

      updated =
        item
        |> Ash.Changeset.for_update(:update, %{seq: 2, is_outsourced: false})
        |> Ash.update!(authorize?: false)

      assert updated.seq == 2
      assert updated.is_outsourced == false

      :ok = template |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
      assert [] = Ash.read!(ProcessTemplateItem, authorize?: false)
    end
  end

  describe "BOM" do
    test "一物料一张:material 唯一,创建后不可换物料", ctx do
      m = product(ctx)
      bom = bom!(m, %{note: "首版"})
      assert bom.material_id == m.id
      assert bom.note == "首版"

      assert_raise Ash.Error.Invalid, ~r/该物料已存在 BOM/, fn ->
        bom!(m)
      end

      other = product(ctx, "另一个")

      assert_raise Ash.Error.Invalid, fn ->
        bom
        |> Ash.Changeset.for_update(:update, %{material_id: other.id})
        |> Ash.update!(authorize?: false)
      end

      updated =
        bom
        |> Ash.Changeset.for_update(:update, %{note: "改注"})
        |> Ash.update!(authorize?: false)

      assert updated.note == "改注"
    end

    test "删 BOM 级联删三类行", ctx do
      op = operation!(%{name: "冲网"})
      bom = product(ctx) |> bom!()
      child = product(ctx, "子料")

      component!(%{bom_id: bom.id, material_id: child.id, unit_id: ctx.kg.id, quantity: "2"})
      route!(%{bom_id: bom.id, operation_id: op.id, seq: 1})
      byproduct!(%{bom_id: bom.id, material_id: child.id, unit_id: ctx.kg.id, quantity: "0.5"})

      :ok = bom |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)

      assert [] = Ash.read!(BomComponent, authorize?: false)
      assert [] = Ash.read!(BomRoute, authorize?: false)
      assert [] = Ash.read!(BomByproduct, authorize?: false)
    end
  end

  describe "配料行" do
    test "净用量>0、损耗率>=0", ctx do
      bom = product(ctx) |> bom!()
      child = product(ctx, "子料")

      row =
        component!(%{
          bom_id: bom.id,
          material_id: child.id,
          unit_id: ctx.kg.id,
          quantity: "1.5",
          loss_rate: "0.03",
          note: "含损耗"
        })

      assert Decimal.equal?(row.quantity, Decimal.new("1.5"))
      assert Decimal.equal?(row.loss_rate, Decimal.new("0.03"))

      assert_raise Ash.Error.Invalid, ~r/单位净用量必须大于 0/, fn ->
        component!(%{bom_id: bom.id, material_id: child.id, unit_id: ctx.kg.id, quantity: "0"})
      end

      assert_raise Ash.Error.Invalid, ~r/损耗率不能为负/, fn ->
        component!(%{
          bom_id: bom.id,
          material_id: child.id,
          unit_id: ctx.kg.id,
          quantity: "1",
          loss_rate: "-0.1"
        })
      end
    end

    test "子物料不能是 BOM 物料自身", ctx do
      m = product(ctx)
      bom = bom!(m)

      assert_raise Ash.Error.Invalid, ~r/行物料不能是 BOM 物料自身/, fn ->
        component!(%{bom_id: bom.id, material_id: m.id, unit_id: ctx.kg.id, quantity: "1"})
      end
    end

    test "单位限默认单位或其转换单位", ctx do
      bom = product(ctx) |> bom!()
      child = product(ctx, "子料")

      # 非默认单位且无转换行:拒
      assert_raise Ash.Error.Invalid, ~r/单位必须是物料默认单位或其单位转换单位/, fn ->
        component!(%{bom_id: bom.id, material_id: child.id, unit_id: ctx.pcs.id, quantity: "1"})
      end

      # 建转换行后允许
      material_unit!(%{material_id: child.id, unit_id: ctx.pcs.id, factor: "100"})

      row =
        component!(%{bom_id: bom.id, material_id: child.id, unit_id: ctx.pcs.id, quantity: "3"})

      assert row.unit_id == ctx.pcs.id
    end
  end

  describe "副产品行" do
    test "产出量>0;物料不能是 BOM 物料自身;单位限默认或转换单位", ctx do
      m = product(ctx)
      bom = bom!(m)
      scrap = product(ctx, "铜屑")

      row =
        byproduct!(%{bom_id: bom.id, material_id: scrap.id, unit_id: ctx.kg.id, quantity: "0.5"})

      assert Decimal.equal?(row.quantity, Decimal.new("0.5"))

      assert_raise Ash.Error.Invalid, ~r/单位产出量必须大于 0/, fn ->
        byproduct!(%{bom_id: bom.id, material_id: scrap.id, unit_id: ctx.kg.id, quantity: "0"})
      end

      assert_raise Ash.Error.Invalid, ~r/行物料不能是 BOM 物料自身/, fn ->
        byproduct!(%{bom_id: bom.id, material_id: m.id, unit_id: ctx.kg.id, quantity: "1"})
      end

      assert_raise Ash.Error.Invalid, ~r/单位必须是物料默认单位或其单位转换单位/, fn ->
        byproduct!(%{bom_id: bom.id, material_id: scrap.id, unit_id: ctx.pcs.id, quantity: "1"})
      end
    end
  end

  describe "工艺路线行" do
    test "逐行添加:工序引用+顺序+要求+外协标记", ctx do
      op = operation!(%{name: "冲网"})
      bom = product(ctx) |> bom!()

      route =
        route!(%{
          bom_id: bom.id,
          operation_id: op.id,
          seq: 1,
          requirement: "双面冲",
          is_outsourced: true
        })

      assert route.operation_id == op.id
      assert route.seq == 1
      assert route.is_outsourced == true

      updated =
        route
        |> Ash.Changeset.for_update(:update, %{seq: 2, is_outsourced: false})
        |> Ash.update!(authorize?: false)

      assert updated.seq == 2

      :ok = route |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
      assert [] = Ash.read!(BomRoute, authorize?: false)
    end
  end

  describe "从模板带入路线" do
    test "按 seq 复制为 BOM 私行,此后模板再改不影响", ctx do
      op1 = operation!(%{name: "冲网"})
      op2 = operation!(%{name: "焊接"})
      template = template!(%{name: "标准工艺"})

      template_item!(%{
        template_id: template.id,
        operation_id: op2.id,
        seq: 2,
        requirement: "氩弧焊",
        is_outsourced: true
      })

      template_item!(%{template_id: template.id, operation_id: op1.id, seq: 1})

      bom = product(ctx) |> bom!()

      bom
      |> Ash.Changeset.for_update(:apply_route_template, %{template_id: template.id})
      |> Ash.update!(authorize?: false)

      routes =
        BomRoute
        |> Ash.Query.filter(bom_id == ^bom.id)
        |> Ash.Query.sort(seq: :asc)
        |> Ash.read!(authorize?: false)

      assert [r1, r2] = routes
      assert {r1.seq, r1.operation_id} == {1, op1.id}
      assert {r2.seq, r2.operation_id} == {2, op2.id}
      assert r2.requirement == "氩弧焊"
      assert r2.is_outsourced == true

      # 快照语义:删模板行不影响已带入的 BOM 路线
      ProcessTemplateItem
      |> Ash.read!(authorize?: false)
      |> Enum.each(
        &(&1
          |> Ash.Changeset.for_destroy(:destroy)
          |> Ash.destroy!(authorize?: false))
      )

      assert BomRoute
             |> Ash.Query.filter(bom_id == ^bom.id)
             |> Ash.read!(authorize?: false)
             |> length() == 2
    end

    test "已有路线时拒绝带入", ctx do
      op = operation!(%{name: "冲网"})
      template = template!(%{name: "标准工艺"})
      template_item!(%{template_id: template.id, operation_id: op.id, seq: 1})

      bom = product(ctx) |> bom!()
      route!(%{bom_id: bom.id, operation_id: op.id, seq: 1})

      assert_raise Ash.Error.Invalid, ~r/已有工艺路线,不能从模板带入/, fn ->
        bom
        |> Ash.Changeset.for_update(:apply_route_template, %{template_id: template.id})
        |> Ash.update!(authorize?: false)
      end
    end

    test "模板不存在时报工艺模板不存在", ctx do
      bom = product(ctx) |> bom!()

      assert_raise Ash.Error.Invalid, ~r/工艺模板不存在/, fn ->
        bom
        |> Ash.Changeset.for_update(:apply_route_template, %{template_id: Ash.UUID.generate()})
        |> Ash.update!(authorize?: false)
      end
    end
  end

  describe "权限" do
    test "主数据读写按各自权限码", ctx do
      operation!(%{name: "冲网"})
      template!(%{name: "标准工艺"})
      bom!(product(ctx))

      assert [_] = Ash.read!(Operation, actor: actor(["mfg.operation:read"]))
      assert [_] = Ash.read!(ProcessTemplate, actor: actor(["mfg.route_template:read"]))
      assert [_] = Ash.read!(Bom, actor: actor(["mfg.bom:read"]))

      assert_raise Ash.Error.Forbidden, fn -> Ash.read!(Operation, actor: actor([])) end
      assert_raise Ash.Error.Forbidden, fn -> Ash.read!(ProcessTemplate, actor: actor([])) end
      assert_raise Ash.Error.Forbidden, fn -> Ash.read!(Bom, actor: actor([])) end

      assert_raise Ash.Error.Forbidden, fn ->
        Operation
        |> Ash.Changeset.for_create(:create, %{code: "GX-1", name: "分切"})
        |> Ash.create!(actor: actor(["mfg.operation:read"]))
      end

      assert_raise Ash.Error.Forbidden, fn ->
        ProcessTemplate
        |> Ash.Changeset.for_create(:create, %{code: "MB-1", name: "模板"})
        |> Ash.create!(actor: actor(["mfg.route_template:read"]))
      end
    end

    test "行子表无独立权限点:增删跟随主表 update 码", ctx do
      op = operation!(%{name: "冲网"})
      bom = product(ctx) |> bom!()

      route =
        BomRoute
        |> Ash.Changeset.for_create(:create, %{bom_id: bom.id, operation_id: op.id, seq: 1})
        |> Ash.create!(actor: actor(["mfg.bom:update"]))

      assert [_] = Ash.read!(BomRoute, actor: actor(["mfg.bom:read"]))

      assert_raise Ash.Error.Forbidden, fn ->
        BomRoute
        |> Ash.Changeset.for_create(:create, %{bom_id: bom.id, operation_id: op.id, seq: 2})
        |> Ash.create!(actor: actor(["mfg.bom:read"]))
      end

      :ok =
        route
        |> Ash.Changeset.for_destroy(:destroy)
        |> Ash.destroy!(actor: actor(["mfg.bom:update"]))
    end

    test "apply_route_template 复用 mfg.bom:update 码", ctx do
      op = operation!(%{name: "冲网"})
      template = template!(%{name: "标准工艺"})
      template_item!(%{template_id: template.id, operation_id: op.id, seq: 1})
      bom = product(ctx) |> bom!()

      assert_raise Ash.Error.Forbidden, fn ->
        bom
        |> Ash.Changeset.for_update(:apply_route_template, %{template_id: template.id})
        |> Ash.update!(actor: actor(["mfg.bom:read"]))
      end

      bom
      |> Ash.Changeset.for_update(:apply_route_template, %{template_id: template.id})
      |> Ash.update!(actor: actor(["mfg.bom:read", "mfg.bom:update"]))

      assert [_] = Ash.read!(BomRoute, authorize?: false)
    end

    test "资源声明了权限前缀与动作" do
      assert Operation.permission_prefix() == "mfg.operation"
      assert Operation.permission_label() == "工序"
      assert Operation.permission_actions() == ~w(create read update delete)
      assert ProcessTemplate.permission_prefix() == "mfg.route_template"
      assert ProcessTemplate.permission_label() == "工艺模板"
      assert Bom.permission_prefix() == "mfg.bom"
      assert Bom.permission_label() == "BOM"

      for row <- [ProcessTemplateItem, BomComponent, BomRoute, BomByproduct] do
        assert row.permission_actions() == []
      end
    end
  end
end
