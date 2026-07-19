defmodule SynieCore.Inv.StockTransferTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, StockDoc, StockDocItem, StockEntry}
  alias SynieCore.Inv.{StockTransfer, StockTransferItem, Warehouse}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    other_company = company!()

    # 不抢迁移内置与各测试模块的 symbol(全局唯一)
    kg = unit!(%{unit_type: :weight, name: "千克", symbol: "kg-str", ratio: 1})
    box = unit!(%{unit_type: :quantity, name: "箱", symbol: "箱-str", ratio: 1})

    category =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "TR#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material = material!(category, kg, %{name: "螺丝", spec: "M6×20"})
    material2 = material!(category, kg, %{name: "螺母"})

    from = warehouse!(%{name: "调出仓", company_id: company.id})
    to = warehouse!(%{name: "调入仓", company_id: company.id})
    transit = warehouse!(%{name: "在途仓", company_id: company.id})

    %{
      company: company,
      other_company: other_company,
      kg: kg,
      box: box,
      category: category,
      material: material,
      material2: material2,
      from: from,
      to: to,
      transit: transit
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
        %{code: "MAT-#{System.unique_integer([:positive])}", name: "垫片"},
        Map.merge(attrs, %{category_id: category.id, default_unit_id: unit.id})
      )
    )
  end

  defp transfer!(ctx, attrs \\ %{}) do
    attrs =
      Map.merge(
        %{
          doc_no: "DB-#{System.unique_integer([:positive])}",
          doc_date: ~D[2026-07-19],
          company_id: ctx.company.id,
          from_warehouse_id: ctx.from.id,
          to_warehouse_id: ctx.to.id,
          transit_warehouse_id: ctx.transit.id
        },
        attrs
      )

    StockTransfer |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp item!(doc, attrs) do
    attrs = Map.merge(%{idx: 1, qty: 2}, attrs)

    StockTransferItem
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{stock_transfer_id: doc.id}))
    |> Ash.create!(authorize?: false)
  end

  # 建已审核手工出入库单(入库)给仓补库存
  defp stock_in!(company, warehouse, material, unit, qty) do
    doc =
      StockDoc
      |> Ash.Changeset.for_create(:create, %{
        company_id: company.id,
        warehouse_id: warehouse.id,
        direction: :in,
        doc_no: "CRK-#{System.unique_integer([:positive])}",
        doc_date: ~D[2026-07-18]
      })
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

  defp ship!(doc, opts \\ [authorize?: false]) do
    doc |> Ash.Changeset.for_update(:ship, %{}) |> Ash.update!(opts)
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["inv.stock_transfer:*"])},
      overrides
    )
  end

  defp entries_of(voucher_id) do
    StockEntry
    |> Ash.Query.filter(voucher_type == "inv.stock_transfer" and voucher_id == ^voucher_id)
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

  test "创建默认草稿态,业务日期缺省今天,录入人取 actor", ctx do
    user = user!()
    actor = actor(user_id: user.id, company_ids: [ctx.company.id])

    doc =
      StockTransfer
      |> Ash.Changeset.for_create(
        :create,
        %{
          company_id: ctx.company.id,
          from_warehouse_id: ctx.from.id,
          to_warehouse_id: ctx.to.id,
          transit_warehouse_id: ctx.transit.id,
          doc_no: "DB-手填-1"
        },
        actor: actor
      )
      |> Ash.create!()

    assert doc.status == :draft
    assert doc.doc_date == Date.utc_today()
    assert doc.created_by_id == user.id
    assert doc.shipped_by_id == nil
    assert doc.received_by_id == nil
  end

  test "单据编号全局唯一", ctx do
    doc = transfer!(ctx)
    other = ctx.other_company.id
    wh1 = warehouse!(%{name: "外司仓一", company_id: other})
    wh2 = warehouse!(%{name: "外司仓二", company_id: other})
    wh3 = warehouse!(%{name: "外司仓三", company_id: other})

    assert_raise Ash.Error.Invalid, ~r/单据编号已存在/, fn ->
      transfer!(ctx, %{
        company_id: other,
        from_warehouse_id: wh1.id,
        to_warehouse_id: wh2.id,
        transit_warehouse_id: wh3.id,
        doc_no: doc.doc_no
      })
    end
  end

  describe "三仓校验" do
    test "非叶子/跨公司/停用/不存在的仓被拦", ctx do
      root = warehouse!(%{name: "总仓", is_leaf: false, company_id: ctx.company.id})

      assert_raise Ash.Error.Invalid, ~r/只有叶子仓库才能发生库存/, fn ->
        transfer!(ctx, %{from_warehouse_id: root.id})
      end

      foreign = warehouse!(%{name: "外司仓", company_id: ctx.other_company.id})

      assert_raise Ash.Error.Invalid, ~r/仓库不属于本公司/, fn ->
        transfer!(ctx, %{to_warehouse_id: foreign.id})
      end

      inactive = warehouse!(%{name: "停用仓", company_id: ctx.company.id, active: false})

      assert_raise Ash.Error.Invalid, ~r/仓库已停用/, fn ->
        transfer!(ctx, %{transit_warehouse_id: inactive.id})
      end

      assert_raise Ash.Error.Invalid, ~r/仓库不存在/, fn ->
        transfer!(ctx, %{from_warehouse_id: Ash.UUID.generate()})
      end
    end

    test "三仓两两必须不同", ctx do
      assert_raise Ash.Error.Invalid, ~r/调出、调入与在途仓库必须两两不同/, fn ->
        transfer!(ctx, %{to_warehouse_id: ctx.from.id})
      end

      assert_raise Ash.Error.Invalid, ~r/调出、调入与在途仓库必须两两不同/, fn ->
        transfer!(ctx, %{transit_warehouse_id: ctx.from.id})
      end

      assert_raise Ash.Error.Invalid, ~r/调出、调入与在途仓库必须两两不同/, fn ->
        transfer!(ctx, %{transit_warehouse_id: ctx.to.id})
      end
    end

    test "草稿改仓同样校验", ctx do
      doc = transfer!(ctx)

      assert_raise Ash.Error.Invalid, ~r/调出、调入与在途仓库必须两两不同/, fn ->
        doc
        |> Ash.Changeset.for_update(:update, %{to_warehouse_id: ctx.from.id})
        |> Ash.update!(authorize?: false)
      end

      inactive = warehouse!(%{name: "停用仓", company_id: ctx.company.id, active: false})

      assert_raise Ash.Error.Invalid, ~r/仓库已停用/, fn ->
        doc
        |> Ash.Changeset.for_update(:update, %{from_warehouse_id: inactive.id})
        |> Ash.update!(authorize?: false)
      end
    end
  end

  describe "单据行" do
    test "默认单位行 base_qty 等于录入数量,快照落列,received_qty 为空", ctx do
      doc = transfer!(ctx)

      item =
        item!(doc, %{material_id: ctx.material.id, unit_id: ctx.kg.id, qty: 3, remark: "第一批"})

      assert Decimal.equal?(item.qty, 3)
      assert Decimal.equal?(item.base_qty, 3)
      assert item.material_code == ctx.material.code
      assert item.material_name == "螺丝"
      assert item.material_spec == "M6×20"
      assert item.unit_name == "千克"
      assert item.remark == "第一批"
      assert item.company_id == ctx.company.id
      assert item.received_qty == nil
    end

    test "单位限默认单位或转换单位,数量必须大于零", ctx do
      doc = transfer!(ctx)

      assert {:error, error} =
               StockTransferItem
               |> Ash.Changeset.for_create(:create, %{
                 stock_transfer_id: doc.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.box.id,
                 qty: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "单位必须是物料默认单位或其单位转换单位"

      assert {:error, error} =
               StockTransferItem
               |> Ash.Changeset.for_create(:create, %{
                 stock_transfer_id: doc.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 0
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "数量必须大于零"
    end
  end

  describe "发货" do
    test "空单不允许发货,至少一行", ctx do
      doc = transfer!(ctx)

      assert {:error, error} =
               doc |> Ash.Changeset.for_update(:ship, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "发货前必须至少填写一行单据行"
    end

    test "发货后仓停用被拦,状态保持草稿", ctx do
      stock_in!(ctx.company, ctx.from, ctx.material, ctx.kg, 10)
      doc = transfer!(ctx)
      item!(doc, %{material_id: ctx.material.id, unit_id: ctx.kg.id, qty: 4})

      # 发货前三仓任一停用都拦(「拦新不拦旧」的拦新侧)
      ctx.from
      |> Ash.Changeset.for_update(:update, %{active: false})
      |> Ash.update!(authorize?: false)

      assert {:error, error} =
               doc |> Ash.Changeset.for_update(:ship, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仓库已停用"
      assert Ash.get!(StockTransfer, doc.id, authorize?: false).status == :draft
      assert entries_of(doc.id) == []
    end

    test "调出仓库存不足整单拒,状态与分录均未动", ctx do
      stock_in!(ctx.company, ctx.from, ctx.material, ctx.kg, 2)
      doc = transfer!(ctx)
      item!(doc, %{material_id: ctx.material.id, unit_id: ctx.kg.id, qty: 10})

      assert {:error, error} =
               doc |> Ash.Changeset.for_update(:ship, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "库存不足"
      assert Ash.get!(StockTransfer, doc.id, authorize?: false).status == :draft
      assert entries_of(doc.id) == []
      assert Decimal.equal?(balance(ctx.from.id, ctx.material.id), 2)
    end

    test "已发货不可改不可删、行不可增删改、不可再发货", ctx do
      stock_in!(ctx.company, ctx.from, ctx.material, ctx.kg, 10)
      doc = transfer!(ctx)
      item = item!(doc, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
      shipped = ship!(doc)

      assert {:error, error} =
               shipped
               |> Ash.Changeset.for_update(:update, %{remarks: "改"})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿调拨单可修改或删除"

      assert {:error, error} =
               shipped |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿调拨单可修改或删除"

      assert {:error, error} =
               StockTransferItem
               |> Ash.Changeset.for_create(:create, %{
                 stock_transfer_id: shipped.id,
                 idx: 2,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅草稿调拨单可编辑单据行"

      assert {:error, error} =
               item
               |> Ash.Changeset.for_update(:update, %{qty: 9})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿调拨单可编辑单据行"

      assert {:error, error} =
               item |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿调拨单可编辑单据行"

      assert {:error, error} =
               shipped |> Ash.Changeset.for_update(:ship, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿调拨单可发货"
    end
  end

  describe "全流程" do
    test "建单→行→发货(分录两正两负)→收货→四仓组数量核对", ctx do
      %{company: co, from: from, to: to, transit: transit, kg: kg} = ctx
      %{material: mat, material2: mat2} = ctx

      stock_in!(co, from, mat, kg, 10)
      stock_in!(co, from, mat2, kg, 8)

      user = user!()
      actor = actor(user_id: user.id, company_ids: [co.id])

      doc = transfer!(ctx, %{doc_date: ~D[2026-07-18], summary: "车间转仓"})
      item1 = item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 4})
      item2 = item!(doc, %{idx: 2, material_id: mat2.id, unit_id: kg.id, qty: 5})

      shipped =
        doc
        |> Ash.Changeset.for_update(:ship, %{}, actor: actor)
        |> Ash.update!()

      assert shipped.status == :shipped
      assert shipped.shipped_at
      assert shipped.shipped_by_id == user.id

      # 发货分录:两正(在途)两负(调出),摘要/日期/单据引用齐全
      entries = entries_of(doc.id)
      assert length(entries) == 4

      from_entries = Enum.filter(entries, &(&1.warehouse_id == from.id))
      transit_entries = Enum.filter(entries, &(&1.warehouse_id == transit.id))
      assert length(from_entries) == 2
      assert length(transit_entries) == 2
      assert Enum.all?(from_entries, &(Decimal.compare(&1.quantity, 0) == :lt))
      assert Enum.all?(transit_entries, &(Decimal.compare(&1.quantity, 0) == :gt))

      assert Enum.all?(entries, fn entry ->
               entry.company_id == co.id and entry.voucher_type == "inv.stock_transfer" and
                 entry.voucher_id == doc.id and entry.voucher_no == doc.doc_no and
                 entry.posting_date == ~D[2026-07-18] and entry.remarks == "车间转仓" and
                 not entry.is_cancelled
             end)

      assert Decimal.equal?(balance(from.id, mat.id), 6)
      assert Decimal.equal?(balance(from.id, mat2.id), 3)
      assert Decimal.equal?(balance(transit.id, mat.id), 4)
      assert Decimal.equal?(balance(transit.id, mat2.id), 5)
      assert Decimal.equal?(balance(to.id, mat.id), 0)

      # 收货缺省 = 足额收
      received =
        shipped
        |> Ash.Changeset.for_update(:receive, %{}, actor: actor)
        |> Ash.update!()

      assert received.status == :received
      assert received.received_at
      assert received.received_by_id == user.id

      entries = entries_of(doc.id)
      assert length(entries) == 8

      to_entries = Enum.filter(entries, &(&1.warehouse_id == to.id))
      assert length(to_entries) == 2
      assert Enum.all?(to_entries, &(Decimal.compare(&1.quantity, 0) == :gt))

      # 四组数量:调出仓余量与调入仓到货(两物料),在途清零
      assert Decimal.equal?(balance(from.id, mat.id), 6)
      assert Decimal.equal?(balance(from.id, mat2.id), 3)
      assert Decimal.equal?(balance(to.id, mat.id), 4)
      assert Decimal.equal?(balance(to.id, mat2.id), 5)
      assert Decimal.equal?(balance(transit.id, mat.id), 0)
      assert Decimal.equal?(balance(transit.id, mat2.id), 0)

      # 行实收回写(折算口径)
      assert Decimal.equal?(
               Ash.get!(StockTransferItem, item1.id, authorize?: false).received_qty,
               4
             )

      assert Decimal.equal?(
               Ash.get!(StockTransferItem, item2.id, authorize?: false).received_qty,
               5
             )

      # 终态:不可再收货、不可改删
      assert {:error, error} =
               received
               |> Ash.Changeset.for_update(:receive, %{})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅已发货调拨单可收货"

      assert {:error, _} =
               received |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
    end
  end

  describe "收货" do
    test "部分收货:差额留在在途仓,行回写实收", ctx do
      %{company: co, from: from, to: to, transit: transit, kg: kg, material: mat} = ctx

      stock_in!(co, from, mat, kg, 10)
      doc = transfer!(ctx)
      item = item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 4})
      shipped = ship!(doc)

      received =
        shipped
        |> Ash.Changeset.for_update(:receive, %{
          receipts: [%{"item_id" => item.id, "qty" => 3}]
        })
        |> Ash.update!(authorize?: false)

      assert received.status == :received

      # 只按实收 3 写「在途负+调入正」,差额 1 留在在途仓
      assert length(entries_of(doc.id)) == 4
      assert Decimal.equal?(balance(transit.id, mat.id), 1)
      assert Decimal.equal?(balance(to.id, mat.id), 3)

      assert Decimal.equal?(
               Ash.get!(StockTransferItem, item.id, authorize?: false).received_qty,
               3
             )
    end

    test "整单实收为零:不写分录,全部留在在途仓", ctx do
      %{company: co, from: from, to: to, transit: transit, kg: kg, material: mat} = ctx

      stock_in!(co, from, mat, kg, 10)
      doc = transfer!(ctx)
      item = item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 4})
      shipped = ship!(doc)

      received =
        shipped
        |> Ash.Changeset.for_update(:receive, %{
          receipts: [%{"item_id" => item.id, "qty" => 0}]
        })
        |> Ash.update!(authorize?: false)

      assert received.status == :received
      assert length(entries_of(doc.id)) == 2
      assert Decimal.equal?(balance(transit.id, mat.id), 4)
      assert Decimal.equal?(balance(to.id, mat.id), 0)

      assert Decimal.equal?(
               Ash.get!(StockTransferItem, item.id, authorize?: false).received_qty,
               0
             )
    end

    test "实收超界(大于发货或为负)报错含行号", ctx do
      stock_in!(ctx.company, ctx.from, ctx.material, ctx.kg, 10)
      doc = transfer!(ctx)
      item = item!(doc, %{material_id: ctx.material.id, unit_id: ctx.kg.id, qty: 4})
      shipped = ship!(doc)

      for bad <- [5, -1] do
        assert {:error, error} =
                 shipped
                 |> Ash.Changeset.for_update(:receive, %{
                   receipts: [%{"item_id" => item.id, "qty" => bad}]
                 })
                 |> Ash.update(authorize?: false)

        assert Exception.message(error) =~ "第 1 行实收数量必须在 0 与发货数量 4 之间"
      end

      assert Ash.get!(StockTransfer, doc.id, authorize?: false).status == :shipped
    end

    test "实收行不属于本单报错", ctx do
      stock_in!(ctx.company, ctx.from, ctx.material, ctx.kg, 10)
      doc = transfer!(ctx)
      item!(doc, %{material_id: ctx.material.id, unit_id: ctx.kg.id, qty: 4})
      shipped = ship!(doc)

      assert {:error, error} =
               shipped
               |> Ash.Changeset.for_update(:receive, %{
                 receipts: [%{"item_id" => Ash.UUID.generate(), "qty" => 1}]
               })
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "实收行不属于本调拨单"
    end

    test "给了 receipts 必须覆盖全部行", ctx do
      stock_in!(ctx.company, ctx.from, ctx.material, ctx.kg, 10)
      stock_in!(ctx.company, ctx.from, ctx.material2, ctx.kg, 10)
      doc = transfer!(ctx)
      item = item!(doc, %{material_id: ctx.material.id, unit_id: ctx.kg.id, qty: 4})
      item!(doc, %{idx: 2, material_id: ctx.material2.id, unit_id: ctx.kg.id, qty: 5})
      shipped = ship!(doc)

      assert {:error, error} =
               shipped
               |> Ash.Changeset.for_update(:receive, %{
                 receipts: [%{"item_id" => item.id, "qty" => 4}]
               })
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "收货数量必须覆盖全部行:第 2 行缺实收数量"
    end

    test "收货不校验仓启用(拦新不拦旧):发货后停用调入仓仍可收尾", ctx do
      %{company: co, from: from, to: to, kg: kg, material: mat} = ctx

      stock_in!(co, from, mat, kg, 10)
      doc = transfer!(ctx)
      item!(doc, %{material_id: mat.id, unit_id: kg.id, qty: 4})
      shipped = ship!(doc)

      ctx.to
      |> Ash.Changeset.for_update(:update, %{active: false})
      |> Ash.update!(authorize?: false)

      received =
        shipped
        |> Ash.Changeset.for_update(:receive, %{})
        |> Ash.update!(authorize?: false)

      assert received.status == :received
      assert Decimal.equal?(balance(to.id, mat.id), 4)
    end
  end

  test "删除草稿调拨单级联删行", ctx do
    doc = transfer!(ctx)
    item = item!(doc, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    :ok = doc |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

    assert {:error, _} = Ash.get(StockTransferItem, item.id, authorize?: false)
  end

  test "资源声明了权限前缀与行按钮", _ctx do
    assert StockTransfer.permission_prefix() == "inv.stock_transfer"
    assert StockTransfer.permission_actions() == ~w(create read update delete ship receive)
    assert StockTransferItem.permission_prefix() == "inv.stock_transfer"
    assert StockTransferItem.permission_actions() == []

    actions = StockTransfer.grid_actions()
    assert Enum.map(actions, & &1.key) == ["ship", "receive"]
    assert Enum.map(actions, & &1.label) == ["发货", "收货"]
  end
end
