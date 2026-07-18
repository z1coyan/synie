defmodule SynieCore.Inv.MaterialTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, MaterialUnit}
  alias SynieCore.Numbering.Rule
  alias SynieCore.Sales.Customer

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    n = System.unique_integer([:positive])
    leaf = category!(%{code: "01#{n}", name: "原材料"})
    # 不抢 is_base(每类型全局唯一,async 测试会撞);物料测试不依赖基准单位语义
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
    Material
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp material_unit!(attrs) do
    MaterialUnit
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # seed 同款规则:分类+客户(空省略)+"-"+4 位序号
  defp numbering_rule! do
    Rule
    |> Ash.Changeset.for_create(:create, %{
      resource: "inv.material",
      name: "物料编号",
      segments: [
        %{"type" => "field", "field" => "category.code"},
        %{"type" => "field", "field" => "customer.code"},
        %{"type" => "text", "value" => "-"},
        %{"type" => "seq", "padding" => 4}
      ],
      per_company: false,
      enabled: true
    })
    |> Ash.create!(authorize?: false)
  end

  defp customer!(attrs \\ %{}) do
    attrs =
      Map.merge(
        %{
          code: "C#{System.unique_integer([:positive])}",
          name: "测试客户",
          short_name: "测客"
        },
        attrs
      )

    Customer
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp actor(permissions) do
    %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(permissions)}
  end

  describe "编号" do
    test "留空自动取号:分类编号-4 位序号,每分类各自计数", %{leaf: leaf, kg: kg} do
      numbering_rule!()
      other = category!(%{code: "02#{System.unique_integer([:positive])}", name: "半成品"})

      m1 = material!(%{name: "螺丝", category_id: leaf.id, default_unit_id: kg.id})
      m2 = material!(%{name: "螺母", category_id: leaf.id, default_unit_id: kg.id})
      m3 = material!(%{name: "垫片", category_id: other.id, default_unit_id: kg.id})

      assert m1.code == "#{leaf.code}-0001"
      assert m2.code == "#{leaf.code}-0002"
      assert m3.code == "#{other.code}-0001"
    end

    test "客户物料取号含客户编号,与通用料分桶计数", %{leaf: leaf, kg: kg} do
      numbering_rule!()
      cust = customer!(%{code: "77"})

      general = material!(%{name: "通用螺丝", category_id: leaf.id, default_unit_id: kg.id})

      owned =
        material!(%{
          name: "定制件",
          category_id: leaf.id,
          default_unit_id: kg.id,
          is_customer_material: true,
          customer_id: cust.id
        })

      assert general.code == "#{leaf.code}-0001"
      assert owned.code == "#{leaf.code}77-0001"
    end

    test "手填编号原样保留,重复编号被拒", %{leaf: leaf, kg: kg} do
      numbering_rule!()

      m = material!(%{code: "X-1", name: "螺丝", category_id: leaf.id, default_unit_id: kg.id})
      assert m.code == "X-1"

      assert_raise Ash.Error.Invalid, fn ->
        material!(%{code: "X-1", name: "螺母", category_id: leaf.id, default_unit_id: kg.id})
      end
    end

    test "无启用规则且留空时报错提示配置", %{leaf: leaf, kg: kg} do
      assert_raise Ash.Error.Invalid, ~r/未配置启用的编号规则/, fn ->
        material!(%{name: "螺丝", category_id: leaf.id, default_unit_id: kg.id})
      end
    end
  end

  describe "分类约束" do
    test "只能挂叶子分类", %{kg: kg} do
      group = category!(%{code: "09", name: "汇总层", is_leaf: false})

      assert_raise Ash.Error.Invalid, ~r/物料只能挂叶子分类/, fn ->
        material!(%{code: "M1", name: "螺丝", category_id: group.id, default_unit_id: kg.id})
      end
    end

    test "分类下存在物料:不能删除、不能改为非叶子", %{leaf: leaf, kg: kg} do
      material!(%{code: "M1", name: "螺丝", category_id: leaf.id, default_unit_id: kg.id})

      assert_raise Ash.Error.Invalid, ~r/分类下存在物料,不能删除/, fn ->
        leaf |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
      end

      assert_raise Ash.Error.Invalid, ~r/分类下存在物料,不能改为非叶子/, fn ->
        leaf
        |> Ash.Changeset.for_update(:update, %{is_leaf: false})
        |> Ash.update!(authorize?: false)
      end
    end
  end

  describe "单位转换" do
    test "录入转换行:系数>0,(物料,单位)唯一,不能选默认单位", %{leaf: leaf, kg: kg, pcs: pcs} do
      m = material!(%{code: "M1", name: "产品A", category_id: leaf.id, default_unit_id: kg.id})

      row = material_unit!(%{material_id: m.id, unit_id: pcs.id, factor: "518"})
      assert Decimal.equal?(row.factor, Decimal.new("518"))

      assert_raise Ash.Error.Invalid, ~r/该单位已有转换行/, fn ->
        material_unit!(%{material_id: m.id, unit_id: pcs.id, factor: "600"})
      end

      assert_raise Ash.Error.Invalid, ~r/换算系数必须大于 0/, fn ->
        material_unit!(%{material_id: m.id, unit_id: kg.id, factor: "0"})
      end

      assert_raise Ash.Error.Invalid, ~r/转换单位不能与默认单位相同/, fn ->
        material_unit!(%{material_id: m.id, unit_id: kg.id, factor: "2"})
      end
    end

    test "同类型单位允许(箱/包等包装单位场景)", %{leaf: leaf, kg: kg} do
      g = unit!(%{unit_type: :weight, name: "克", symbol: "g", ratio: "0.001"})
      m = material!(%{code: "M1", name: "钢材", category_id: leaf.id, default_unit_id: kg.id})

      row = material_unit!(%{material_id: m.id, unit_id: g.id, factor: "1000"})
      assert Decimal.equal?(row.factor, Decimal.new("1000"))
    end

    test "有转换行禁止改默认单位,删行后可改", %{leaf: leaf, kg: kg, pcs: pcs} do
      m = material!(%{code: "M1", name: "产品A", category_id: leaf.id, default_unit_id: kg.id})
      row = material_unit!(%{material_id: m.id, unit_id: pcs.id, factor: "518"})

      assert_raise Ash.Error.Invalid, ~r/存在单位转换行,不能修改默认单位/, fn ->
        m
        |> Ash.Changeset.for_update(:update, %{default_unit_id: pcs.id})
        |> Ash.update!(authorize?: false)
      end

      :ok = row |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)

      changed =
        m
        |> Ash.Changeset.for_update(:update, %{default_unit_id: pcs.id})
        |> Ash.update!(authorize?: false)

      assert changed.default_unit_id == pcs.id
    end

    test "删物料级联删转换行", %{leaf: leaf, kg: kg, pcs: pcs} do
      m = material!(%{code: "M1", name: "产品A", category_id: leaf.id, default_unit_id: kg.id})
      material_unit!(%{material_id: m.id, unit_id: pcs.id, factor: "518"})

      :ok = m |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)

      assert [] = Ash.read!(MaterialUnit, authorize?: false)
    end
  end

  describe "客户约束" do
    test "客户物料必填客户;非客户料清空客户与对方料号", %{leaf: leaf, kg: kg} do
      cust = customer!()

      assert_raise Ash.Error.Invalid, ~r/客户物料必须选择客户/, fn ->
        material!(%{
          code: "M1",
          name: "定制",
          category_id: leaf.id,
          default_unit_id: kg.id,
          is_customer_material: true
        })
      end

      m =
        material!(%{
          code: "M2",
          name: "定制",
          category_id: leaf.id,
          default_unit_id: kg.id,
          is_customer_material: true,
          customer_id: cust.id,
          customer_part_no: "KH-1"
        })

      assert m.is_customer_material
      assert m.customer_id == cust.id
      assert m.customer_part_no == "KH-1"

      general =
        m
        |> Ash.Changeset.for_update(:update, %{is_customer_material: false})
        |> Ash.update!(authorize?: false)

      assert general.is_customer_material == false
      assert general.customer_id == nil
      assert general.customer_part_no == nil
    end

    test "非客户料提交对方料号时被清空", %{leaf: leaf, kg: kg} do
      m =
        material!(%{
          code: "M1",
          name: "通用",
          category_id: leaf.id,
          default_unit_id: kg.id,
          customer_part_no: "X"
        })

      assert m.customer_part_no == nil
    end

    test "有物料引用的客户不能删除", %{leaf: leaf, kg: kg} do
      cust = customer!()

      material!(%{
        code: "M1",
        name: "定制",
        category_id: leaf.id,
        default_unit_id: kg.id,
        is_customer_material: true,
        customer_id: cust.id
      })

      assert_raise Ash.Error.Invalid, ~r/存在关联物料,不能删除/, fn ->
        cust |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
      end
    end
  end

  describe "权限" do
    test "物料读写按 inv.material 权限码", %{leaf: leaf, kg: kg} do
      material!(%{code: "M1", name: "螺丝", category_id: leaf.id, default_unit_id: kg.id})

      assert [_] = Ash.read!(Material, actor: actor(["inv.material:read"]))

      assert_raise Ash.Error.Forbidden, fn ->
        Ash.read!(Material, actor: actor([]))
      end
    end

    test "转换行无独立权限点:增删跟随 inv.material:update", %{leaf: leaf, kg: kg, pcs: pcs} do
      box = unit!(%{unit_type: :quantity, name: "箱", symbol: "箱", ratio: 24})
      m = material!(%{code: "M1", name: "产品A", category_id: leaf.id, default_unit_id: kg.id})

      row =
        MaterialUnit
        |> Ash.Changeset.for_create(:create, %{material_id: m.id, unit_id: pcs.id, factor: "518"})
        |> Ash.create!(actor: actor(["inv.material:update"]))

      assert [_] = Ash.read!(MaterialUnit, actor: actor(["inv.material:read"]))

      assert_raise Ash.Error.Forbidden, fn ->
        MaterialUnit
        |> Ash.Changeset.for_create(:create, %{material_id: m.id, unit_id: box.id, factor: "2"})
        |> Ash.create!(actor: actor(["inv.material:read"]))
      end

      :ok =
        row
        |> Ash.Changeset.for_destroy(:destroy)
        |> Ash.destroy!(actor: actor(["inv.material:update"]))
    end

    test "资源声明了权限前缀" do
      assert Material.permission_prefix() == "inv.material"
      assert Material.permission_actions() == ~w(create read update delete)
      assert MaterialUnit.permission_prefix() == "inv.material"
      assert MaterialUnit.permission_actions() == []
    end
  end
end
