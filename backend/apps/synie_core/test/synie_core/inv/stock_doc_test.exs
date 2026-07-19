defmodule SynieCore.Inv.StockDocTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, MaterialUnit, StockDoc, StockDocItem}
  alias SynieCore.Inv.{StockEntry, Warehouse}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    other_company = company!()

    # 不抢迁移内置与各测试模块的 symbol(全局唯一)
    kg = unit!(%{unit_type: :weight, name: "千克", symbol: "kg-sd", ratio: 1})
    box = unit!(%{unit_type: :quantity, name: "箱", symbol: "箱-sd", ratio: 1})
    pcs = unit!(%{unit_type: :quantity, name: "只", symbol: "只-sd", ratio: 1})

    category =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "SD#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material = material!(category, kg, %{name: "螺丝", spec: "M6×20"})

    # 转换单位:1 kg = 10 箱
    MaterialUnit
    |> Ash.Changeset.for_create(:create, %{material_id: material.id, unit_id: box.id, factor: 10})
    |> Ash.create!(authorize?: false)

    warehouse = warehouse!(%{name: "主仓", company_id: company.id})

    %{
      company: company,
      other_company: other_company,
      kg: kg,
      box: box,
      pcs: pcs,
      category: category,
      material: material,
      warehouse: warehouse
    }
  end

  defp unit!(attrs),
    do: Unit |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

  defp warehouse!(attrs),
    do: Warehouse |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

  defp material!(category, unit, attrs) do
    Ash.Seed.seed!(
      Material,
      Map.merge(
        %{code: "MAT-#{System.unique_integer([:positive])}", name: "螺母"},
        Map.merge(attrs, %{category_id: category.id, default_unit_id: unit.id})
      )
    )
  end

  # direction 缺省 :in(入库);出库单传 direction: :out
  defp stock_doc!(attrs) do
    attrs =
      Map.merge(
        %{
          doc_no: "CRK-#{System.unique_integer([:positive])}",
          doc_date: ~D[2026-07-19],
          direction: :in
        },
        attrs
      )

    StockDoc |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp item!(doc, attrs) do
    attrs = Map.merge(%{idx: 1, qty: 2}, attrs)

    StockDocItem
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{stock_doc_id: doc.id}))
    |> Ash.create!(authorize?: false)
  end

  defp audit!(doc, opts \\ [authorize?: false]) do
    doc |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(opts)
  end

  # 入库铺底:建一张已审核的入库单让仓里有货
  defp stock_in!(warehouse, material, unit, qty) do
    doc =
      stock_doc!(%{
        company_id: warehouse.company_id,
        warehouse_id: warehouse.id,
        direction: :in
      })

    item!(doc, %{material_id: material.id, unit_id: unit.id, qty: qty})
    audit!(doc)
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["inv.stock_doc:*"])},
      overrides
    )
  end

  defp entries_of(voucher_type, voucher_id) do
    StockEntry
    |> Ash.Query.filter(voucher_type == ^voucher_type and voucher_id == ^voucher_id)
    |> Ash.read!(authorize?: false)
  end

  defp balance(warehouse_id, material_id) do
    StockEntry
    |> Ash.Query.filter(
      warehouse_id == ^warehouse_id and material_id == ^material_id and is_cancelled == false
    )
    |> Ash.read!(authorize?: false)
    |> Enum.reduce(Decimal.new(0), &Decimal.add(&1.quantity, &2))
  end

  test "创建默认草稿态,业务日期缺省今天,录入人取 actor", %{company: co, warehouse: wh} do
    user = user!()
    actor = actor(user_id: user.id, company_ids: [co.id])

    doc =
      StockDoc
      |> Ash.Changeset.for_create(
        :create,
        %{
          company_id: co.id,
          warehouse_id: wh.id,
          direction: :in,
          doc_no: "CRK-手填-1"
        },
        actor: actor
      )
      |> Ash.create!()

    assert doc.status == :draft
    assert doc.direction == :in
    assert doc.doc_date == Date.utc_today()
    assert doc.created_by_id == user.id
    assert doc.audited_by_id == nil
  end

  test "direction 必填", %{company: co, warehouse: wh} do
    assert_raise Ash.Error.Invalid, fn ->
      StockDoc
      |> Ash.Changeset.for_create(:create, %{
        company_id: co.id,
        warehouse_id: wh.id,
        doc_no: "CRK-无向"
      })
      |> Ash.create!(authorize?: false)
    end
  end

  test "无公司授权不能创建(CompanyAccessible)", %{company: co, warehouse: wh} do
    assert_raise Ash.Error.Invalid, fn ->
      StockDoc
      |> Ash.Changeset.for_create(
        :create,
        %{company_id: co.id, warehouse_id: wh.id, direction: :in, doc_no: "CRK-X"},
        actor: actor(company_ids: [])
      )
      |> Ash.create!()
    end
  end

  test "单据编号全局唯一", %{company: co, other_company: other, warehouse: wh} do
    other_wh = warehouse!(%{name: "外司仓", company_id: other.id})
    doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})

    assert_raise Ash.Error.Invalid, ~r/单据编号已存在/, fn ->
      stock_doc!(%{company_id: other.id, warehouse_id: other_wh.id, doc_no: doc.doc_no})
    end
  end

  describe "direction 锁死" do
    test "创建后不可改(改向=重开一张单)", %{company: co, warehouse: wh} do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id, direction: :in})

      assert {:error, error} =
               doc
               |> Ash.Changeset.for_update(:update, %{direction: :out})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "出入库方向不可变更"

      assert Ash.get!(StockDoc, doc.id, authorize?: false).direction == :in
    end

    test "方向不变照常改其他字段", %{company: co, warehouse: wh} do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id, direction: :out})

      updated =
        doc
        |> Ash.Changeset.for_update(:update, %{direction: :out, remarks: "盘点报损"})
        |> Ash.update!(authorize?: false)

      assert updated.direction == :out
      assert updated.remarks == "盘点报损"
    end
  end

  describe "自动编号" do
    defp numbering_rule! do
      SynieCore.Numbering.Rule
      |> Ash.Changeset.for_create(
        :create,
        %{
          resource: "inv.stock_doc",
          name: "手工出入库单编号",
          segments: [
            %{"type" => "text", "value" => "CRK"},
            %{"type" => "field", "field" => "doc_date", "format" => "YYYYMMDD"},
            %{"type" => "text", "value" => "-"},
            %{"type" => "seq", "padding" => 4}
          ],
          per_company: true,
          enabled: true
        },
        authorize?: false
      )
      |> Ash.create!()
    end

    test "编号留空按规则自动取号,同公司递增", %{company: co, warehouse: wh} do
      numbering_rule!()

      create = fn ->
        StockDoc
        |> Ash.Changeset.for_create(:create, %{
          company_id: co.id,
          warehouse_id: wh.id,
          direction: :in,
          doc_date: ~D[2026-07-19]
        })
        |> Ash.create!(authorize?: false)
      end

      assert create.().doc_no == "CRK20260719-0001"
      assert create.().doc_no == "CRK20260719-0002"

      # 规则按公司计数(per_company),但 doc_no 全局唯一——他公司同日同前缀会撞号,
      # 属契约既定交互(全局唯一兜底),此处不展开
    end

    test "手填编号原样保留", %{company: co, warehouse: wh} do
      numbering_rule!()

      assert stock_doc!(%{company_id: co.id, warehouse_id: wh.id, doc_no: "CRK-手填"}).doc_no ==
               "CRK-手填"
    end

    test "无规则且留空报错提示配置规则", %{company: co, warehouse: wh} do
      error =
        assert_raise Ash.Error.Invalid, fn ->
          StockDoc
          |> Ash.Changeset.for_create(:create, %{
            company_id: co.id,
            warehouse_id: wh.id,
            direction: :out
          })
          |> Ash.create!(authorize?: false)
        end

      assert Exception.message(error) =~ "编号规则"
    end
  end

  describe "头仓校验" do
    test "非叶子/跨公司/停用/不存在的仓被拦", %{
      company: co,
      other_company: other,
      warehouse: wh
    } do
      root = warehouse!(%{name: "总仓", is_leaf: false, company_id: co.id})

      assert_raise Ash.Error.Invalid, ~r/只有叶子仓库才能发生库存/, fn ->
        stock_doc!(%{company_id: co.id, warehouse_id: root.id})
      end

      foreign = warehouse!(%{name: "外司仓", company_id: other.id})

      assert_raise Ash.Error.Invalid, ~r/仓库不属于本公司/, fn ->
        stock_doc!(%{company_id: co.id, warehouse_id: foreign.id})
      end

      inactive = warehouse!(%{name: "停用仓", company_id: co.id, active: false})

      assert_raise Ash.Error.Invalid, ~r/仓库已停用/, fn ->
        stock_doc!(%{company_id: co.id, warehouse_id: inactive.id})
      end

      assert_raise Ash.Error.Invalid, ~r/仓库不存在/, fn ->
        stock_doc!(%{company_id: co.id, warehouse_id: Ash.UUID.generate()})
      end

      # 草稿改仓同样校验
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})

      assert_raise Ash.Error.Invalid, ~r/只有叶子仓库才能发生库存/, fn ->
        doc
        |> Ash.Changeset.for_update(:update, %{warehouse_id: root.id})
        |> Ash.update!(authorize?: false)
      end
    end
  end

  describe "单据行" do
    test "默认单位行 base_qty 等于录入数量,快照落列", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})
      item = item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 3, remark: "第一批"})

      assert Decimal.equal?(item.qty, 3)
      assert Decimal.equal?(item.base_qty, 3)
      assert item.material_code == mat.code
      assert item.material_name == "螺丝"
      assert item.material_spec == "M6×20"
      assert item.unit_name == "千克"
      assert item.remark == "第一批"
      assert item.company_id == co.id
    end

    test "转换单位行按系数折算,6 位小数", %{
      company: co,
      warehouse: wh,
      box: box,
      pcs: pcs,
      material: mat
    } do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})

      # 1 kg = 10 箱,5 箱 = 0.5 kg
      item = item!(doc, %{material_id: mat.id, unit_id: box.id, qty: 5})
      assert Decimal.equal?(item.base_qty, Decimal.new("0.5"))
      assert item.unit_name == "箱"

      # 1 kg = 3 只,1 只 = 0.333333 kg(6 位小数)
      MaterialUnit
      |> Ash.Changeset.for_create(:create, %{
        material_id: mat.id,
        unit_id: pcs.id,
        factor: 3
      })
      |> Ash.create!(authorize?: false)

      item2 = item!(doc, %{idx: 2, material_id: mat.id, unit_id: pcs.id, qty: 1})
      assert Decimal.equal?(item2.base_qty, Decimal.new("0.333333"))

      # 改数量重算
      updated =
        item
        |> Ash.Changeset.for_update(:update, %{qty: 10})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(updated.base_qty, Decimal.new("1"))
    end

    test "单位限默认单位或转换单位,数量必须大于零", %{
      company: co,
      warehouse: wh,
      kg: kg,
      pcs: pcs,
      material: mat
    } do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})

      assert {:error, error} =
               StockDocItem
               |> Ash.Changeset.for_create(:create, %{
                 stock_doc_id: doc.id,
                 idx: 1,
                 material_id: mat.id,
                 unit_id: pcs.id,
                 qty: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "单位必须是物料默认单位或其单位转换单位"

      assert {:error, error} =
               StockDocItem
               |> Ash.Changeset.for_create(:create, %{
                 stock_doc_id: doc.id,
                 idx: 1,
                 material_id: mat.id,
                 unit_id: kg.id,
                 qty: 0
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "数量必须大于零"
    end

    test "物料不存在报错", %{company: co, warehouse: wh, kg: kg} do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})

      assert {:error, error} =
               StockDocItem
               |> Ash.Changeset.for_create(:create, %{
                 stock_doc_id: doc.id,
                 idx: 1,
                 material_id: Ash.UUID.generate(),
                 unit_id: kg.id,
                 qty: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "物料不存在"
    end
  end

  describe "审核·入库" do
    test "空单不允许审核,至少一行", %{company: co, warehouse: wh} do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})

      assert {:error, error} =
               doc |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "审核前必须至少填写一行单据行"
    end

    test "审核派生分录:一行一条、数量为正、摘要带入、单据引用齐全", %{
      company: co,
      warehouse: wh,
      kg: kg,
      box: box,
      material: mat
    } do
      user = user!()
      actor = actor(user_id: user.id, company_ids: [co.id])

      doc =
        stock_doc!(%{
          company_id: co.id,
          warehouse_id: wh.id,
          direction: :in,
          doc_date: ~D[2026-07-18],
          summary: "期初入库"
        })

      item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 3})
      item!(doc, %{idx: 2, material_id: mat.id, unit_id: box.id, qty: 5})

      audited =
        doc
        |> Ash.Changeset.for_update(:audit, %{}, actor: actor)
        |> Ash.update!()

      assert audited.status == :audited
      assert audited.audited_at
      assert audited.audited_by_id == user.id

      entries = entries_of("inv.stock_doc", doc.id)
      assert length(entries) == 2
      assert Enum.all?(entries, &(Decimal.compare(&1.quantity, 0) == :gt))

      assert Enum.all?(entries, fn entry ->
               entry.company_id == co.id and entry.warehouse_id == wh.id and
                 entry.material_id == mat.id and entry.voucher_type == "inv.stock_doc" and
                 entry.voucher_id == doc.id and entry.voucher_no == doc.doc_no and
                 entry.posting_date == ~D[2026-07-18] and entry.remarks == "期初入库" and
                 not entry.is_cancelled
             end)

      # 3 kg + 5 箱(0.5 kg) = 3.5
      assert Decimal.equal?(balance(wh.id, mat.id), Decimal.new("3.5"))
    end

    test "审核后锁死:头不可改、行不可增删改、单不可删、不可再审核", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})
      item = item!(doc, %{material_id: mat.id, unit_id: kg.id})
      audited = audit!(doc)

      assert {:error, error} =
               audited
               |> Ash.Changeset.for_update(:update, %{remarks: "改"})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿手工出入库单可修改或删除"

      assert {:error, error} =
               StockDocItem
               |> Ash.Changeset.for_create(:create, %{
                 stock_doc_id: audited.id,
                 idx: 2,
                 material_id: mat.id,
                 unit_id: kg.id,
                 qty: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅草稿手工出入库单可编辑单据行"

      assert {:error, error} =
               item
               |> Ash.Changeset.for_update(:update, %{qty: 9})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿手工出入库单可编辑单据行"

      assert {:error, error} =
               item |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿手工出入库单可编辑单据行"

      assert {:error, error} =
               audited |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿手工出入库单可修改或删除"

      assert {:error, error} =
               audited |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿手工出入库单可审核"
    end
  end

  describe "审核·出库" do
    test "审核派生分录:数量为负、单据引用齐全", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      doc =
        stock_doc!(%{
          company_id: co.id,
          warehouse_id: wh.id,
          direction: :out,
          doc_date: ~D[2026-07-19],
          summary: "生产领料"
        })

      item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 4})
      audited = audit!(doc)

      assert audited.status == :audited

      assert [entry] = entries_of("inv.stock_doc", doc.id)
      assert Decimal.equal?(entry.quantity, -4)
      assert entry.company_id == co.id
      assert entry.warehouse_id == wh.id
      assert entry.material_id == mat.id
      assert entry.voucher_no == doc.doc_no
      assert entry.posting_date == ~D[2026-07-19]
      assert entry.remarks == "生产领料"
      refute entry.is_cancelled

      assert Decimal.equal?(balance(wh.id, mat.id), 6)
    end

    test "余额不足审核整单拒:报错含仓名物料名,单与分录都不落", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id, direction: :out})
      item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 12})

      assert {:error, error} =
               doc |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      message = Exception.message(error)
      assert message =~ "库存不足"
      assert message =~ wh.name
      assert message =~ mat.name

      # 整单拒:仍是草稿,没有产生任何分录
      assert Ash.get!(StockDoc, doc.id, authorize?: false).status == :draft
      assert entries_of("inv.stock_doc", doc.id) == []
      assert Decimal.equal?(balance(wh.id, mat.id), 10)
    end

    test "恰好出完允许(余额为零)", %{company: co, warehouse: wh, kg: kg, material: mat} do
      stock_in!(wh, mat, kg, 10)

      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id, direction: :out})
      item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 10})

      assert audit!(doc).status == :audited
      assert Decimal.equal?(balance(wh.id, mat.id), 0)
    end

    test "allow_negative 仓直接放行", %{company: co, kg: kg, material: mat} do
      wh = warehouse!(%{name: "负仓", company_id: co.id, allow_negative: true})

      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id, direction: :out})
      item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 5})

      assert audit!(doc).status == :audited
      assert Decimal.equal?(balance(wh.id, mat.id), -5)
    end
  end

  describe "作废" do
    test "草稿不可作废;已审核作废后分录标记,余额归零", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})
      item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 4})

      assert {:error, error} =
               doc |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅已审核手工出入库单可作废"

      voided =
        doc
        |> audit!()
        |> Ash.Changeset.for_update(:void, %{})
        |> Ash.update!(authorize?: false)

      assert voided.status == :voided
      assert Enum.all?(entries_of("inv.stock_doc", doc.id), & &1.is_cancelled)
      assert Decimal.equal?(balance(wh.id, mat.id), 0)

      # 作废后不可再改删
      assert {:error, _} =
               voided
               |> Ash.Changeset.for_update(:update, %{remarks: "x"})
               |> Ash.update(authorize?: false)
    end

    test "作废出库单库存加回", %{company: co, warehouse: wh, kg: kg, material: mat} do
      stock_in!(wh, mat, kg, 10)

      doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id, direction: :out})
      item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 4})

      voided =
        doc
        |> audit!()
        |> Ash.Changeset.for_update(:void, %{})
        |> Ash.update!(authorize?: false)

      assert voided.status == :voided
      assert Enum.all?(entries_of("inv.stock_doc", doc.id), & &1.is_cancelled)
      assert Decimal.equal?(balance(wh.id, mat.id), 10)
    end

    test "作废入库单致负被拒(库存已被出库占用)", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      doc_in = stock_doc!(%{company_id: co.id, warehouse_id: wh.id, direction: :in})
      item!(doc_in, %{material_id: mat.id, unit_id: kg.id, qty: 10})
      audited_in = audit!(doc_in)

      doc_out = stock_doc!(%{company_id: co.id, warehouse_id: wh.id, direction: :out})
      item!(doc_out, %{material_id: mat.id, unit_id: kg.id, qty: 8})
      audit!(doc_out)
      assert Decimal.equal?(balance(wh.id, mat.id), 2)

      # 作废入库单 = 减 10,余额 2 - 10 < 0,整单拒
      assert {:error, error} =
               audited_in
               |> Ash.Changeset.for_update(:void, %{})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "库存不足"

      # 状态与分录均未动
      assert Ash.get!(StockDoc, doc_in.id, authorize?: false).status == :audited
      refute Enum.any?(entries_of("inv.stock_doc", doc_in.id), & &1.is_cancelled)
    end
  end

  test "删除草稿手工出入库单级联删行", %{company: co, warehouse: wh, kg: kg, material: mat} do
    doc = stock_doc!(%{company_id: co.id, warehouse_id: wh.id})
    item = item!(doc, %{material_id: mat.id, unit_id: kg.id})

    :ok = doc |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

    assert {:error, _} = Ash.get(StockDocItem, item.id, authorize?: false)
  end

  test "资源声明了权限前缀" do
    assert StockDoc.permission_prefix() == "inv.stock_doc"
    assert StockDoc.permission_actions() == ~w(create read update delete audit void)
    assert StockDocItem.permission_prefix() == "inv.stock_doc"
    assert StockDocItem.permission_actions() == []
    assert StockEntry.permission_prefix() == "inv.stock_entry"
    assert StockEntry.permission_actions() == ~w(read)
  end
end
