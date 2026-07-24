defmodule SynieCore.Purchase.OutsourcedIssueTest do
  @moduledoc """
  委外发料单(工单04)。接缝与断言口径同 receipt_test.exs——Ash action 层直连,
  断言事实表(库存分录)、受控投影(发料清单行已发料量)与报错文案。
  """

  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz
  alias SynieCore.Base.Unit

  alias SynieCore.Inv.{
    Material,
    MaterialCategory,
    StockDoc,
    StockDocItem,
    StockEntry,
    Warehouse
  }

  alias SynieCore.Purchase.{
    Order,
    OrderItem,
    OrderItemMaterial,
    OutsourcedIssue,
    OutsourcedIssueItem,
    Supplier
  }

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    supplier = supplier!()

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-oi#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "O#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    raw =
      Ash.Seed.seed!(Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "铜杆",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    from_wh = warehouse!(company, "材料仓")

    outsourced_wh =
      Warehouse
      |> Ash.Changeset.for_create(:create, %{
        name: "外协仓-#{supplier.name}",
        company_id: company.id,
        is_outsourced: true,
        party_type: :supplier,
        party_id: supplier.id
      })
      |> Ash.create!(authorize?: false)

    {order, _order_item, line} = audited_order_with_line!(company, supplier, raw, kg)

    %{
      company: company,
      supplier: supplier,
      kg: kg,
      raw: raw,
      from_wh: from_wh,
      outsourced_wh: outsourced_wh,
      order: order,
      material_line: line
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

  defp warehouse!(company, name, attrs \\ %{}) do
    Warehouse
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{name: "#{name}-#{System.unique_integer([:positive])}", company_id: company.id}, Map.new(attrs))
    )
    |> Ash.create!(authorize?: false)
  end

  # 已审核零星委外订单:一条成品条目 + 一行发料清单(原料 10)
  defp audited_order_with_line!(company, supplier, raw, unit, attrs \\ %{}) do
    order =
      Order
      |> Ash.Changeset.for_create(
        :create,
        Map.merge(
          %{
            order_no: "PO-#{System.unique_integer([:positive])}",
            order_date: ~D[2026-07-24],
            order_type: :spot,
            is_outsourced: true,
            company_id: company.id,
            party_type: :supplier,
            party_id: supplier.id
          },
          Map.new(attrs)
        )
      )
      |> Ash.create!(authorize?: false)

    order_item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: raw.id,
        unit_id: unit.id,
        qty: Decimal.new(2),
        price: Decimal.new("100.00")
      })
      |> Ash.create!(authorize?: false)

    line =
      OrderItemMaterial
      |> Ash.Changeset.for_create(:create, %{
        order_item_id: order_item.id,
        material_id: raw.id,
        unit_id: unit.id,
        quantity: Decimal.new(10)
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    {order, order_item, line}
  end

  defp issue!(attrs) do
    OutsourcedIssue
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{
          issue_no: "OI-#{System.unique_integer([:positive])}",
          issue_date: ~D[2026-07-24]
        },
        attrs
      )
    )
    |> Ash.create!(authorize?: false)
  end

  defp issue_line!(issue, attrs) do
    OutsourcedIssueItem
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{idx: 1, qty: Decimal.new(3)}, attrs) |> Map.put(:issue_id, issue.id)
    )
    |> Ash.create!(authorize?: false)
  end

  # 经手工出入库单审核给仓垫库存(direction :in 入库 / :out 出库)
  defp stock_move!(warehouse, material, unit, direction, qty) do
    doc =
      StockDoc
      |> Ash.Changeset.for_create(:create, %{
        doc_no: "IO-#{System.unique_integer([:positive])}",
        company_id: warehouse.company_id,
        warehouse_id: warehouse.id,
        direction: direction,
        doc_date: ~D[2026-07-24]
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

  defp entries(issue_id) do
    StockEntry
    |> Ash.Query.filter(voucher_type == "purchase.outsourced_issue" and voucher_id == ^issue_id)
    |> Ash.read!(authorize?: false)
  end

  defp reload_line(line), do: Ash.get!(OrderItemMaterial, line.id, authorize?: false)

  describe "建单与取行" do
    test "单号留空按编号规则自动取号(独立系列随迁移种子)", ctx do
      issue =
        OutsourcedIssue
        |> Ash.Changeset.for_create(:create, %{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          issue_date: ~D[2026-07-24]
        })
        |> Ash.create!(authorize?: false)

      assert issue.issue_no =~ ~r/^P[(]I[)]-/
    end

    test "行必挂发料清单行,带出材料/单位并快照,折算数量系统算", ctx do
      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        issue_line!(issue, %{
          order_item_material_id: ctx.material_line.id,
          qty: Decimal.new(3),
          from_warehouse_id: ctx.from_wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id,
          remarks: "首批"
        })

      assert item.material_id == ctx.raw.id
      assert item.unit_id == ctx.kg.id
      assert item.company_id == ctx.company.id
      assert Decimal.equal?(item.base_qty, Decimal.new(3))
      # 快照:物料编号/名称 + 单位名 + 订单号
      assert item.material_code == ctx.raw.code
      assert item.material_name == "铜杆"
      assert item.unit_name == "千克"
      assert item.order_no == ctx.order.order_no
    end

    test "行单位/物料以发料清单行为准,不可手改", ctx do
      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      other =
        Ash.Seed.seed!(Material, %{
          code: "MAT-#{System.unique_integer([:positive])}",
          name: "铝棒",
          category_id: ctx.raw.category_id,
          default_unit_id: ctx.kg.id
        })

      item =
        issue_line!(issue, %{
          order_item_material_id: ctx.material_line.id,
          material_id: other.id,
          qty: Decimal.new(1),
          from_warehouse_id: ctx.from_wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      assert item.material_id == ctx.raw.id
    end

    test "头对手与所引委外订单对手不一致被拒", ctx do
      other_supplier = supplier!()

      issue =
        issue!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: other_supplier.id
        })

      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: ctx.material_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: ctx.from_wh.id,
                 outsourced_warehouse_id:
                   warehouse!(ctx.company, "外协仓B",
                     is_outsourced: true,
                     party_type: :supplier,
                     party_id: other_supplier.id
                   ).id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "订单对手与发料单不一致"
    end

    test "订单公司与发料单不一致被拒", ctx do
      other_company = company!()
      other_supplier = supplier!()

      issue =
        issue!(%{
          company_id: other_company.id,
          party_type: :supplier,
          party_id: other_supplier.id
        })

      out_wh =
        warehouse!(other_company, "外协仓C",
          is_outsourced: true,
          party_type: :supplier,
          party_id: other_supplier.id
        )

      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: ctx.material_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: warehouse!(other_company, "材料仓").id,
                 outsourced_warehouse_id: out_wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "订单公司与发料单不一致"
    end

    test "仅委外订单的发料清单行可取行;订单未审核不可发料", ctx do
      # 非委外订单(同样能挂发料清单行时)
      {_order, _item, plain_line} =
        audited_order_with_line!(ctx.company, ctx.supplier, ctx.raw, ctx.kg,
          is_outsourced: false
        )

      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: plain_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: ctx.from_wh.id,
                 outsourced_warehouse_id: ctx.outsourced_wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅委外订单的发料清单行可取行"

      # 草稿订单的清单行
      draft_order =
        Order
        |> Ash.Changeset.for_create(:create, %{
          order_no: "PO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-24],
          order_type: :spot,
          is_outsourced: true,
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id
        })
        |> Ash.create!(authorize?: false)

      draft_item =
        OrderItem
        |> Ash.Changeset.for_create(:create, %{
          order_id: draft_order.id,
          idx: 1,
          material_id: ctx.raw.id,
          unit_id: ctx.kg.id,
          qty: Decimal.new(1),
          price: Decimal.new("1.00")
        })
        |> Ash.create!(authorize?: false)

      draft_line =
        OrderItemMaterial
        |> Ash.Changeset.for_create(:create, %{
          order_item_id: draft_item.id,
          material_id: ctx.raw.id,
          unit_id: ctx.kg.id,
          quantity: Decimal.new(5)
        })
        |> Ash.create!(authorize?: false)

      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: draft_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: ctx.from_wh.id,
                 outsourced_warehouse_id: ctx.outsourced_wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅已审核订单可发料"
    end

    test "行调出仓限本公司启用叶子仓;行外协仓限绑定当前对手", ctx do
      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      # 调出仓:停用被拒
      disabled = warehouse!(ctx.company, "停用仓", %{active: false})

      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: ctx.material_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: disabled.id,
                 outsourced_warehouse_id: ctx.outsourced_wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仓库已停用"

      # 调出仓:非叶子被拒
      parent = warehouse!(ctx.company, "归集仓", %{is_leaf: false})

      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: ctx.material_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: parent.id,
                 outsourced_warehouse_id: ctx.outsourced_wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "只有叶子仓库才能发生库存"

      # 外协仓:普通仓(非外协)被拒
      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: ctx.material_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: ctx.from_wh.id,
                 outsourced_warehouse_id: ctx.from_wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仓库不是外协仓"

      # 外协仓:绑定其他对手被拒
      other_supplier = supplier!()

      other_out =
        warehouse!(ctx.company, "外协仓D",
          is_outsourced: true,
          party_type: :supplier,
          party_id: other_supplier.id
        )

      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: ctx.material_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: ctx.from_wh.id,
                 outsourced_warehouse_id: other_out.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "外协仓绑定的协作方与单据对手不一致"

      # 外协仓:其他公司的仓被拒
      other_company = company!()

      foreign_out =
        warehouse!(other_company, "外协仓E",
          is_outsourced: true,
          party_type: :supplier,
          party_id: ctx.supplier.id
        )

      assert {:error, error} =
               OutsourcedIssueItem
               |> Ash.Changeset.for_create(:create, %{
                 issue_id: issue.id,
                 idx: 1,
                 order_item_material_id: ctx.material_line.id,
                 qty: Decimal.new(1),
                 from_warehouse_id: ctx.from_wh.id,
                 outsourced_warehouse_id: foreign_out.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仓库不属于本公司"
    end
  end

  describe "审核" do
    test "审核同事务写「调出仓负+外协仓正」分录并累加已发料量", ctx do
      stock_move!(ctx.from_wh, ctx.raw, ctx.kg, :in, Decimal.new(10))

      issue =
        issue!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          remarks: "发第一批料"
        })

      issue_line!(issue, %{
        order_item_material_id: ctx.material_line.id,
        qty: Decimal.new(4),
        from_warehouse_id: ctx.from_wh.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      issue = issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert issue.status == :audited
      assert issue.audited_at != nil

      entries = entries(issue.id)
      assert length(entries) == 2

      out_entry = Enum.find(entries, &(&1.warehouse_id == ctx.from_wh.id))
      in_entry = Enum.find(entries, &(&1.warehouse_id == ctx.outsourced_wh.id))

      assert Decimal.equal?(out_entry.quantity, Decimal.new(-4))
      assert Decimal.equal?(in_entry.quantity, Decimal.new(4))
      assert out_entry.material_id == ctx.raw.id
      assert out_entry.posting_date == ~D[2026-07-24]
      assert out_entry.voucher_no == issue.issue_no
      assert out_entry.remarks == "发第一批料"
      assert Enum.all?(entries, &(&1.is_cancelled == false))

      assert Decimal.equal?(reload_line(ctx.material_line).issued_qty, Decimal.new(4))
    end

    test "可跨多张同公司同对手委外订单取行,一单多行分仓", ctx do
      stock_move!(ctx.from_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))
      {_order2, _item2, line2} =
        audited_order_with_line!(ctx.company, ctx.supplier, ctx.raw, ctx.kg)

      from2 = warehouse!(ctx.company, "材料仓二")
      stock_move!(from2, ctx.raw, ctx.kg, :in, Decimal.new(5))

      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      issue_line!(issue, %{
        order_item_material_id: ctx.material_line.id,
        qty: Decimal.new(3),
        from_warehouse_id: ctx.from_wh.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      issue_line!(issue, %{
        idx: 2,
        order_item_material_id: line2.id,
        qty: Decimal.new(2),
        from_warehouse_id: from2.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      issue = issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert issue.status == :audited

      assert Decimal.equal?(reload_line(ctx.material_line).issued_qty, Decimal.new(3))
      assert Decimal.equal?(reload_line(line2).issued_qty, Decimal.new(2))

      # 两行 × 两仓 = 4 条分录
      assert length(entries(issue.id)) == 4
    end

    test "超发不硬拦:已发料量超清单数量仅展示", ctx do
      stock_move!(ctx.from_wh, ctx.raw, ctx.kg, :in, Decimal.new(20))

      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      issue_line!(issue, %{
        order_item_material_id: ctx.material_line.id,
        qty: Decimal.new(12),
        from_warehouse_id: ctx.from_wh.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      issue = issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert issue.status == :audited

      line = reload_line(ctx.material_line)
      assert Decimal.equal?(line.issued_qty, Decimal.new(12))
      assert Decimal.compare(line.issued_qty, line.quantity) == :gt
    end

    test "调出仓余额不足审核被拒(负库存校验)", ctx do
      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      issue_line!(issue, %{
        order_item_material_id: ctx.material_line.id,
        qty: Decimal.new(4),
        from_warehouse_id: ctx.from_wh.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      assert {:error, error} =
               issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "库存不足"
      assert Ash.get!(OutsourcedIssue, issue.id, authorize?: false).status == :draft
      assert Decimal.equal?(reload_line(ctx.material_line).issued_qty, Decimal.new(0))
    end

    test "无行审核被拒;已审核不可重复审核", ctx do
      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      assert {:error, error} =
               issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "审核前必须至少填写一行发料条目"

      stock_move!(ctx.from_wh, ctx.raw, ctx.kg, :in, Decimal.new(10))

      issue_line!(issue, %{
        order_item_material_id: ctx.material_line.id,
        qty: Decimal.new(1),
        from_warehouse_id: ctx.from_wh.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外发料单可审核"
    end
  end

  describe "作废" do
    test "作废回滚库存分录与已发料量", ctx do
      stock_move!(ctx.from_wh, ctx.raw, ctx.kg, :in, Decimal.new(10))

      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      issue_line!(issue, %{
        order_item_material_id: ctx.material_line.id,
        qty: Decimal.new(4),
        from_warehouse_id: ctx.from_wh.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      issue = issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
      assert Decimal.equal?(reload_line(ctx.material_line).issued_qty, Decimal.new(4))

      issue = issue |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert issue.status == :voided

      assert Decimal.equal?(reload_line(ctx.material_line).issued_qty, Decimal.new(0))
      assert entries(issue.id) |> Enum.all?(& &1.is_cancelled)
    end

    test "作废照常过负库存校验:外协仓材料已耗用致负则拒", ctx do
      stock_move!(ctx.from_wh, ctx.raw, ctx.kg, :in, Decimal.new(10))

      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      issue_line!(issue, %{
        order_item_material_id: ctx.material_line.id,
        qty: Decimal.new(4),
        from_warehouse_id: ctx.from_wh.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      issue = issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      # 外协仓的料被手工出掉(如协作方退回),作废会致负
      stock_move!(ctx.outsourced_wh, ctx.raw, ctx.kg, :out, Decimal.new(4))

      assert {:error, error} =
               issue |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "库存不足"
      assert Ash.get!(OutsourcedIssue, issue.id, authorize?: false).status == :audited
      assert Decimal.equal?(reload_line(ctx.material_line).issued_qty, Decimal.new(4))
    end

    test "仅已审核可作废", ctx do
      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      assert {:error, error} =
               issue |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅已审核委外发料单可作废"
    end
  end

  describe "生命周期" do
    test "仅草稿可改可删,行随单级联删除", ctx do
      stock_move!(ctx.from_wh, ctx.raw, ctx.kg, :in, Decimal.new(10))

      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        issue_line!(issue, %{
          order_item_material_id: ctx.material_line.id,
          qty: Decimal.new(1),
          from_warehouse_id: ctx.from_wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      # 草稿可改
      updated =
        issue
        |> Ash.Changeset.for_update(:update, %{remarks: "改备注"})
        |> Ash.update!(authorize?: false)

      assert updated.remarks == "改备注"

      issue = issue |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      # 已审核不可改不可删
      assert {:error, error} =
               issue
               |> Ash.Changeset.for_update(:update, %{remarks: "再改"})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外发料单可修改或删除"

      assert {:error, error} =
               issue |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外发料单可修改或删除"

      # 已审核单据的行不可编辑
      assert {:error, error} =
               item
               |> Ash.Changeset.for_update(:update, %{qty: Decimal.new(2)})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "仅草稿委外发料单可编辑发料条目"

      # 草稿删单行随删
      draft =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      draft_item =
        issue_line!(draft, %{
          order_item_material_id: ctx.material_line.id,
          qty: Decimal.new(1),
          from_warehouse_id: ctx.from_wh.id,
          outsourced_warehouse_id: ctx.outsourced_wh.id
        })

      :ok = draft |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
      assert {:error, _} = Ash.get(OutsourcedIssueItem, draft_item.id, authorize?: false)
    end

    test "头有行时公司/对手不可再改", ctx do
      issue =
        issue!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      issue_line!(issue, %{
        order_item_material_id: ctx.material_line.id,
        qty: Decimal.new(1),
        from_warehouse_id: ctx.from_wh.id,
        outsourced_warehouse_id: ctx.outsourced_wh.id
      })

      other_supplier = supplier!()

      assert {:error, error} =
               issue
               |> Ash.Changeset.for_update(:update, %{party_id: other_supplier.id})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "请先删除发料条目"

      # 不动关键字段的更新不受拦
      assert %{remarks: "只改备注"} =
               issue
               |> Ash.Changeset.for_update(:update, %{remarks: "只改备注"})
               |> Ash.update!(authorize?: false)
    end
  end

  describe "权限" do
    test "无 purchase.outsourced_issue 权限者创建被拒绝", ctx do
      user = user!()
      role = role!()
      assign!(user, role)
      grant_company!(user, ctx.company)
      actor = Authz.build_actor(user)

      assert_raise Ash.Error.Forbidden, fn ->
        OutsourcedIssue
        |> Ash.Changeset.for_create(:create, %{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          issue_no: "OI-N1",
          issue_date: ~D[2026-07-24]
        })
        |> Ash.create!(actor: actor)
      end
    end
  end
end
