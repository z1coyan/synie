defmodule SynieCore.Sales.OrderTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Base.Unit
  alias SynieCore.Files.Attachment
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Inv.{Material, MaterialCategory, MaterialUnit}

  alias SynieCore.Sales.{
    Customer,
    Order,
    OrderItem,
    Quotation,
    QuotationItem,
    QuotationTier,
    Setting
  }

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

    # 不抢 is_base 与迁移内置的 吨/kg(symbol 全局唯一);测试不依赖基准单位语义
    kg =
      unit!(%{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-#{System.unique_integer([:positive])}",
        ratio: 1
      })

    box =
      unit!(%{
        unit_type: :quantity,
        name: "箱",
        symbol: "bx-#{System.unique_integer([:positive])}",
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

    # 物料编号仅自动取号(动作不接受 code),夹具用 seed 直写以保留确定性编号
    material =
      Ash.Seed.seed!(Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "螺丝",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

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

  # 既有用例走样品单(自由录物料/价,不挂报价);常规单的报价派生见「订单分型」describe
  defp order!(attrs) do
    attrs =
      Map.merge(
        %{
          order_no: "SO-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-17],
          order_type: :sample
        },
        attrs
      )

    Order |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp regular_order!(attrs),
    do: order!(Map.put(attrs, :order_type, :regular))

  defp quotation!(attrs) do
    attrs =
      Map.merge(
        %{
          quotation_no: "QT-#{System.unique_integer([:positive])}",
          quotation_date: ~D[2026-07-17],
          valid_until: ~D[2026-08-17]
        },
        attrs
      )

    Quotation |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp qitem!(quotation, attrs) do
    attrs = Map.merge(%{idx: 1, price: Decimal.new("3.50")}, attrs)

    QuotationItem
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{quotation_id: quotation.id}))
    |> Ash.create!(authorize?: false)
  end

  defp tier!(item, attrs) do
    QuotationTier
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{item_id: item.id}))
    |> Ash.create!(authorize?: false)
  end

  defp audit_quotation!(quotation) do
    quotation
    |> Ash.Changeset.for_update(:audit, %{})
    |> Ash.update!(authorize?: false)
  end

  # 常规单 + 已审核固定价报价(同公司/客户/币种,日期区间覆盖订单日期)
  defp audited_fixed_qitem!(ctx, attrs \\ %{}) do
    quotation =
      quotation!(%{
        company_id: ctx.company.id,
        party_type: :customer,
        party_id: ctx.customer.id
      })

    qitem =
      qitem!(
        quotation,
        Map.merge(%{material_id: ctx.material.id, unit_id: ctx.kg.id}, attrs)
      )

    audit_quotation!(quotation)
    qitem
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
    Ash.Seed.seed!(
      Material,
      Map.merge(
        %{code: "MAT-#{System.unique_integer([:positive])}", name: "螺母"},
        Map.merge(attrs, %{category_id: leaf.id, default_unit_id: unit.id})
      )
    )
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

  test "创建默认草稿态,订单日期缺省取今天,类型缺省常规", ctx do
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
    assert order.order_type == :regular
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
      # 客户方产品编号仅客户料可持有(非客户料保存即清空),先升级为客户料
      ctx.material
      |> Ash.Changeset.for_update(:update, %{
        spec: "Φ12×45",
        is_customer_material: true,
        customer_id: ctx.customer.id,
        customer_part_no: "KH-518"
      })
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

  describe "双币" do
    test "公司本币必填", _ctx do
      assert_raise Ash.Error.Invalid, ~r/base_currency/, fn ->
        SynieCore.Base.Company
        |> Ash.Changeset.for_create(:create, %{code: "zz", name: "无本币公司", short_name: "无币"})
        |> Ash.create!(authorize?: false)
      end
    end

    test "币种留空默认公司本币,汇率强制 1", ctx do
      assert ctx.order.currency_id == ctx.company.base_currency_id
      assert Decimal.equal?(ctx.order.exchange_rate, 1)
    end

    test "本币订单手填汇率被强制回 1", ctx do
      order =
        order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          currency_id: ctx.company.base_currency_id,
          exchange_rate: Decimal.new("7.25")
        })

      assert Decimal.equal?(order.exchange_rate, 1)
    end

    test "外币订单不填汇率报错", ctx do
      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      assert_raise Ash.Error.Invalid, ~r/外币订单必须填写汇率/, fn ->
        order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          currency_id: usd.id
        })
      end
    end

    test "汇率必须大于零", ctx do
      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      assert_raise Ash.Error.Invalid, ~r/汇率必须大于零/, fn ->
        order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          currency_id: usd.id,
          exchange_rate: Decimal.new("-1")
        })
      end
    end

    test "外币行按金额链换算(本币金额从原币金额换,本币单价仅展示)", ctx do
      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      order =
        order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          currency_id: usd.id,
          exchange_rate: Decimal.new("7.25")
        })

      item =
        item!(order, %{
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          qty: 3,
          price: Decimal.new("9.99")
        })

      assert Decimal.equal?(item.amount, Decimal.new("29.97"))
      assert Decimal.equal?(item.base_amount, Decimal.new("217.28"))
      assert Decimal.equal?(item.base_price, Decimal.new("72.4275"))
    end

    test "本币订单双套同值落库", ctx do
      item =
        item!(ctx.order, %{
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          qty: 2,
          price: Decimal.new("3.50")
        })

      assert Decimal.equal?(item.amount, Decimal.new("7.00"))
      assert Decimal.equal?(item.base_amount, item.amount)
      assert Decimal.equal?(item.base_price, item.price)
    end

    test "草稿改汇率全部行本币列重算,双币总额聚合正确", ctx do
      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      order =
        order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          currency_id: usd.id,
          exchange_rate: Decimal.new("7")
        })

      item =
        item!(order, %{
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          qty: 2,
          price: Decimal.new("3.50")
        })

      assert Decimal.equal?(item.base_amount, Decimal.new("49.00"))

      order
      |> Ash.Changeset.for_update(:update, %{exchange_rate: Decimal.new("7.5")})
      |> Ash.update!(authorize?: false)

      item = Ash.get!(OrderItem, item.id, authorize?: false)
      assert Decimal.equal?(item.base_amount, Decimal.new("52.50"))
      assert Decimal.equal?(item.base_price, Decimal.new("26.25"))

      order =
        Ash.get!(Order, order.id, authorize?: false, load: [:gross_total, :base_gross_total])

      assert Decimal.equal?(order.gross_total, Decimal.new("7.00"))
      assert Decimal.equal?(order.base_gross_total, Decimal.new("52.50"))
    end

    test "外币单改回本币:有条目被头变更闸拦,删条目后改币种汇率强制 1", ctx do
      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      order =
        order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          currency_id: usd.id,
          exchange_rate: Decimal.new("7.25")
        })

      item =
        item!(order, %{
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          qty: 2,
          price: Decimal.new("3.50")
        })

      refute Decimal.equal?(item.base_amount, item.amount)

      # 有条目时改币种被头变更闸拦下
      assert {:error, error} =
               order
               |> Ash.Changeset.for_update(:update, %{currency_id: ctx.company.base_currency_id})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "请先删除订单条目"

      :ok = item |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      order =
        order
        |> Ash.Changeset.for_update(:update, %{currency_id: ctx.company.base_currency_id})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(order.exchange_rate, 1)
    end

    test "不动币种/汇率的头更新不影响汇率也不空重算", ctx do
      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      order =
        order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          currency_id: usd.id,
          exchange_rate: Decimal.new("7.25")
        })

      updated =
        order
        |> Ash.Changeset.for_update(:update, %{remarks: "只改备注"})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(updated.exchange_rate, Decimal.new("7.25"))
      assert updated.currency_id == usd.id
    end
  end

  describe "订单分型:常规行报价派生" do
    test "固定价报价派生物料/单位/单价/税率,用户传值被覆盖", ctx do
      qitem =
        audited_fixed_qitem!(ctx, %{price: Decimal.new("3.50"), tax_rate: Decimal.new("0.06")})

      other = material!(ctx.leaf, ctx.pcs, %{name: "螺母"})

      order =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      # 用户传的物料/单位/单价被报价条目强制覆盖
      item =
        item!(order, %{
          material_id: other.id,
          unit_id: ctx.pcs.id,
          price: Decimal.new("9.99"),
          quotation_item_id: qitem.id
        })

      assert item.material_id == ctx.material.id
      assert item.unit_id == ctx.kg.id
      assert Decimal.equal?(item.price, Decimal.new("3.50"))
      # 税率未显式传,取报价条目税率
      assert Decimal.equal?(item.tax_rate, Decimal.new("0.06"))
      assert Decimal.equal?(item.amount, Decimal.new("7.00"))
      # 快照按派生后的物料/单位拍
      assert item.material_code == ctx.material.code
      assert item.unit_name == "千克"

      # 显式传税率(0 也是显式)时不被报价覆盖
      item2 =
        item!(order, %{idx: 2, quotation_item_id: qitem.id, tax_rate: Decimal.new(0)})

      assert Decimal.equal?(item2.tax_rate, Decimal.new(0))
    end

    test "数量梯度按行数量套档,qty 变化重新套档", ctx do
      quotation =
        quotation!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      qitem =
        QuotationItem
        |> Ash.Changeset.for_create(:create, %{
          quotation_id: quotation.id,
          idx: 1,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          pricing_mode: :qty_tiered
        })
        |> Ash.create!(authorize?: false)

      tier!(qitem, %{min_qty: 1, price: Decimal.new("10.00")})
      tier!(qitem, %{min_qty: 10, price: Decimal.new("8.00")})
      audit_quotation!(quotation)

      order =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      item = item!(order, %{qty: 5, price: 1, quotation_item_id: qitem.id})
      assert Decimal.equal?(item.price, Decimal.new("10.00"))

      updated =
        item
        |> Ash.Changeset.for_update(:update, %{qty: 15})
        |> Ash.update!(authorize?: false)

      assert Decimal.equal?(updated.price, Decimal.new("8.00"))
      assert Decimal.equal?(updated.amount, Decimal.new("120.00"))
    end

    test "低于首档起订量报错,无报价", ctx do
      quotation =
        quotation!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      qitem =
        QuotationItem
        |> Ash.Changeset.for_create(:create, %{
          quotation_id: quotation.id,
          idx: 1,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          pricing_mode: :qty_tiered
        })
        |> Ash.create!(authorize?: false)

      tier!(qitem, %{min_qty: 5, price: Decimal.new("10.00")})
      audit_quotation!(quotation)

      order =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      assert {:error, error} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: order.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 2,
                 price: 1,
                 quotation_item_id: qitem.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "低于首档起订量,无报价"
    end

    test "常规行缺失报价条目报错", ctx do
      order =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      assert {:error, error} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: order.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 1,
                 price: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "常规订单条目必须选择报价条目"
    end

    test "报价单未审核或已作废被拒", ctx do
      order =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      # 草稿报价单
      draft =
        quotation!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      draft_qitem = qitem!(draft, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

      assert {:error, error} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: order.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 1,
                 price: 1,
                 quotation_item_id: draft_qitem.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "报价单未审核或已作废"

      # 审核后作废同样被拒
      valid_qitem = audited_fixed_qitem!(ctx)

      audited_draft =
        draft
        |> Ash.Changeset.for_update(:audit, %{})
        |> Ash.update!(authorize?: false)

      audited_draft
      |> Ash.Changeset.for_update(:void, %{})
      |> Ash.update!(authorize?: false)

      assert {:error, error2} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: order.id,
                 idx: 2,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 1,
                 price: 1,
                 quotation_item_id: draft_qitem.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error2) =~ "报价单未审核或已作废"
      # 有效报价可正常建行(对照)
      assert item!(order, %{idx: 3, quotation_item_id: valid_qitem.id})
    end

    test "订单日期不在报价有效期内被拒", ctx do
      qitem = audited_fixed_qitem!(ctx)

      too_late =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          order_date: ~D[2026-08-18]
        })

      assert {:error, error} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: too_late.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 1,
                 price: 1,
                 quotation_item_id: qitem.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "订单日期不在报价有效期内"

      too_early =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          order_date: ~D[2026-07-16]
        })

      assert {:error, error2} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: too_early.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 1,
                 price: 1,
                 quotation_item_id: qitem.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error2) =~ "订单日期不在报价有效期内"
    end

    test "报价与订单公司/对手/币种不一致逐项被拒", ctx do
      order =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      create_item = fn qitem, idx ->
        OrderItem
        |> Ash.Changeset.for_create(:create, %{
          order_id: order.id,
          idx: idx,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          qty: 1,
          price: 1,
          quotation_item_id: qitem.id
        })
        |> Ash.create(authorize?: false)
      end

      # 公司不符:报价开在另一家公司(同一客户)
      other_company_quotation =
        quotation!(%{
          company_id: ctx.other_company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      other_company_qitem =
        qitem!(other_company_quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

      audit_quotation!(other_company_quotation)

      assert {:error, error} = create_item.(other_company_qitem, 1)
      assert Exception.message(error) =~ "报价与订单公司不一致"

      # 对手不符:同一公司另一客户
      customer2 =
        Customer
        |> Ash.Changeset.for_create(:create, %{
          code: "C-#{System.unique_integer([:positive])}",
          name: "另一客户"
        })
        |> Ash.create!(authorize?: false)

      other_party_quotation =
        quotation!(%{company_id: ctx.company.id, party_type: :customer, party_id: customer2.id})

      other_party_qitem =
        qitem!(other_party_quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

      audit_quotation!(other_party_quotation)

      assert {:error, error2} = create_item.(other_party_qitem, 2)
      assert Exception.message(error2) =~ "报价与订单对手不一致"

      # 币种不符:报价用外币(订单默认公司本币)
      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      usd_quotation =
        quotation!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          currency_id: usd.id
        })

      usd_qitem = qitem!(usd_quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
      audit_quotation!(usd_quotation)

      assert {:error, error3} = create_item.(usd_qitem, 3)
      assert Exception.message(error3) =~ "报价与订单币种不一致"
    end
  end

  describe "订单分型:样品行" do
    test "数量超上限报错,改配置后按新值卡", ctx do
      assert {:error, error} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: ctx.order.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 101,
                 price: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "样品条目数量超出上限"

      # 上限内正常
      assert item!(ctx.order, %{qty: 100, material_id: ctx.material.id, unit_id: ctx.kg.id})

      # 配置收紧到 5,按新值卡
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{sample_item_max_qty: 5})
      |> Ash.update!(authorize?: false)

      assert {:error, error2} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: ctx.order.id,
                 idx: 3,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 6,
                 price: 1
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error2) =~ "样品条目数量超出上限"

      assert item!(ctx.order, %{idx: 4, qty: 5, material_id: ctx.material.id, unit_id: ctx.kg.id})
    end

    test "样品行挂报价条目被拒", ctx do
      qitem = audited_fixed_qitem!(ctx)

      assert {:error, error} =
               OrderItem
               |> Ash.Changeset.for_create(:create, %{
                 order_id: ctx.order.id,
                 idx: 1,
                 material_id: ctx.material.id,
                 unit_id: ctx.kg.id,
                 qty: 1,
                 price: 1,
                 quotation_item_id: qitem.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "样品订单条目不可选择报价条目"
    end
  end

  describe "订单分型:头变更闸与类型锁死" do
    test "有条目改客户/日期/币种报错,改备注/条款不拦", ctx do
      item!(ctx.order, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

      customer2 =
        Customer
        |> Ash.Changeset.for_create(:create, %{
          code: "C-#{System.unique_integer([:positive])}",
          name: "另一客户"
        })
        |> Ash.create!(authorize?: false)

      assert {:error, error} =
               ctx.order
               |> Ash.Changeset.for_update(:update, %{party_id: customer2.id})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "请先删除订单条目"

      assert {:error, error2} =
               ctx.order
               |> Ash.Changeset.for_update(:update, %{order_date: ~D[2026-07-18]})
               |> Ash.update(authorize?: false)

      assert Exception.message(error2) =~ "请先删除订单条目"

      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      assert {:error, error3} =
               ctx.order
               |> Ash.Changeset.for_update(:update, %{
                 currency_id: usd.id,
                 exchange_rate: Decimal.new("7.25")
               })
               |> Ash.update(authorize?: false)

      assert Exception.message(error3) =~ "请先删除订单条目"

      # 备注/条款不受拦
      updated =
        ctx.order
        |> Ash.Changeset.for_update(:update, %{remarks: "改备注", terms: "改条款"})
        |> Ash.update!(authorize?: false)

      assert updated.remarks == "改备注"
    end

    test "无条目时改头关键字段不拦", ctx do
      customer2 =
        Customer
        |> Ash.Changeset.for_create(:create, %{
          code: "C-#{System.unique_integer([:positive])}",
          name: "另一客户"
        })
        |> Ash.create!(authorize?: false)

      updated =
        ctx.order
        |> Ash.Changeset.for_update(:update, %{party_id: customer2.id, order_date: ~D[2026-07-18]})
        |> Ash.update!(authorize?: false)

      assert updated.party_id == customer2.id
    end

    test "订单类型建后锁死,update 改型报错", ctx do
      assert {:error, error} =
               ctx.order
               |> Ash.Changeset.for_update(:update, %{order_type: :regular})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "订单类型不可变更"

      # 原值重传不算变更,正常更新
      updated =
        ctx.order
        |> Ash.Changeset.for_update(:update, %{order_type: :sample, remarks: "x"})
        |> Ash.update!(authorize?: false)

      assert updated.order_type == :sample
    end
  end

  describe "订单分型:审核复核" do
    test "常规单有效行审核通过", ctx do
      qitem = audited_fixed_qitem!(ctx)

      order =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      item!(order, %{quotation_item_id: qitem.id})

      audited =
        order
        |> Ash.Changeset.for_update(:audit, %{})
        |> Ash.update!(authorize?: false)

      assert audited.status == :audited
    end

    test "建行后报价单被作废,审核被拒", ctx do
      quotation =
        quotation!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      qitem = qitem!(quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
      audited_quotation = audit_quotation!(quotation)

      order =
        regular_order!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id
        })

      item!(order, %{quotation_item_id: qitem.id})

      # 绕过行校验:建行后作废报价单
      audited_quotation
      |> Ash.Changeset.for_update(:void, %{})
      |> Ash.update!(authorize?: false)

      assert {:error, error} =
               order
               |> Ash.Changeset.for_update(:audit, %{})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "报价单未审核或已作废"
      assert Ash.get!(Order, order.id, authorize?: false).status == :draft
    end

    test "样品配置收紧后,存量行审核被拒", ctx do
      item!(ctx.order, %{qty: 90, material_id: ctx.material.id, unit_id: ctx.kg.id})

      Setting.get()
      |> Ash.Changeset.for_update(:update, %{sample_item_max_qty: 50})
      |> Ash.update!(authorize?: false)

      assert {:error, error} =
               ctx.order
               |> Ash.Changeset.for_update(:audit, %{})
               |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "样品条目数量超出上限"
      assert Ash.get!(Order, ctx.order.id, authorize?: false).status == :draft
    end
  end
end
