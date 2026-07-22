defmodule SynieCore.Sales.DeliveryTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.GlEntry
  alias SynieCore.Base.{Account, Unit}
  alias SynieCore.Files.Attachment
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Inv.{Material, MaterialCategory, StockDoc, StockDocItem, StockEntry, Warehouse}
  alias SynieCore.Sales.{Customer, Delivery, DeliveryItem, Order, OrderItem, Setting}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()

    customer =
      Customer
      |> Ash.Changeset.for_create(:create, %{
        code: "C-#{System.unique_integer([:positive])}",
        name: "测试客户"
      })
      |> Ash.create!(authorize?: false)

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-dl#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "D#{System.unique_integer([:positive])}",
        name: "原材料"
      })
      |> Ash.create!(authorize?: false)

    material =
      Ash.Seed.seed!(Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "铜杆",
        category_id: leaf.id,
        default_unit_id: kg.id
      })

    warehouse =
      Warehouse
      |> Ash.Changeset.for_create(:create, %{name: "发货仓", company_id: company.id})
      |> Ash.create!(authorize?: false)

    # 铺底库存
    stock_in!(warehouse, material, kg, Decimal.new(100))

    debit = account!(company, "1122U", "未开票应收", :unbilled_receivable)
    credit = account!(company, "6001", "主营业务收入", nil)
    Process.put(:test_delivery_debit_id, debit.id)
    Process.put(:test_delivery_credit_id, credit.id)

    order =
      Order
      |> Ash.Changeset.for_create(:create, %{
        order_no: "SO-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-17],
        order_type: :sample,
        company_id: company.id,
        party_type: :customer,
        party_id: customer.id
      })
      |> Ash.create!(authorize?: false)

    order_item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: material.id,
        unit_id: kg.id,
        qty: Decimal.new(10),
        price: Decimal.new("100.00"),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    %{
      company: company,
      customer: customer,
      kg: kg,
      material: material,
      warehouse: warehouse,
      debit: debit,
      credit: credit,
      order: order,
      order_item: order_item
    }
  end

  defp account!(company, code, name, role) do
    Account
    |> Ash.Changeset.for_create(:create, %{
      code: "#{code}-#{System.unique_integer([:positive])}",
      name: name,
      direction: :debit,
      company_id: company.id,
      role: role
    })
    |> Ash.create!(authorize?: false)
  end

  defp stock_in!(warehouse, material, unit, qty) do
    doc =
      StockDoc
      |> Ash.Changeset.for_create(:create, %{
        doc_no: "CRK-#{System.unique_integer([:positive])}",
        company_id: warehouse.company_id,
        warehouse_id: warehouse.id,
        direction: :in,
        doc_date: ~D[2026-07-19]
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

  defp delivery!(attrs) do
    # 草稿科目必填:默认带 setup 里的借贷科;显式传入可覆盖
    attrs =
      Map.merge(
        %{
          delivery_no: "DN-#{System.unique_integer([:positive])}",
          delivery_date: ~D[2026-07-20],
          debit_account_id: Process.get(:test_delivery_debit_id),
          credit_account_id: Process.get(:test_delivery_credit_id)
        },
        attrs
      )

    Delivery |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp line!(delivery, attrs) do
    DeliveryItem
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{idx: 1, qty: Decimal.new(3)}, attrs) |> Map.put(:delivery_id, delivery.id)
    )
    |> Ash.create!(authorize?: false)
  end

  test "审核写出库分录、总账、累加已发;作废回滚", ctx do
    %{
      company: co,
      customer: cu,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit,
      order_item: oi
    } = ctx

    d =
      delivery!(%{
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id,
        remarks: "测试发货"
      })

    line!(d, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(4)
    })

    d = d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert d.status == :audited
    assert d.posting_date == ~D[2026-07-20]

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.shipped_qty, Decimal.new(4))

    stock =
      StockEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    assert length(stock) == 1
    assert Decimal.equal?(hd(stock).quantity, Decimal.new(-4))
    assert hd(stock).is_cancelled == false

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    # 本币金额 4/10 * 1000 = 400
    assert length(gl) == 2
    debit_row = Enum.find(gl, &(Decimal.compare(&1.debit, 0) == :gt))
    credit_row = Enum.find(gl, &(Decimal.compare(&1.credit, 0) == :gt))
    assert Decimal.equal?(debit_row.debit, Decimal.new("400.00"))
    assert Decimal.equal?(credit_row.credit, Decimal.new("400.00"))
    assert debit_row.party_id == cu.id
    assert is_nil(credit_row.party_id)

    d = d |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
    assert d.status == :voided

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.shipped_qty, Decimal.new(0))

    stock = Ash.reload!(hd(stock), authorize?: false)
    assert stock.is_cancelled == true

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    assert Enum.all?(gl, & &1.is_cancelled)
  end

  test "超发默认 0% 审核拒绝;配置比例后放行", ctx do
    %{
      company: co,
      customer: cu,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit,
      order_item: oi
    } = ctx

    d =
      delivery!(%{
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })

    line!(d, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(11)
    })

    assert {:error, _} =
             d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

    setting = Setting.get()

    setting
    |> Ash.Changeset.for_update(:update, %{delivery_overship_ratio: Decimal.new("0.2")})
    |> Ash.update!(authorize?: false)

    d = d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert d.status == :audited

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.shipped_qty, Decimal.new(11))
  end

  test "草稿保存科目必填", ctx do
    %{company: co, customer: cu} = ctx

    assert {:error, _} =
             Delivery
             |> Ash.Changeset.for_create(:create, %{
               delivery_no: "DN-#{System.unique_integer([:positive])}",
               delivery_date: ~D[2026-07-20],
               company_id: co.id,
               party_type: :customer,
               party_id: cu.id
             })
             |> Ash.create(authorize?: false)
  end

  test "零单价订单发货跳过总账,但科目仍必填", ctx do
    %{
      company: co,
      customer: cu,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit
    } =
      ctx

    order =
      Order
      |> Ash.Changeset.for_create(:create, %{
        order_no: "SO-free-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-17],
        order_type: :sample,
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id
      })
      |> Ash.create!(authorize?: false)

    oi =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: mat.id,
        unit_id: kg.id,
        qty: Decimal.new(2),
        price: Decimal.new(0),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    d =
      delivery!(%{
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })

    line!(d, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(2)
    })

    d = d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert d.status == :audited

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    assert gl == []

    stock =
      StockEntry
      |> Ash.Query.filter(voucher_type == "sales.delivery" and voucher_id == ^d.id)
      |> Ash.read!(authorize?: false)

    assert length(stock) == 1
  end

  test "有已审核发货时订单不可作废", ctx do
    %{
      company: co,
      customer: cu,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit,
      order: order,
      order_item: oi
    } = ctx

    d =
      delivery!(%{
        company_id: co.id,
        party_type: :customer,
        party_id: cu.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })

    line!(d, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(1)
    })

    d |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    assert {:error, _} =
             order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)
  end

  test "借方科目非未开票应收角色时保存报错", ctx do
    %{company: co, customer: cu, credit: credit} = ctx
    bad = account!(co, "1122", "应收账款", :receivable)

    assert {:error, _} =
             Delivery
             |> Ash.Changeset.for_create(:create, %{
               delivery_no: "DN-bad-#{System.unique_integer([:positive])}",
               company_id: co.id,
               party_type: :customer,
               party_id: cu.id,
               debit_account_id: bad.id,
               credit_account_id: credit.id
             })
             |> Ash.create(authorize?: false)
  end

  # 给物料 drawing 槽位挂一张图纸,返回 sys_file
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
      owner_type == "sal_delivery_item" and owner_id == ^item_id and category == "drawing"
    )
    |> Ash.read!(authorize?: false)
  end

  defp drawing_file_ids(item_id),
    do: item_drawings(item_id) |> Enum.map(& &1.file_id) |> Enum.sort()

  describe "图纸挂接复制" do
    test "创建行把物料 drawing 挂接复制到行(其他槽位不复制)", ctx do
      f1 = drawing!(ctx.material, "a.pdf")
      f2 = drawing!(ctx.material, "b.pdf")

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

      d =
        delivery!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })

      item =
        line!(d, %{
          order_item_id: ctx.order_item.id,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          warehouse_id: ctx.warehouse.id
        })

      atts = item_drawings(item.id)
      assert Enum.map(atts, & &1.file_id) |> Enum.sort() == Enum.sort([f1.id, f2.id])
      assert Enum.all?(atts, &(&1.category == "drawing" and &1.company_id == ctx.company.id))
    end

    test "重存行整删整建跟随物料图纸增删", ctx do
      f1 = drawing!(ctx.material, "a.pdf")
      f2 = drawing!(ctx.material, "b.pdf")

      d =
        delivery!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })

      item =
        line!(d, %{
          order_item_id: ctx.order_item.id,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          warehouse_id: ctx.warehouse.id
        })

      assert drawing_file_ids(item.id) == Enum.sort([f1.id, f2.id])

      Attachment
      |> Ash.Query.filter(
        owner_type == "inv_material" and owner_id == ^ctx.material.id and file_id == ^f1.id
      )
      |> Ash.read_one!(authorize?: false)
      |> Ash.destroy!(authorize?: false)

      f3 = drawing!(ctx.material, "c.pdf")

      item
      |> Ash.Changeset.for_update(:update, %{qty: 2})
      |> Ash.update!(authorize?: false)

      assert drawing_file_ids(item.id) == Enum.sort([f2.id, f3.id])
    end

    test "删除行清理其图纸挂接(物料挂接不动)", ctx do
      f = drawing!(ctx.material)

      d =
        delivery!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })

      item =
        line!(d, %{
          order_item_id: ctx.order_item.id,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          warehouse_id: ctx.warehouse.id
        })

      assert drawing_file_ids(item.id) == [f.id]

      :ok = item |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert item_drawings(item.id) == []

      material_atts =
        Attachment
        |> Ash.Query.filter(owner_type == "inv_material" and owner_id == ^ctx.material.id)
        |> Ash.read!(authorize?: false)

      assert Enum.map(material_atts, & &1.file_id) == [f.id]
    end

    test "删除草稿发货单(DB 级联删行)也清理行的图纸挂接", ctx do
      f = drawing!(ctx.material)

      d =
        delivery!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })

      item =
        line!(d, %{
          order_item_id: ctx.order_item.id,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          warehouse_id: ctx.warehouse.id
        })

      assert drawing_file_ids(item.id) == [f.id]

      :ok = d |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert {:error, _} = Ash.get(DeliveryItem, item.id, authorize?: false)
      assert item_drawings(item.id) == []
    end

    test "文件被行挂接时拒删;物料解除挂接后仍拒删(行还挂着)", ctx do
      f = drawing!(ctx.material)

      d =
        delivery!(%{
          company_id: ctx.company.id,
          party_type: :customer,
          party_id: ctx.customer.id,
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })

      item =
        line!(d, %{
          order_item_id: ctx.order_item.id,
          material_id: ctx.material.id,
          unit_id: ctx.kg.id,
          warehouse_id: ctx.warehouse.id
        })

      assert drawing_file_ids(item.id) == [f.id]

      assert {:error, err} = Ash.destroy(f, authorize?: false)
      assert Exception.message(err) =~ "仍有业务挂接"

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
