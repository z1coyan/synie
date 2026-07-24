defmodule SynieCore.Purchase.OrderOutsourcedTest do
  @moduledoc """
  委外采购(工单03):采购订单委外标记与条目委外配置。
  接缝与断言口径同 order_test.exs——Ash action 层直连,断言事实表与报错文案。
  """

  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory}
  alias SynieCore.Mfg.{Bom, BomByproduct, BomComponent}

  alias SynieCore.Purchase.{
    Order,
    OrderItem,
    OrderItemByproduct,
    OrderItemMaterial,
    Quotation,
    QuotationItem,
    Supplier
  }

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    supplier = supplier!()

    kg =
      unit!(%{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-#{System.unique_integer([:positive])}",
        ratio: 1
      })

    pcs =
      unit!(%{
        unit_type: :quantity,
        name: "只",
        symbol: "pc-#{System.unique_integer([:positive])}",
        ratio: 1
      })

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "M#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    fg = material!(leaf, kg, %{name: "委外成品"})
    raw = material!(leaf, kg, %{name: "原料甲"})
    raw2 = material!(leaf, kg, %{name: "原料乙"})
    scrap = material!(leaf, kg, %{name: "铜屑"})

    # 成品 BOM:原料甲 净2 损耗0.1;原料乙 净3 无损耗;铜屑 单位产出1.5
    bom = bom!(fg)
    comp_loss = component!(bom, raw, kg, %{quantity: 2, loss_rate: Decimal.new("0.1")})
    comp_noloss = component!(bom, raw2, kg, %{quantity: 3})
    byproduct = byproduct!(bom, scrap, kg, %{quantity: Decimal.new("1.5")})

    %{
      company: company,
      supplier: supplier,
      kg: kg,
      pcs: pcs,
      leaf: leaf,
      fg: fg,
      raw: raw,
      raw2: raw2,
      scrap: scrap,
      bom: bom,
      comp_loss: comp_loss,
      comp_noloss: comp_noloss,
      byproduct: byproduct
    }
  end

  defp supplier! do
    Supplier
    |> Ash.Changeset.for_create(:create, %{
      code: "S-#{System.unique_integer([:positive])}",
      name: "测试供应商"
    })
    |> Ash.create!(authorize?: false)
  end

  defp unit!(attrs),
    do: Unit |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

  # 物料编号仅自动取号(动作不接受 code),夹具用 seed 直写以保留确定性编号
  defp material!(leaf, unit, attrs) do
    Ash.Seed.seed!(
      Material,
      Map.merge(
        %{code: "MAT-#{System.unique_integer([:positive])}", name: "物料"},
        Map.merge(attrs, %{category_id: leaf.id, default_unit_id: unit.id})
      )
    )
  end

  defp bom!(material, attrs \\ %{}) do
    Bom
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{material_id: material.id, code: "BOM-#{System.unique_integer([:positive])}"}, attrs)
    )
    |> Ash.create!(authorize?: false)
  end

  defp component!(bom, material, unit, attrs) do
    BomComponent
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{bom_id: bom.id, material_id: material.id, unit_id: unit.id}, attrs)
    )
    |> Ash.create!(authorize?: false)
  end

  defp byproduct!(bom, material, unit, attrs) do
    BomByproduct
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{bom_id: bom.id, material_id: material.id, unit_id: unit.id}, attrs)
    )
    |> Ash.create!(authorize?: false)
  end

  defp order!(ctx, attrs) do
    attrs =
      Map.merge(
        %{
          order_no: "PO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-24],
          order_type: :spot,
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id
        },
        attrs
      )

    Order |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp item!(order, attrs) do
    attrs = Map.merge(%{idx: 1, qty: 2, price: Decimal.new("3.50")}, attrs)

    OrderItem
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{order_id: order.id}))
    |> Ash.create!(authorize?: false)
  end

  defp issue_line!(item, attrs) do
    OrderItemMaterial
    |> Ash.Changeset.for_create(:create, Map.merge(%{order_item_id: item.id}, attrs))
    |> Ash.create!(authorize?: false)
  end

  defp byproduct_line!(item, attrs) do
    OrderItemByproduct
    |> Ash.Changeset.for_create(:create, Map.merge(%{order_item_id: item.id}, attrs))
    |> Ash.create!(authorize?: false)
  end

  defp audit!(order) do
    order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
  end

  # 常规委外单 + 已审核固定价报价(同公司/供应商/币种,日期区间覆盖订单日期)
  defp audited_fg_qitem!(ctx) do
    quotation =
      Quotation
      |> Ash.Changeset.for_create(:create, %{
        quotation_no: "PQ-#{System.unique_integer([:positive])}",
        quotation_date: ~D[2026-07-24],
        valid_until: ~D[2026-08-24],
        company_id: ctx.company.id,
        party_type: :supplier,
        party_id: ctx.supplier.id
      })
      |> Ash.create!(authorize?: false)

    qitem =
      QuotationItem
      |> Ash.Changeset.for_create(:create, %{
        quotation_id: quotation.id,
        idx: 1,
        material_id: ctx.fg.id,
        unit_id: ctx.kg.id,
        price: Decimal.new("5.00")
      })
      |> Ash.create!(authorize?: false)

    quotation |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    qitem
  end

  describe "委外标记" do
    test "默认否,新建期可勾选", ctx do
      plain = order!(ctx, %{})
      assert plain.is_outsourced == false

      outsourced = order!(ctx, %{is_outsourced: true})
      assert outsourced.is_outsourced == true
    end

    test "保存后锁死:更新动作拒绝修改(两个方向)", ctx do
      order = order!(ctx, %{is_outsourced: true})

      assert {:error, error} =
               order
               |> Ash.Changeset.for_update(:update, %{is_outsourced: false})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "委外标记不可变更"

      plain = order!(ctx, %{})

      assert {:error, error} =
               plain
               |> Ash.Changeset.for_update(:update, %{is_outsourced: true})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "委外标记不可变更"

      # 不动委外标记的更新不受拦
      updated =
        order
        |> Ash.Changeset.for_update(:update, %{remarks: "只改备注"})
        |> Ash.update!(authorize?: false)

      assert updated.is_outsourced == true
    end

    test "常规委外条目照常强制有效采购报价引用(报价即加工费报价)", ctx do
      order = order!(ctx, %{order_type: :regular, is_outsourced: true})

      assert {:error, error} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: order.id,
                 idx: 1,
                 material_id: ctx.fg.id,
                 unit_id: ctx.kg.id,
                 qty: 2,
                 price: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "常规订单条目必须选择报价条目"

      qitem = audited_fg_qitem!(ctx)
      item = item!(order, %{quotation_item_id: qitem.id})

      # 物料/单位/单价由报价派生(加工费单价)
      assert item.material_id == ctx.fg.id
      assert Decimal.equal?(item.price, Decimal.new("5.00"))
      assert audit!(order).status == :audited
    end

    test "零星委外手填加工费,不受报价引用约束", ctx do
      order = order!(ctx, %{order_type: :spot, is_outsourced: true})

      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id, price: Decimal.new("8.80")})

      assert item.quotation_item_id == nil
      assert Decimal.equal?(item.price, Decimal.new("8.80"))
      assert audit!(order).status == :audited
    end
  end

  describe "成品 BOM 引用" do
    test "可引用条目物料自身的 BOM,可空不配不挡开单审核", ctx do
      order = order!(ctx, %{is_outsourced: true})
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id, bom_id: ctx.bom.id})

      assert item.bom_id == ctx.bom.id

      # 无 BOM 无清单照样审核
      plain = item!(order, %{idx: 2, material_id: ctx.fg.id, unit_id: ctx.kg.id})
      assert plain.bom_id == nil
      assert audit!(order).status == :audited
    end

    test "限条目物料自身的 BOM:他物料 BOM 建/改均被拒", ctx do
      other_bom = bom!(ctx.raw)
      order = order!(ctx, %{is_outsourced: true})

      assert {:error, error} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: order.id,
                 idx: 1,
                 material_id: ctx.fg.id,
                 unit_id: ctx.kg.id,
                 qty: 2,
                 price: 1,
                 bom_id: other_bom.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "BOM 必须是条目物料自身的 BOM"

      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id})

      assert {:error, error} =
               item
               |> Ash.Changeset.for_update(:update, %{bom_id: other_bom.id})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "BOM 必须是条目物料自身的 BOM"
    end

    test "仅留痕无活引用:BOM 删除后条目引用自动清空", ctx do
      order = order!(ctx, %{is_outsourced: true})
      bom = bom!(ctx.fg)
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id, bom_id: bom.id})

      :ok = bom |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Ash.get!(OrderItem, item.id, authorize?: false).bom_id == nil
    end
  end

  describe "发料清单/副产物清单" do
    test "发料清单行可增删改,已发料量初始 0", ctx do
      order = order!(ctx, %{is_outsourced: true})
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id})

      line =
        issue_line!(item, %{
          material_id: ctx.raw.id,
          unit_id: ctx.kg.id,
          quantity: 22,
          remarks: "首批"
        })

      assert line.order_item_id == item.id
      assert line.company_id == ctx.company.id
      assert Decimal.equal?(line.quantity, Decimal.new(22))
      assert Decimal.equal?(line.issued_qty, Decimal.new(0))

      updated =
        line
        |> Ash.Changeset.for_update(:update, %{quantity: 25, remarks: "改"})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(updated.quantity, Decimal.new(25))
      assert updated.remarks == "改"

      :ok = updated |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
      assert {:error, _} = Ash.get(OrderItemMaterial, line.id, authorize?: false)
    end

    test "副产物清单行可增删改", ctx do
      order = order!(ctx, %{is_outsourced: true})
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id})

      line =
        byproduct_line!(item, %{material_id: ctx.scrap.id, unit_id: ctx.kg.id, quantity: 3})

      assert Decimal.equal?(line.quantity, Decimal.new(3))

      updated =
        line
        |> Ash.Changeset.for_update(:update, %{quantity: 4})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(updated.quantity, Decimal.new(4))

      :ok = updated |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
      assert {:error, _} = Ash.get(OrderItemByproduct, line.id, authorize?: false)
    end

    test "清单行单位限物料默认单位或转换单位,数量必须大于零", ctx do
      order = order!(ctx, %{is_outsourced: true})
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id})

      assert {:error, error} =
               OrderItemMaterial
               |> Ash.Changeset.for_create(:create, %{
                 order_item_id: item.id,
                 material_id: ctx.raw.id,
                 unit_id: ctx.pcs.id,
                 quantity: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "单位必须是物料默认单位或其单位转换单位"

      assert {:error, error} =
               OrderItemByproduct
               |> Ash.Changeset.for_create(:create, %{
                 order_item_id: item.id,
                 material_id: ctx.scrap.id,
                 unit_id: ctx.kg.id,
                 quantity: 0
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "数量必须大于零"
    end

    test "仅草稿订单可维护清单(审核后增行被拒)", ctx do
      order = order!(ctx, %{is_outsourced: true})
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id})
      audit!(order)

      assert {:error, error} =
               OrderItemMaterial
               |> Ash.Changeset.for_create(:create, %{
                 order_item_id: item.id,
                 material_id: ctx.raw.id,
                 unit_id: ctx.kg.id,
                 quantity: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅草稿订单可编辑条目"
    end

    test "清单随条目级联删除,随订单级联删除", ctx do
      order = order!(ctx, %{is_outsourced: true})
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id})
      line1 = issue_line!(item, %{material_id: ctx.raw.id, unit_id: ctx.kg.id, quantity: 1})
      line2 = byproduct_line!(item, %{material_id: ctx.scrap.id, unit_id: ctx.kg.id, quantity: 1})

      :ok = item |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
      assert {:error, _} = Ash.get(OrderItemMaterial, line1.id, authorize?: false)
      assert {:error, _} = Ash.get(OrderItemByproduct, line2.id, authorize?: false)

      # 随订单级联(订单删行走 DB 级联,清单行再走条目级联)
      order2 = order!(ctx, %{is_outsourced: true})
      item2 = item!(order2, %{material_id: ctx.fg.id, unit_id: ctx.kg.id})
      line3 = issue_line!(item2, %{material_id: ctx.raw.id, unit_id: ctx.kg.id, quantity: 1})

      :ok = order2 |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
      assert {:error, _} = Ash.get(OrderItemMaterial, line3.id, authorize?: false)
    end
  end

  describe "BOM 代入折算(calculation 接缝)" do
    test "发料理论耗用=净用量×(1+损耗率,空按 0)×条目数量", ctx do
      load = fn component ->
        BomComponent
        |> Ash.Query.filter(id == ^component.id)
        |> Ash.Query.load(apply_qty: %{qty: Decimal.new(10)})
        |> Ash.read_one!(authorize?: false)
      end

      # 净2 损耗0.1 ×10 = 22;净3 无损耗 ×10 = 30
      assert Decimal.equal?(load.(ctx.comp_loss).apply_qty, Decimal.new(22))
      assert Decimal.equal?(load.(ctx.comp_noloss).apply_qty, Decimal.new(30))
    end

    test "副产物代入=单位产出量×条目数量", ctx do
      [line] =
        BomByproduct
        |> Ash.Query.filter(bom_id == ^ctx.bom.id)
        |> Ash.Query.load(apply_qty: %{qty: Decimal.new(10)})
        |> Ash.read!(authorize?: false)

      assert Decimal.equal?(line.apply_qty, Decimal.new(15))
    end
  end

  describe "快照脱钩" do
    test "改条目数量不自动重算清单", ctx do
      order = order!(ctx, %{is_outsourced: true})
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id, qty: 2})
      line = issue_line!(item, %{material_id: ctx.raw.id, unit_id: ctx.kg.id, quantity: 22})

      item
      |> Ash.Changeset.for_update(:update, %{qty: 5})
      |> Ash.update!(authorize?: false)

      assert Decimal.equal?(
               Ash.get!(OrderItemMaterial, line.id, authorize?: false).quantity,
               Decimal.new(22)
             )
    end

    test "BOM 后续变更不回溯清单,清单可自由删改", ctx do
      order = order!(ctx, %{is_outsourced: true})
      item = item!(order, %{material_id: ctx.fg.id, unit_id: ctx.kg.id, bom_id: ctx.bom.id})

      # 按代入口径手建快照行(代入动作本身在前端显式触发,快照行落库后与 BOM 无联动)
      line = issue_line!(item, %{material_id: ctx.raw.id, unit_id: ctx.kg.id, quantity: 22})

      ctx.comp_loss
      |> Ash.Changeset.for_update(:update, %{quantity: 9})
      |> Ash.update!(authorize?: false)

      assert Decimal.equal?(
               Ash.get!(OrderItemMaterial, line.id, authorize?: false).quantity,
               Decimal.new(22)
             )
    end
  end
end
