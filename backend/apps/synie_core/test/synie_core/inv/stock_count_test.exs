defmodule SynieCore.Inv.StockCountTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, MaterialUnit, StockCount, StockCountItem}
  alias SynieCore.Inv.{StockDoc, StockDocItem, StockEntry, Warehouse}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    other_company = company!()

    # 不抢迁移内置与各测试模块的 symbol(全局唯一)
    kg = unit!(%{unit_type: :weight, name: "千克", symbol: "kg-sc", ratio: 1})
    box = unit!(%{unit_type: :quantity, name: "箱", symbol: "箱-sc", ratio: 1})
    pcs = unit!(%{unit_type: :quantity, name: "只", symbol: "只-sc", ratio: 1})

    category =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "SC#{System.unique_integer([:positive])}",
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

  defp stock_count!(attrs) do
    attrs =
      Map.merge(
        %{
          doc_no: "PD-#{System.unique_integer([:positive])}",
          posting_date: ~D[2026-07-19]
        },
        attrs
      )

    StockCount |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp item!(count, attrs) do
    StockCountItem
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{count_id: count.id}))
    |> Ash.create!(authorize?: false)
  end

  defp approve!(count, opts \\ [authorize?: false]) do
    count |> Ash.Changeset.for_update(:approve, %{}) |> Ash.update!(opts)
  end

  # 入库铺底:建一张已审核的手工入库单让仓里有货
  defp stock_in!(warehouse, material, unit, qty, attrs \\ %{}) do
    doc =
      StockDoc
      |> Ash.Changeset.for_create(
        :create,
        Map.merge(
          %{
            doc_no: "CRK-#{System.unique_integer([:positive])}",
            doc_date: ~D[2026-07-19],
            direction: :in,
            company_id: warehouse.company_id,
            warehouse_id: warehouse.id
          },
          attrs
        )
      )
      |> Ash.create!(authorize?: false)

    StockDocItem
    |> Ash.Changeset.for_create(:create, %{
      stock_doc_id: doc.id,
      idx: 1,
      material_id: material.id,
      unit_id: unit.id,
      qty: qty
    })
    |> Ash.create!(authorize?: false)

    doc |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["inv.stock_count:*"])},
      overrides
    )
  end

  defp items_of(count_id) do
    StockCountItem
    |> Ash.Query.filter(count_id == ^count_id)
    |> Ash.read!(authorize?: false)
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

  test "创建默认草稿态,业务日期缺省今天,快照时间即写,录入人取 actor", %{
    company: co,
    warehouse: wh
  } do
    user = user!()
    actor = actor(user_id: user.id, company_ids: [co.id])

    count =
      StockCount
      |> Ash.Changeset.for_create(
        :create,
        %{company_id: co.id, warehouse_id: wh.id, doc_no: "PD-手填-1"},
        actor: actor
      )
      |> Ash.create!()

    assert count.status == :draft
    assert count.posting_date == Date.utc_today()
    assert count.snapshot_taken_at
    assert count.created_by_id == user.id
    assert count.audited_by_id == nil
  end

  test "无公司授权不能创建(CompanyAccessible)", %{company: co, warehouse: wh} do
    assert_raise Ash.Error.Invalid, fn ->
      StockCount
      |> Ash.Changeset.for_create(
        :create,
        %{company_id: co.id, warehouse_id: wh.id, doc_no: "PD-X"},
        actor: actor(company_ids: [])
      )
      |> Ash.create!()
    end
  end

  test "单据编号全局唯一", %{company: co, other_company: other, warehouse: wh} do
    other_wh = warehouse!(%{name: "外司仓", company_id: other.id})
    count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})

    assert_raise Ash.Error.Invalid, ~r/单据编号已存在/, fn ->
      stock_count!(%{company_id: other.id, warehouse_id: other_wh.id, doc_no: count.doc_no})
    end
  end

  describe "自动编号" do
    defp numbering_rule! do
      SynieCore.Numbering.Rule
      |> Ash.Changeset.for_create(
        :create,
        %{
          resource: "inv.stock_count",
          name: "库存盘点单编号",
          segments: [
            %{"type" => "text", "value" => "PD"},
            %{"type" => "field", "field" => "posting_date", "format" => "YYYYMMDD"},
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
        StockCount
        |> Ash.Changeset.for_create(:create, %{
          company_id: co.id,
          warehouse_id: wh.id,
          posting_date: ~D[2026-07-19]
        })
        |> Ash.create!(authorize?: false)
      end

      assert create.().doc_no == "PD20260719-0001"
      assert create.().doc_no == "PD20260719-0002"
    end

    test "手填编号原样保留", %{company: co, warehouse: wh} do
      numbering_rule!()

      assert stock_count!(%{company_id: co.id, warehouse_id: wh.id, doc_no: "PD-手填"}).doc_no ==
               "PD-手填"
    end

    test "无规则且留空报错提示配置规则", %{company: co, warehouse: wh} do
      error =
        assert_raise Ash.Error.Invalid, fn ->
          StockCount
          |> Ash.Changeset.for_create(:create, %{company_id: co.id, warehouse_id: wh.id})
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
        stock_count!(%{company_id: co.id, warehouse_id: root.id})
      end

      foreign = warehouse!(%{name: "外司仓", company_id: other.id})

      assert_raise Ash.Error.Invalid, ~r/仓库不属于本公司/, fn ->
        stock_count!(%{company_id: co.id, warehouse_id: foreign.id})
      end

      inactive = warehouse!(%{name: "停用仓", company_id: co.id, active: false})

      assert_raise Ash.Error.Invalid, ~r/仓库已停用/, fn ->
        stock_count!(%{company_id: co.id, warehouse_id: inactive.id})
      end

      assert_raise Ash.Error.Invalid, ~r/仓库不存在/, fn ->
        stock_count!(%{company_id: co.id, warehouse_id: Ash.UUID.generate()})
      end

      # 草稿改仓同样校验
      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})

      assert_raise Ash.Error.Invalid, ~r/只有叶子仓库才能发生库存/, fn ->
        count
        |> Ash.Changeset.for_update(:update, %{warehouse_id: root.id})
        |> Ash.update!(authorize?: false)
      end
    end
  end

  describe "建行" do
    test "create 可带 items:行随单建,快照与折算落列", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      count =
        StockCount
        |> Ash.Changeset.for_create(:create, %{
          company_id: co.id,
          warehouse_id: wh.id,
          doc_no: "PD-带行",
          items: [%{material_id: mat.id, unit_id: kg.id, counted_quantity: 12, remark: "货架A"}]
        })
        |> Ash.create!(authorize?: false)

      assert [item] = items_of(count.id)
      assert item.material_id == mat.id
      assert Decimal.equal?(item.counted_quantity, 12)
      assert Decimal.equal?(item.converted_counted, 12)
      assert Decimal.equal?(item.book_quantity, 10)
      assert item.material_code == mat.code
      assert item.material_name == "螺丝"
      assert item.material_spec == "M6×20"
      assert item.unit_name == "千克"
      assert item.remark == "货架A"
      assert item.company_id == co.id
    end

    test "整仓带出:只带账面非零行,book_quantity 为当前余额,单位取物料默认单位", %{
      company: co,
      warehouse: wh,
      kg: kg,
      category: cat,
      material: mat
    } do
      mat_zero = material!(cat, kg, %{name: "垫圈"})

      stock_in!(wh, mat, kg, 10)
      # mat_zero 有分录但余额为零(入 5 出 5),不带出
      stock_in!(wh, mat_zero, kg, 5)

      doc_out =
        StockDoc
        |> Ash.Changeset.for_create(:create, %{
          doc_no: "CRK-#{System.unique_integer([:positive])}",
          direction: :out,
          company_id: co.id,
          warehouse_id: wh.id
        })
        |> Ash.create!(authorize?: false)

      StockDocItem
      |> Ash.Changeset.for_create(:create, %{
        stock_doc_id: doc_out.id,
        idx: 1,
        material_id: mat_zero.id,
        unit_id: kg.id,
        qty: 5
      })
      |> Ash.create!(authorize?: false)

      doc_out |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      count =
        StockCount
        |> Ash.Changeset.for_create(:create, %{
          company_id: co.id,
          warehouse_id: wh.id,
          doc_no: "PD-整仓",
          load_all: true
        })
        |> Ash.create!(authorize?: false)

      assert count.snapshot_taken_at

      assert [item] = items_of(count.id)
      assert item.material_id == mat.id
      assert item.unit_id == kg.id
      assert Decimal.equal?(item.book_quantity, 10)
      assert is_nil(item.counted_quantity)
      assert is_nil(item.converted_counted)
    end

    test "手工建行按取数时刻落账面快照", %{company: co, warehouse: wh, kg: kg, material: mat} do
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item = item!(count, %{material_id: mat.id, unit_id: kg.id})

      assert Decimal.equal?(item.book_quantity, 10)
      assert is_nil(item.counted_quantity)
    end

    test "转换单位行按系数折算实盘,6 位小数", %{
      company: co,
      warehouse: wh,
      box: box,
      pcs: pcs,
      material: mat
    } do
      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})

      # 1 kg = 10 箱,实盘 5 箱 = 0.5 kg
      item = item!(count, %{material_id: mat.id, unit_id: box.id, counted_quantity: 5})
      assert Decimal.equal?(item.converted_counted, Decimal.new("0.5"))
      assert item.unit_name == "箱"

      # 1 kg = 3 只,实盘 1 只 = 0.333333 kg(6 位小数)
      MaterialUnit
      |> Ash.Changeset.for_create(:create, %{
        material_id: mat.id,
        unit_id: pcs.id,
        factor: 3
      })
      |> Ash.create!(authorize?: false)

      item2 = item!(count, %{material_id: mat.id, unit_id: pcs.id, counted_quantity: 1})
      assert Decimal.equal?(item2.converted_counted, Decimal.new("0.333333"))

      # 改实盘重算折算
      updated =
        item
        |> Ash.Changeset.for_update(:update, %{counted_quantity: 10})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(updated.converted_counted, Decimal.new("1"))
    end

    test "单位限默认单位或转换单位,实盘不能为负", %{
      company: co,
      warehouse: wh,
      kg: kg,
      pcs: pcs,
      material: mat
    } do
      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})

      assert {:error, error} =
               StockCountItem
               |> Ash.Changeset.for_create(:create, %{
                 count_id: count.id,
                 material_id: mat.id,
                 unit_id: pcs.id,
                 counted_quantity: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "单位必须是物料默认单位或其单位转换单位"

      assert {:error, error} =
               StockCountItem
               |> Ash.Changeset.for_create(:create, %{
                 count_id: count.id,
                 material_id: mat.id,
                 unit_id: kg.id,
                 counted_quantity: -1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "实盘数量不能为负"
    end
  end

  describe "审核" do
    test "空单不允许审核,至少一行", %{company: co, warehouse: wh} do
      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})

      assert {:error, error} =
               count |> Ash.Changeset.for_update(:approve, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "审核前必须至少填写一行单据行"
    end

    test "存在未填实盘数量的行整单拒,单与分录都不落", %{
      company: co,
      warehouse: wh,
      kg: kg,
      category: cat,
      material: mat
    } do
      mat2 = material!(cat, kg, %{name: "垫圈"})
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 10})
      item!(count, %{material_id: mat2.id, unit_id: kg.id})

      assert {:error, error} =
               count |> Ash.Changeset.for_update(:approve, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "存在未填实盘数量的单据行"

      assert Ash.get!(StockCount, count.id, authorize?: false).status == :draft
      assert entries_of("inv.stock_count", count.id) == []
      assert Decimal.equal?(balance(wh.id, mat.id), 10)
    end

    test "审核派生分录:盘盈正/盘亏负/零差异不落行/部分盘点不影响其他物料", %{
      company: co,
      warehouse: wh,
      kg: kg,
      category: cat,
      material: mat
    } do
      user = user!()
      actor = actor(user_id: user.id, company_ids: [co.id])

      mat_short = material!(cat, kg, %{name: "垫圈"})
      mat_even = material!(cat, kg, %{name: "螺母"})
      mat_untouched = material!(cat, kg, %{name: "挡圈"})

      stock_in!(wh, mat, kg, 10)
      stock_in!(wh, mat_short, kg, 7)
      stock_in!(wh, mat_even, kg, 6)
      stock_in!(wh, mat_untouched, kg, 9)

      count =
        stock_count!(%{
          company_id: co.id,
          warehouse_id: wh.id,
          posting_date: ~D[2026-07-18],
          summary: "月末盘点"
        })

      # 盘盈:10 → 12(+2);盘亏:7 → 3(-4);零差异:6 → 6(不落行);mat_untouched 不列入
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 12})
      item!(count, %{material_id: mat_short.id, unit_id: kg.id, counted_quantity: 3})
      item!(count, %{material_id: mat_even.id, unit_id: kg.id, counted_quantity: 6})

      audited =
        count
        |> Ash.Changeset.for_update(:approve, %{}, actor: actor)
        |> Ash.update!()

      assert audited.status == :audited
      assert audited.audited_at
      assert audited.audited_by_id == user.id

      entries = entries_of("inv.stock_count", count.id)
      assert length(entries) == 2

      by_material = Map.new(entries, &{&1.material_id, &1})
      assert Decimal.equal?(by_material[mat.id].quantity, 2)
      assert Decimal.equal?(by_material[mat_short.id].quantity, -4)

      assert Enum.all?(entries, fn entry ->
               entry.company_id == co.id and entry.warehouse_id == wh.id and
                 entry.voucher_type == "inv.stock_count" and entry.voucher_id == count.id and
                 entry.voucher_no == count.doc_no and entry.posting_date == ~D[2026-07-18] and
                 entry.remarks == "月末盘点" and not entry.is_cancelled
             end)

      assert Decimal.equal?(balance(wh.id, mat.id), 12)
      assert Decimal.equal?(balance(wh.id, mat_short.id), 3)
      assert Decimal.equal?(balance(wh.id, mat_even.id), 6)
      assert Decimal.equal?(balance(wh.id, mat_untouched.id), 9)
    end

    test "实物有账面无的盘盈:零余额物料手工加行,差异为正", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item = item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 4})

      assert Decimal.equal?(item.book_quantity, 0)

      assert approve!(count).status == :audited

      assert [entry] = entries_of("inv.stock_count", count.id)
      assert Decimal.equal?(entry.quantity, 4)
      assert Decimal.equal?(balance(wh.id, mat.id), 4)
    end

    test "全部行零差异:审核照过,不落分录", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 6)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 6})

      assert approve!(count).status == :audited
      assert entries_of("inv.stock_count", count.id) == []
      assert Decimal.equal?(balance(wh.id, mat.id), 6)
    end
  end

  describe "审核兜底校验" do
    test "取快照后该仓有新分录:整单拒,提示先刷新账面数;刷新后可审", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 10})

      # 快照后该仓又入库 5
      stock_in!(wh, mat, kg, 5)

      assert {:error, error} =
               count |> Ash.Changeset.for_update(:approve, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "取快照后该仓库存分录有新增或作废,请先刷新账面数再审核"
      assert Ash.get!(StockCount, count.id, authorize?: false).status == :draft

      # 刷新重取账面数(保留已填实盘)后审核通过:差异 = 10 − 15 = -5
      count
      |> Ash.Changeset.for_update(:refresh, %{})
      |> Ash.update!(authorize?: false)

      assert approve!(count).status == :audited
      assert [entry] = entries_of("inv.stock_count", count.id)
      assert Decimal.equal?(entry.quantity, -5)
      assert Decimal.equal?(balance(wh.id, mat.id), 10)
    end

    test "业务日期在过去的补录单照样命中兜底校验", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 10})

      # 补录:业务日期在过去,但分录 inserted_at 在快照之后
      stock_in!(wh, mat, kg, 5, %{doc_date: ~D[2026-07-01]})

      assert {:error, error} =
               count |> Ash.Changeset.for_update(:approve, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "取快照后该仓库存分录有新增或作废,请先刷新账面数再审核"
    end

    test "取快照后该仓有分录作废:整单拒", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      doc_in = stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 10})

      # 快照后作废入库单(余额 10 → 0,作废分录 cancelled_at 晚于快照)
      doc_in |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               count |> Ash.Changeset.for_update(:approve, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "取快照后该仓库存分录有新增或作废,请先刷新账面数再审核"
    end

    test "快照前的新增与作废不拦审核", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      doc_in = stock_in!(wh, mat, kg, 10)
      doc_in |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert Decimal.equal?(balance(wh.id, mat.id), 0)

      # 快照取在所有变动之后:账面 0,实盘 4 → 盘盈 +4
      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 4})

      assert approve!(count).status == :audited
      assert Decimal.equal?(balance(wh.id, mat.id), 4)
    end

    test "他仓分录变动不拦审核", %{company: co, warehouse: wh, kg: kg, material: mat} do
      wh2 = warehouse!(%{name: "副仓", company_id: co.id})
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 10})

      # 快照后只有他仓动货
      stock_in!(wh2, mat, kg, 3)

      assert approve!(count).status == :audited
    end
  end

  describe "刷新账面数" do
    test "按最新余额重取账面数,已填实盘数保留,快照时间更新", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item = item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 8})
      assert Decimal.equal?(item.book_quantity, 10)
      old_snapshot = count.snapshot_taken_at

      stock_in!(wh, mat, kg, 5)

      refreshed =
        count
        |> Ash.Changeset.for_update(:refresh, %{})
        |> Ash.update!(authorize?: false)

      assert DateTime.compare(refreshed.snapshot_taken_at, old_snapshot) == :gt

      [item] = items_of(count.id)
      assert Decimal.equal?(item.book_quantity, 15)
      assert Decimal.equal?(item.counted_quantity, 8)
      assert Decimal.equal?(item.converted_counted, 8)
    end
  end

  describe "作废" do
    test "草稿不可作废;已审核作废后分录标记,余额回滚", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 12})

      assert {:error, error} =
               count |> Ash.Changeset.for_update(:cancel, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅已审核库存盘点单可作废"

      cancelled =
        count
        |> approve!()
        |> Ash.Changeset.for_update(:cancel, %{})
        |> Ash.update!(authorize?: false)

      assert cancelled.status == :cancelled
      assert Enum.all?(entries_of("inv.stock_count", count.id), & &1.is_cancelled)
      assert Decimal.equal?(balance(wh.id, mat.id), 10)
    end

    test "撤销盘盈致负被拒(库存已被出库占用)", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      # 盘盈 +4(0 → 4),随后出库 4(4 → 0);作废盘点单 = -4,致负整单拒
      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 4})
      audited = approve!(count)
      assert Decimal.equal?(balance(wh.id, mat.id), 4)

      doc_out =
        StockDoc
        |> Ash.Changeset.for_create(:create, %{
          doc_no: "CRK-#{System.unique_integer([:positive])}",
          direction: :out,
          company_id: co.id,
          warehouse_id: wh.id
        })
        |> Ash.create!(authorize?: false)

      StockDocItem
      |> Ash.Changeset.for_create(:create, %{
        stock_doc_id: doc_out.id,
        idx: 1,
        material_id: mat.id,
        unit_id: kg.id,
        qty: 4
      })
      |> Ash.create!(authorize?: false)

      doc_out |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert Decimal.equal?(balance(wh.id, mat.id), 0)

      assert {:error, error} =
               audited
               |> Ash.Changeset.for_update(:cancel, %{})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "库存不足"

      # 状态与分录均未动
      assert Ash.get!(StockCount, count.id, authorize?: false).status == :audited
      refute Enum.any?(entries_of("inv.stock_count", count.id), & &1.is_cancelled)
    end
  end

  describe "状态锁死" do
    test "已审核:头不可改删、行不可增删改、不可再审核、不可刷新", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item = item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 12})
      audited = approve!(count)

      assert {:error, error} =
               audited
               |> Ash.Changeset.for_update(:update, %{remarks: "改"})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可修改或删除"

      assert {:error, error} =
               StockCountItem
               |> Ash.Changeset.for_create(:create, %{
                 count_id: audited.id,
                 material_id: mat.id,
                 unit_id: kg.id,
                 counted_quantity: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可编辑盘点行"

      assert {:error, error} =
               item
               |> Ash.Changeset.for_update(:update, %{counted_quantity: 9})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可编辑盘点行"

      assert {:error, error} =
               item |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可编辑盘点行"

      assert {:error, error} =
               audited |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可修改或删除"

      assert {:error, error} =
               audited |> Ash.Changeset.for_update(:approve, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可审核"

      assert {:error, error} =
               audited
               |> Ash.Changeset.for_update(:refresh, %{})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可刷新账面数"
    end

    test "已作废:不可改删、不可再作废", %{
      company: co,
      warehouse: wh,
      kg: kg,
      material: mat
    } do
      stock_in!(wh, mat, kg, 10)

      count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
      item!(count, %{material_id: mat.id, unit_id: kg.id, counted_quantity: 10})

      cancelled =
        count
        |> approve!()
        |> Ash.Changeset.for_update(:cancel, %{})
        |> Ash.update!(authorize?: false)

      assert {:error, error} =
               cancelled
               |> Ash.Changeset.for_update(:update, %{remarks: "改"})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可修改或删除"

      assert {:error, error} =
               cancelled |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿库存盘点单可修改或删除"

      assert {:error, error} =
               cancelled
               |> Ash.Changeset.for_update(:cancel, %{})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅已审核库存盘点单可作废"
    end
  end

  test "删除草稿库存盘点单级联删行", %{company: co, warehouse: wh, kg: kg, material: mat} do
    count = stock_count!(%{company_id: co.id, warehouse_id: wh.id})
    item = item!(count, %{material_id: mat.id, unit_id: kg.id})

    :ok = count |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

    assert {:error, _} = Ash.get(StockCountItem, item.id, authorize?: false)
  end

  test "资源声明了权限前缀" do
    assert StockCount.permission_prefix() == "inv.stock_count"
    assert StockCount.permission_actions() == ~w(create read update delete approve cancel)
    assert StockCountItem.permission_prefix() == "inv.stock_count"
    assert StockCountItem.permission_actions() == []
  end
end
