defmodule SynieCore.Sales.OrderTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Base.Unit
  alias SynieCore.Files.Attachment
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Inv.{Material, MaterialCategory, MaterialUnit}
  alias SynieCore.Sales.{Customer, Order, OrderItem}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    other_company = company!()

    customer =
      Customer
      |> Ash.Changeset.for_create(:create, %{
        code: "C-#{System.unique_integer([:positive])}",
        name: "测试客户"
      })
      |> Ash.create!(authorize?: false)

    kg = unit!(%{unit_type: :weight, is_base: true, name: "千克", symbol: "kg", ratio: 1})
    box = unit!(%{unit_type: :quantity, name: "箱", symbol: "箱", ratio: 1})
    pcs = unit!(%{unit_type: :quantity, is_base: true, name: "只", symbol: "只", ratio: 1})

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "M#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material =
      Material
      |> Ash.Changeset.for_create(:create, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "螺丝",
        category_id: leaf.id,
        default_unit_id: kg.id
      })
      |> Ash.create!(authorize?: false)

    # 转换单位:1 kg = 10 箱
    MaterialUnit
    |> Ash.Changeset.for_create(:create, %{material_id: material.id, unit_id: box.id, factor: 10})
    |> Ash.create!(authorize?: false)

    order = order!(%{company_id: company.id, party_type: :customer, party_id: customer.id})

    %{
      company: company,
      other_company: other_company,
      customer: customer,
      kg: kg,
      box: box,
      pcs: pcs,
      leaf: leaf,
      material: material,
      order: order
    }
  end

  defp unit!(attrs),
    do: Unit |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)

  defp order!(attrs) do
    attrs =
      Map.merge(
        %{
          order_no: "SO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-17]
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

  defp reload!(%Order{} = order) do
    Ash.get!(Order, order.id, authorize?: false, load: [:gross_total])
  end

  defp material!(leaf, unit, attrs) do
    Material
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(
        %{code: "MAT-#{System.unique_integer([:positive])}", name: "螺母"},
        Map.merge(attrs, %{category_id: leaf.id, default_unit_id: unit.id})
      )
    )
    |> Ash.create!(authorize?: false)
  end

  # 给物料 drawing 槽位挂一张图纸,返回 sys_file(sys_file.storage 无外键,任意值即可)
  defp drawing!(material, filename \\ "图纸.pdf") do
    file =
      StoredFile
      |> Ash.Changeset.for_create(:create, %{
        storage: "test",
        key: "test/#{System.unique_integer([:positive])}-#{filename}",
        filename: filename
      })
      |> Ash.create!(authorize?: false)

    Attachment
    |> Ash.Changeset.for_create(:create, %{
      file_id: file.id,
      owner_type: "inv_material",
      owner_id: material.id,
      category: "drawing"
    })
    |> Ash.create!(authorize?: false)

    file
  end

  defp item_drawings(item_id) do
    Attachment
    |> Ash.Query.filter(
      owner_type == "sal_order_item" and owner_id == ^item_id and category == "drawing"
    )
    |> Ash.read!(authorize?: false)
  end

  defp drawing_file_ids(item_id),
    do: item_drawings(item_id) |> Enum.map(& &1.file_id) |> Enum.sort()

  test "创建默认草稿态,订单日期缺省取今天", ctx do
    assert ctx.order.status == :draft

    order =
      Order
      |> Ash.Changeset.for_create(:create, %{
        company_id: ctx.company.id,
        party_type: :customer,
        party_id: ctx.customer.id,
        order_no: "SO-#{System.unique_integer([:positive])}"
      })
      |> Ash.create!(authorize?: false)

    assert order.order_date == Date.utc_today()
  end

  test "订单号全局唯一", ctx do
    assert_raise Ash.Error.Invalid, fn ->
      order!(%{
        company_id: ctx.other_company.id,
        party_type: :customer,
        party_id: ctx.customer.id,
        order_no: ctx.order.order_no
      })
    end
  end

  test "对手类型限客户/内部公司,供应商被拒", ctx do
    supplier =
      SynieCore.Purchase.Supplier
      |> Ash.Changeset.for_create(:create, %{
        code: "S-#{System.unique_integer([:positive])}",
        name: "供应商"
      })
      |> Ash.create!(authorize?: false)

    assert {:error, error} =
             Order
             |> Ash.Changeset.for_create(:create, %{
               company_id: ctx.company.id,
               order_no: "SO-X1",
               order_date: ~D[2026-07-17],
               party_type: :supplier,
               party_id: supplier.id
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "对手类型只能为客户或内部公司"
  end

  test "内部公司作对手时不能是本公司", ctx do
    assert {:error, error} =
             Order
             |> Ash.Changeset.for_create(:create, %{
               company_id: ctx.company.id,
               order_no: "SO-X2",
               order_date: ~D[2026-07-17],
               party_type: :company,
               party_id: ctx.company.id
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "对手不能是本公司"

    # 另一家公司可以
    order =
      order!(%{
        company_id: ctx.company.id,
        party_type: :company,
        party_id: ctx.other_company.id
      })

    assert order.party_type == :company
  end

  test "条目含税金额系统算:数量×含税单价,两位小数", ctx do
    item =
      item!(ctx.order, %{
        material_id: ctx.material.id,
        unit_id: ctx.kg.id,
        qty: Decimal.new("3.333"),
        price: Decimal.new("2")
      })

    assert Decimal.equal?(item.amount, Decimal.new("6.67"))

    order = reload!(ctx.order)
    assert Decimal.equal?(order.gross_total, Decimal.new("6.67"))
  end

  test "条目税率默认 0.13,范围 [0,1)", ctx do
    item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
    assert Decimal.equal?(item.tax_rate, Decimal.new("0.13"))

    assert {:error, error} =
             OrderItem
             |> Ash.Changeset.for_create(:create, %{
               order_id: ctx.order.id,
               idx: 2,
               material_id: ctx.material.id,
               unit_id: ctx.kg.id,
               qty: 1,
               price: 1,
               tax_rate: 1
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "税率必须在 0(含)与 1 之间"
  end

  test "条目数量与单价约束:数量>0、单价可为 0", ctx do
    assert {:error, error} =
             OrderItem
             |> Ash.Changeset.for_create(:create, %{
               order_id: ctx.order.id,
               idx: 2,
               material_id: ctx.material.id,
               unit_id: ctx.kg.id,
               qty: 0,
               price: 1
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "数量必须大于零"

    # 赠品场景:单价 0 允许
    item =
      item!(ctx.order, %{
        idx: 3,
        material_id: ctx.material.id,
        unit_id: ctx.kg.id,
        qty: 1,
        price: 0
      })

    assert Decimal.equal?(item.amount, Decimal.new("0.00"))
  end

  test "条目单位限默认单位或转换单位", ctx do
    # 默认单位(kg)与转换单位(箱)均可
    item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
    item!(ctx.order, %{idx: 2, material_id: ctx.material.id, unit_id: ctx.box.id})

    # 未配转换的 pcs 被拒
    assert {:error, error} =
             OrderItem
             |> Ash.Changeset.for_create(:create, %{
               order_id: ctx.order.id,
               idx: 3,
               material_id: ctx.material.id,
               unit_id: ctx.pcs.id,
               qty: 1,
               price: 1
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "单位必须是物料默认单位或其单位转换单位"
  end

  test "空单不允许审核,至少一行", ctx do
    assert {:error, error} =
             ctx.order
             |> Ash.Changeset.for_update(:audit, %{})
             |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "审核前必须至少填写一行条目"
  end

  test "审核后锁死:头不可改、行不可增、单不可删", ctx do
    item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    audited =
      ctx.order
      |> Ash.Changeset.for_update(:audit, %{})
      |> Ash.update!(authorize?: false)

    assert audited.status == :audited
    assert audited.audited_at

    assert {:error, error} =
             audited
             |> Ash.Changeset.for_update(:update, %{remarks: "改"})
             |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "仅草稿订单可修改或删除"

    assert {:error, error} =
             OrderItem
             |> Ash.Changeset.for_create(:create, %{
               order_id: audited.id,
               idx: 2,
               material_id: ctx.material.id,
               unit_id: ctx.kg.id,
               qty: 1,
               price: 1
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "仅草稿订单可编辑条目"

    assert {:error, error} =
             audited
             |> Ash.Changeset.for_destroy(:destroy)
             |> Ash.destroy(authorize?: false)

    assert Exception.message(error) =~ "仅草稿订单可修改或删除"
  end

  test "仅已审核单可关闭/作废,两终态均不可逆", ctx do
    # 草稿不可关闭/作废
    assert {:error, _} =
             ctx.order |> Ash.Changeset.for_update(:close, %{}) |> Ash.update(authorize?: false)

    assert {:error, _} =
             ctx.order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

    item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    closed =
      ctx.order
      |> Ash.Changeset.for_update(:audit, %{})
      |> Ash.update!(authorize?: false)
      |> Ash.Changeset.for_update(:close, %{})
      |> Ash.update!(authorize?: false)

    assert closed.status == :closed

    # 关闭后不可再作废
    assert {:error, _} =
             closed |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

    # 另一单走作废
    order2 =
      order!(%{company_id: ctx.company.id, party_type: :customer, party_id: ctx.customer.id})

    item!(order2, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    voided =
      order2
      |> Ash.Changeset.for_update(:audit, %{})
      |> Ash.update!(authorize?: false)
      |> Ash.Changeset.for_update(:void, %{})
      |> Ash.update!(authorize?: false)

    assert voided.status == :voided

    # 作废后不可再关闭
    assert {:error, _} =
             voided |> Ash.Changeset.for_update(:close, %{}) |> Ash.update(authorize?: false)
  end

  test "删除草稿订单级联删行", ctx do
    item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    :ok = ctx.order |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

    assert {:error, _} = Ash.get(OrderItem, item.id, authorize?: false)
  end

  test "头字段 calculation 沿订单实时取数", ctx do
    item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    [loaded] =
      OrderItem
      |> Ash.Query.filter(id == ^item.id)
      |> Ash.Query.load([:order_date, :order_status, :party_type, :party_id])
      |> Ash.read!(authorize?: false)

    assert loaded.order_date == ~D[2026-07-17]
    assert loaded.order_status == :draft
    assert loaded.party_type == :customer
    assert loaded.party_id == ctx.customer.id
  end

  test "条目主读未指定排序时兜底行号升序(录入顺序)", ctx do
    # 乱序插入行号,默认读仍按行号升序
    item!(ctx.order, %{idx: 2, material_id: ctx.material.id, unit_id: ctx.kg.id})
    item!(ctx.order, %{idx: 3, material_id: ctx.material.id, unit_id: ctx.kg.id})
    item!(ctx.order, %{idx: 1, material_id: ctx.material.id, unit_id: ctx.kg.id})

    results =
      OrderItem
      |> Ash.Query.filter(order_id == ^ctx.order.id)
      |> Ash.read!(authorize?: false)

    assert Enum.map(results, & &1.idx) == [1, 2, 3]
  end

  test "显式排序不被行号兜底顶掉", ctx do
    item!(ctx.order, %{idx: 1, qty: 1, material_id: ctx.material.id, unit_id: ctx.kg.id})
    item!(ctx.order, %{idx: 2, qty: 3, material_id: ctx.material.id, unit_id: ctx.kg.id})
    item!(ctx.order, %{idx: 3, qty: 2, material_id: ctx.material.id, unit_id: ctx.kg.id})

    results =
      OrderItem
      |> Ash.Query.filter(order_id == ^ctx.order.id)
      |> Ash.Query.sort(qty: :desc)
      |> Ash.read!(authorize?: false)

    # 兜底若在显式排序之前生效,结果会是 [1, 2, 3]
    assert Enum.map(results, & &1.idx) == [2, 3, 1]
  end

  describe "物料信息快照" do
    test "创建行落五个快照列(编号/名称/规格/客户料号/单位名称)", ctx do
      ctx.material
      |> Ash.Changeset.for_update(:update, %{spec: "Φ12×45", customer_part_no: "KH-518"})
      |> Ash.update!(authorize?: false)

      item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

      assert item.material_code == ctx.material.code
      assert item.material_name == "螺丝"
      assert item.material_spec == "Φ12×45"
      assert item.customer_part_no == "KH-518"
      assert item.unit_name == "千克"
    end

    test "行保存即重拍:只改数量也按当前物料重拍", ctx do
      item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
      assert item.material_name == "螺丝"

      ctx.material
      |> Ash.Changeset.for_update(:update, %{name: "内六角螺丝", spec: "M6×20"})
      |> Ash.update!(authorize?: false)

      updated =
        item
        |> Ash.Changeset.for_update(:update, %{qty: 5})
        |> Ash.update!(authorize?: false)

      assert updated.material_name == "内六角螺丝"
      assert updated.material_spec == "M6×20"
    end

    test "换物料/单位重拍快照,可空字段拍成 nil", ctx do
      other = material!(ctx.leaf, ctx.pcs, %{name: "螺母", spec: "M6"})

      item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

      updated =
        item
        |> Ash.Changeset.for_update(:update, %{material_id: other.id, unit_id: ctx.pcs.id})
        |> Ash.update!(authorize?: false)

      assert updated.material_code == other.code
      assert updated.material_name == "螺母"
      assert updated.material_spec == "M6"
      assert updated.customer_part_no == nil
      assert updated.unit_name == "只"
    end
  end

  describe "图纸挂接复制" do
    test "创建行把物料 drawing 挂接复制到行(其他槽位不复制)", ctx do
      f1 = drawing!(ctx.material, "a.pdf")
      f2 = drawing!(ctx.material, "b.pdf")

      # 物料 default 槽位的文件不属于图纸,不复制
      other =
        StoredFile
        |> Ash.Changeset.for_create(:create, %{
          storage: "test",
          key: "test/#{System.unique_integer([:positive])}-x.pdf",
          filename: "x.pdf"
        })
        |> Ash.create!(authorize?: false)

      Attachment
      |> Ash.Changeset.for_create(:create, %{
        file_id: other.id,
        owner_type: "inv_material",
        owner_id: ctx.material.id,
        category: "default"
      })
      |> Ash.create!(authorize?: false)

      item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

      atts = item_drawings(item.id)
      assert Enum.map(atts, & &1.file_id) |> Enum.sort() == Enum.sort([f1.id, f2.id])
      assert Enum.all?(atts, &(&1.category == "drawing" and &1.company_id == ctx.company.id))
    end

    test "重存行整删整建跟随物料图纸增删", ctx do
      f1 = drawing!(ctx.material, "a.pdf")
      f2 = drawing!(ctx.material, "b.pdf")
      item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
      assert drawing_file_ids(item.id) == Enum.sort([f1.id, f2.id])

      # 物料删一张、增一张
      Attachment
      |> Ash.Query.filter(
        owner_type == "inv_material" and owner_id == ^ctx.material.id and file_id == ^f1.id
      )
      |> Ash.read_one!(authorize?: false)
      |> Ash.destroy!(authorize?: false)

      f3 = drawing!(ctx.material, "c.pdf")

      item
      |> Ash.Changeset.for_update(:update, %{qty: 9})
      |> Ash.update!(authorize?: false)

      assert drawing_file_ids(item.id) == Enum.sort([f2.id, f3.id])
    end

    test "删除行清理其图纸挂接(物料挂接不动)", ctx do
      f = drawing!(ctx.material)
      item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
      assert drawing_file_ids(item.id) == [f.id]

      :ok = item |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert item_drawings(item.id) == []

      material_atts =
        Attachment
        |> Ash.Query.filter(owner_type == "inv_material" and owner_id == ^ctx.material.id)
        |> Ash.read!(authorize?: false)

      assert Enum.map(material_atts, & &1.file_id) == [f.id]
    end

    test "删除草稿订单(DB 级联删行)也清理行的图纸挂接", ctx do
      f = drawing!(ctx.material)
      item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
      assert drawing_file_ids(item.id) == [f.id]

      :ok = ctx.order |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      # 行走 DB 级联(不经 OrderItem destroy 钩子),挂接由订单 destroy 显式清
      assert {:error, _} = Ash.get(OrderItem, item.id, authorize?: false)
      assert item_drawings(item.id) == []
    end

    test "文件被行挂接时拒删;物料解除挂接后仍拒删(行还挂着)", ctx do
      f = drawing!(ctx.material)
      item = item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
      assert drawing_file_ids(item.id) == [f.id]

      assert {:error, err} = Ash.destroy(f, authorize?: false)
      assert Exception.message(err) =~ "仍有业务挂接"

      # 物料解除挂接后,行的挂接仍锁着文件
      Attachment
      |> Ash.Query.filter(
        owner_type == "inv_material" and owner_id == ^ctx.material.id and file_id == ^f.id
      )
      |> Ash.read_one!(authorize?: false)
      |> Ash.destroy!(authorize?: false)

      assert {:error, err2} = Ash.destroy(f, authorize?: false)
      assert Exception.message(err2) =~ "仍有业务挂接"
    end
  end
end
