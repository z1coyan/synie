defmodule SynieCore.Purchase.ReceiptTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Acc.GlEntry
  alias SynieCore.Authz
  alias SynieCore.Base.{Account, Unit}
  alias SynieCore.Files.Attachment
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Inv.{Material, MaterialCategory, StockDoc, StockDocItem, StockEntry, Warehouse}

  alias SynieCore.Purchase.{
    Order,
    OrderItem,
    Receipt,
    ReceiptItem,
    Reconciliation,
    ReconciliationItem,
    Supplier
  }

  alias SynieCore.Sales.Setting

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    supplier = supplier!()

    kg =
      Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :weight,
        name: "千克",
        symbol: "kg-rc#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    leaf =
      MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "R#{System.unique_integer([:positive])}",
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
      |> Ash.Changeset.for_create(:create, %{name: "收货仓", company_id: company.id})
      |> Ash.create!(authorize?: false)

    debit = account!(company, "1405", "库存商品", nil)
    credit = account!(company, "2202U", "未开票应付", :unbilled_payable)
    Process.put(:test_receipt_debit_id, debit.id)
    Process.put(:test_receipt_credit_id, credit.id)

    {order, order_item} = audited_order!(company, supplier, material, kg)

    %{
      company: company,
      supplier: supplier,
      kg: kg,
      material: material,
      warehouse: warehouse,
      debit: debit,
      credit: credit,
      order: order,
      order_item: order_item
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

  defp account!(company, code, name, role) do
    Account
    |> Ash.Changeset.for_create(:create, %{
      code: "#{code}-#{System.unique_integer([:positive])}",
      name: name,
      direction: :credit,
      company_id: company.id,
      role: role
    })
    |> Ash.create!(authorize?: false)
  end

  # 零星单自由录价,数量 10、含税单价 100(本币单,双套同值)
  defp audited_order!(company, supplier, material, unit, attrs \\ %{}) do
    order =
      Order
      |> Ash.Changeset.for_create(
        :create,
        Map.merge(
          %{
            order_no: "PO-#{System.unique_integer([:positive])}",
            order_date: ~D[2026-07-17],
            order_type: :spot,
            company_id: company.id,
            party_type: :supplier,
            party_id: supplier.id
          },
          attrs
        )
      )
      |> Ash.create!(authorize?: false)

    order_item =
      OrderItem
      |> Ash.Changeset.for_create(:create, %{
        order_id: order.id,
        idx: 1,
        material_id: material.id,
        unit_id: unit.id,
        qty: Decimal.new(10),
        price: Decimal.new("100.00"),
        tax_rate: Decimal.new("0.13")
      })
      |> Ash.create!(authorize?: false)

    order = order |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    {order, order_item}
  end

  defp receipt!(attrs) do
    # 草稿科目必填:默认带 setup 里的借贷科;显式传入可覆盖
    attrs =
      Map.merge(
        %{
          receipt_no: "RN-#{System.unique_integer([:positive])}",
          receipt_date: ~D[2026-07-20],
          debit_account_id: Process.get(:test_receipt_debit_id),
          credit_account_id: Process.get(:test_receipt_credit_id)
        },
        attrs
      )

    Receipt |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp line!(receipt, attrs) do
    ReceiptItem
    |> Ash.Changeset.for_create(
      :create,
      Map.merge(%{idx: 1, qty: Decimal.new(3)}, attrs) |> Map.put(:receipt_id, receipt.id)
    )
    |> Ash.create!(authorize?: false)
  end

  defp stock_out!(warehouse, material, unit, qty) do
    doc =
      StockDoc
      |> Ash.Changeset.for_create(:create, %{
        doc_no: "CK-#{System.unique_integer([:positive])}",
        company_id: warehouse.company_id,
        warehouse_id: warehouse.id,
        direction: :out,
        doc_date: ~D[2026-07-21]
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

  test "审核写入库分录、总账两行、累加已收;作废回滚", ctx do
    %{
      company: co,
      supplier: su,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit,
      order_item: oi
    } = ctx

    r =
      receipt!(%{
        company_id: co.id,
        party_type: :supplier,
        party_id: su.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id,
        remarks: "测试入库"
      })

    line!(r, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(4)
    })

    r = r |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert r.status == :audited
    assert r.posting_date == ~D[2026-07-20]

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.received_qty, Decimal.new(4))

    stock =
      StockEntry
      |> Ash.Query.filter(voucher_type == "purchase.receipt" and voucher_id == ^r.id)
      |> Ash.read!(authorize?: false)

    assert length(stock) == 1
    assert Decimal.equal?(hd(stock).quantity, Decimal.new(4))
    assert hd(stock).is_cancelled == false

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "purchase.receipt" and voucher_id == ^r.id)
      |> Ash.read!(authorize?: false)

    # 本币金额 4/10 * 1000 = 400;贷方(未开票应付)带对手,借方不带
    assert length(gl) == 2
    debit_row = Enum.find(gl, &(Decimal.compare(&1.debit, 0) == :gt))
    credit_row = Enum.find(gl, &(Decimal.compare(&1.credit, 0) == :gt))
    assert Decimal.equal?(debit_row.debit, Decimal.new("400.00"))
    assert Decimal.equal?(credit_row.credit, Decimal.new("400.00"))
    assert credit_row.account_id == credit.id
    assert credit_row.party_id == su.id
    assert credit_row.party_type == :supplier
    assert is_nil(debit_row.party_id)

    r = r |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
    assert r.status == :voided

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.received_qty, Decimal.new(0))

    stock = Ash.reload!(hd(stock), authorize?: false)
    assert stock.is_cancelled == true

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "purchase.receipt" and voucher_id == ^r.id)
      |> Ash.read!(authorize?: false)

    assert Enum.all?(gl, & &1.is_cancelled)
  end

  test "超收默认 0% 审核拒绝;配置比例后放行", ctx do
    %{
      company: co,
      supplier: su,
      warehouse: wh,
      material: mat,
      kg: kg,
      debit: debit,
      credit: credit,
      order_item: oi
    } = ctx

    r =
      receipt!(%{
        company_id: co.id,
        party_type: :supplier,
        party_id: su.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })

    line!(r, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(11)
    })

    assert {:error, error} =
             r |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "超出入库容差"

    Setting.get()
    |> Ash.Changeset.for_update(:update, %{receipt_overreceive_ratio: Decimal.new("0.2")})
    |> Ash.update!(authorize?: false)

    r = r |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert r.status == :audited

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.received_qty, Decimal.new(11))
  end

  test "分批入库累计已收按订购 base 卡超收", ctx do
    %{company: co, supplier: su, warehouse: wh, material: mat, kg: kg, order_item: oi} = ctx

    r1 =
      receipt!(%{
        company_id: co.id,
        party_type: :supplier,
        party_id: su.id,
        debit_account_id: ctx.debit.id,
        credit_account_id: ctx.credit.id
      })

    line!(r1, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(6)
    })

    r1 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    # 第二批 5,累计 11 > 10 拒(超收校验先于总账科目校验)
    r2 =
      receipt!(%{company_id: co.id, party_type: :supplier, party_id: su.id})

    line!(r2, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(5)
    })

    assert {:error, error} =
             r2 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "超出入库容差"

    # 同一订单条目一单多行(分仓)允许
    wh2 =
      Warehouse
      |> Ash.Changeset.for_create(:create, %{name: "收货仓二", company_id: co.id})
      |> Ash.create!(authorize?: false)

    r3 =
      receipt!(%{
        company_id: co.id,
        party_type: :supplier,
        party_id: su.id,
        debit_account_id: ctx.debit.id,
        credit_account_id: ctx.credit.id
      })

    line!(r3, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(2)
    })

    line!(r3, %{
      idx: 2,
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh2.id,
      qty: Decimal.new(2)
    })

    r3 = r3 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert r3.status == :audited

    oi = Ash.get!(OrderItem, oi.id, authorize?: false)
    assert Decimal.equal?(oi.received_qty, Decimal.new(10))

    stock =
      StockEntry
      |> Ash.Query.filter(voucher_type == "purchase.receipt" and voucher_id == ^r3.id)
      |> Ash.read!(authorize?: false)

    assert length(stock) == 2
  end

  test "草稿保存科目必填", ctx do
    %{company: co, supplier: su} = ctx

    assert {:error, _} =
             Receipt
             |> Ash.Changeset.for_create(:create, %{
               receipt_no: "RN-#{System.unique_integer([:positive])}",
               receipt_date: ~D[2026-07-20],
               company_id: co.id,
               party_type: :supplier,
               party_id: su.id
             })
             |> Ash.create(authorize?: false)
  end

  test "零单价订单入库跳过总账,但科目仍必填", ctx do
    %{
      company: co,
      supplier: su,
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
        order_no: "PO-free-#{System.unique_integer([:positive])}",
        order_date: ~D[2026-07-17],
        order_type: :spot,
        company_id: co.id,
        party_type: :supplier,
        party_id: su.id
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

    r =
      receipt!(%{
        company_id: co.id,
        party_type: :supplier,
        party_id: su.id,
        debit_account_id: debit.id,
        credit_account_id: credit.id
      })

    line!(r, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(2)
    })

    r = r |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)
    assert r.status == :audited

    gl =
      GlEntry
      |> Ash.Query.filter(voucher_type == "purchase.receipt" and voucher_id == ^r.id)
      |> Ash.read!(authorize?: false)

    assert gl == []

    stock =
      StockEntry
      |> Ash.Query.filter(voucher_type == "purchase.receipt" and voucher_id == ^r.id)
      |> Ash.read!(authorize?: false)

    assert length(stock) == 1
  end

  test "作废回滚仍过负库存校验:库存已耗用后作废被拒", ctx do
    %{company: co, supplier: su, warehouse: wh, material: mat, kg: kg, order_item: oi} = ctx

    r =
      receipt!(%{
        company_id: co.id,
        party_type: :supplier,
        party_id: su.id,
        debit_account_id: ctx.debit.id,
        credit_account_id: ctx.credit.id
      })

    line!(r, %{
      order_item_id: oi.id,
      material_id: mat.id,
      unit_id: kg.id,
      warehouse_id: wh.id,
      qty: Decimal.new(4)
    })

    r = r |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

    # 库存被后续出库耗用到 0,作废入库会变成 -4
    stock_out!(wh, mat, kg, Decimal.new(4))

    assert {:error, error} =
             r |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "库存不足"
    assert Ash.get!(Receipt, r.id, authorize?: false).status == :audited
  end

  test "贷方科目非未开票应付角色时保存报错", ctx do
    %{company: co, supplier: su, debit: debit} = ctx
    bad = account!(co, "2202", "应付账款", :payable)

    assert {:error, error} =
             Receipt
             |> Ash.Changeset.for_create(:create, %{
               receipt_no: "RN-bad-#{System.unique_integer([:positive])}",
               company_id: co.id,
               party_type: :supplier,
               party_id: su.id,
               debit_account_id: debit.id,
               credit_account_id: bad.id
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "贷方科目必须为未开票应付角色"
  end

  describe "行录入校验" do
    test "订单未审核建行被拒", ctx do
      %{company: co, supplier: su, warehouse: wh, material: mat, kg: kg} = ctx

      draft_order =
        Order
        |> Ash.Changeset.for_create(:create, %{
          order_no: "PO-draft-#{System.unique_integer([:positive])}",
          order_date: ~D[2026-07-17],
          order_type: :spot,
          company_id: co.id,
          party_type: :supplier,
          party_id: su.id
        })
        |> Ash.create!(authorize?: false)

      draft_oi =
        OrderItem
        |> Ash.Changeset.for_create(:create, %{
          order_id: draft_order.id,
          idx: 1,
          material_id: mat.id,
          unit_id: kg.id,
          qty: Decimal.new(1),
          price: Decimal.new(1)
        })
        |> Ash.create!(authorize?: false)

      r = receipt!(%{company_id: co.id, party_type: :supplier, party_id: su.id})

      assert {:error, error} =
               ReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: r.id,
                 idx: 1,
                 order_item_id: draft_oi.id,
                 qty: 1,
                 warehouse_id: wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "仅已审核订单可入库"
    end

    test "关闭订单后不可再入库", ctx do
      %{
        company: co,
        supplier: su,
        warehouse: wh,
        material: mat,
        kg: kg,
        order: order,
        order_item: oi
      } =
        ctx

      order |> Ash.Changeset.for_update(:close, %{}) |> Ash.update!(authorize?: false)

      r = receipt!(%{company_id: co.id, party_type: :supplier, party_id: su.id})

      assert {:error, error} =
               ReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: r.id,
                 idx: 1,
                 order_item_id: oi.id,
                 material_id: mat.id,
                 unit_id: kg.id,
                 qty: 1,
                 warehouse_id: wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "订单已关闭,不可入库"
    end

    test "对手/公司不一致被拒,同单原币不一致被拒", ctx do
      %{company: co, supplier: su, warehouse: wh, material: mat, kg: kg, order_item: oi} = ctx

      # 对手不符:入库单开给另一供应商,行挂本供应商订单条目
      supplier2 = supplier!()

      r = receipt!(%{company_id: co.id, party_type: :supplier, party_id: supplier2.id})

      assert {:error, error} =
               ReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: r.id,
                 idx: 1,
                 order_item_id: oi.id,
                 qty: 1,
                 warehouse_id: wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error) =~ "订单对手与入库单不一致"

      # 同单原币不一致:第一行本币订单,第二行外币订单
      usd = foreign_currency!(%{name: "美元", iso_code: "USD"})

      {_order2, oi2} =
        audited_order!(co, su, mat, kg, %{currency_id: usd.id, exchange_rate: Decimal.new("7.25")})

      r2 = receipt!(%{company_id: co.id, party_type: :supplier, party_id: su.id})

      line!(r2, %{order_item_id: oi.id, qty: 1, warehouse_id: wh.id})

      assert {:error, error2} =
               ReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: r2.id,
                 idx: 2,
                 order_item_id: oi2.id,
                 qty: 1,
                 warehouse_id: wh.id
               })
               |> Ash.create(authorize?: false)

      assert Exception.message(error2) =~ "同一入库单内订单原币必须一致"
    end

    test "单位缺省取订单行单位;行仓必填且限本公司叶子仓", ctx do
      %{company: co, supplier: su, warehouse: wh, order_item: oi} = ctx

      r = receipt!(%{company_id: co.id, party_type: :supplier, party_id: su.id})

      # 不传单位/物料:由订单条目回填
      line = line!(r, %{order_item_id: oi.id, qty: 1, warehouse_id: wh.id})
      assert line.unit_id == oi.unit_id
      assert line.material_id == oi.material_id

      # 行仓缺失被拒
      assert {:error, _} =
               ReceiptItem
               |> Ash.Changeset.for_create(:create, %{
                 receipt_id: r.id,
                 idx: 2,
                 order_item_id: oi.id,
                 qty: 1
               })
               |> Ash.create(authorize?: false)
    end

    test "行保存冻结订单条目快照与物料快照", ctx do
      %{company: co, supplier: su, warehouse: wh, kg: kg, order: order, order_item: oi} = ctx

      r = receipt!(%{company_id: co.id, party_type: :supplier, party_id: su.id})

      line = line!(r, %{order_item_id: oi.id, qty: 4, warehouse_id: wh.id})

      assert line.order_no == order.order_no
      assert Decimal.equal?(line.order_qty, Decimal.new(10))
      assert Decimal.equal?(line.order_base_qty, Decimal.new(10))
      assert Decimal.equal?(line.order_price, Decimal.new("100.00"))
      assert Decimal.equal?(line.order_amount, Decimal.new("1000.00"))
      assert Decimal.equal?(line.order_base_amount, Decimal.new("1000.00"))
      assert Decimal.equal?(line.order_tax_rate, Decimal.new("0.13"))
      assert line.order_currency_code == "CNY"
      assert line.order_unit_name == "千克"
      assert line.material_code == ctx.material.code
      assert line.material_name == "铜杆"
      assert line.unit_name == "千克"
      assert Decimal.equal?(line.base_qty, Decimal.new(4))
      assert line.company_id == co.id
      _ = kg
    end
  end

  describe "对账作废拦截" do
    test "存在非零已对账数量的入库单不可作废;撤回对账后可作废", ctx do
      %{company: co, supplier: su, warehouse: wh, material: mat, kg: kg, order_item: oi} = ctx

      r =
        receipt!(%{
          company_id: co.id,
          party_type: :supplier,
          party_id: su.id,
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })

      item =
        line!(r, %{
          order_item_id: oi.id,
          material_id: mat.id,
          unit_id: kg.id,
          warehouse_id: wh.id,
          qty: Decimal.new(4)
        })

      r = r |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      recon =
        Reconciliation
        |> Ash.Changeset.for_create(:create, %{
          reconciliation_no: "PR-#{System.unique_integer([:positive])}",
          reconciliation_type: :regular,
          company_id: co.id,
          party_type: :supplier,
          party_id: su.id,
          debit_account_id: ctx.credit.id,
          credit_account_id: ctx.debit.id
        })
        |> Ash.create!(authorize?: false)

      ReconciliationItem
      |> Ash.Changeset.for_create(:create, %{
        reconciliation_id: recon.id,
        idx: 1,
        receipt_item_id: item.id,
        qty: Decimal.new(1)
      })
      |> Ash.create!(authorize?: false)

      recon = recon |> Ash.Changeset.for_update(:confirm, %{}) |> Ash.update!(authorize?: false)

      assert Decimal.equal?(
               Ash.get!(ReceiptItem, item.id, authorize?: false).reconciled_qty,
               Decimal.new(1)
             )

      assert {:error, error} =
               r |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "已对账"
      assert Ash.get!(Receipt, r.id, authorize?: false).status == :audited

      recon |> Ash.Changeset.for_update(:unconfirm, %{}) |> Ash.update!(authorize?: false)

      voided = r |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)
      assert voided.status == :voided
    end
  end

  describe "与订单交叉" do
    test "有已审核入库时订单不可作废,先作废入库后可作废", ctx do
      %{
        company: co,
        supplier: su,
        warehouse: wh,
        material: mat,
        kg: kg,
        order: order,
        order_item: oi
      } =
        ctx

      r =
        receipt!(%{
          company_id: co.id,
          party_type: :supplier,
          party_id: su.id,
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })

      line!(r, %{
        order_item_id: oi.id,
        material_id: mat.id,
        unit_id: kg.id,
        warehouse_id: wh.id,
        qty: Decimal.new(1)
      })

      r = r |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      assert {:error, error} =
               order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "订单存在已审核入库,请先作废相关采购入库单"

      r |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      voided =
        order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      assert voided.status == :voided
    end

    test "有草稿入库时订单不可作废,须先删草稿入库", ctx do
      %{
        company: co,
        supplier: su,
        warehouse: wh,
        material: mat,
        kg: kg,
        order: order,
        order_item: oi
      } =
        ctx

      r =
        receipt!(%{company_id: co.id, party_type: :supplier, party_id: su.id})

      line!(r, %{
        order_item_id: oi.id,
        material_id: mat.id,
        unit_id: kg.id,
        warehouse_id: wh.id,
        qty: Decimal.new(1)
      })

      assert {:error, error} =
               order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

      assert Exception.message(error) =~ "请先删除引用本订单的草稿采购入库单"

      :ok = r |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      voided =
        order |> Ash.Changeset.for_update(:void, %{}) |> Ash.update!(authorize?: false)

      assert voided.status == :voided
    end
  end

  describe "权限" do
    test "无 purchase.receipt 权限者创建被拒绝", ctx do
      %{company: co, supplier: su} = ctx

      user = user!()
      role = role!()
      assign!(user, role)
      grant_company!(user, co)
      actor = Authz.build_actor(user)

      assert_raise Ash.Error.Forbidden, fn ->
        Receipt
        |> Ash.Changeset.for_create(:create, %{
          company_id: co.id,
          party_type: :supplier,
          party_id: su.id,
          receipt_no: "RN-N1",
          receipt_date: ~D[2026-07-20],
          debit_account_id: ctx.debit.id,
          credit_account_id: ctx.credit.id
        })
        |> Ash.create!(actor: actor)
      end
    end
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
      owner_type == "pur_receipt_item" and owner_id == ^item_id and category == "drawing"
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

      r =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        line!(r, %{
          order_item_id: ctx.order_item.id,
          warehouse_id: ctx.warehouse.id
        })

      atts = item_drawings(item.id)
      assert Enum.map(atts, & &1.file_id) |> Enum.sort() == Enum.sort([f1.id, f2.id])
      assert Enum.all?(atts, &(&1.category == "drawing" and &1.company_id == ctx.company.id))
    end

    test "重存行整删整建跟随物料图纸增删", ctx do
      f1 = drawing!(ctx.material, "a.pdf")
      f2 = drawing!(ctx.material, "b.pdf")

      r =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        line!(r, %{
          order_item_id: ctx.order_item.id,
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

      r =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        line!(r, %{
          order_item_id: ctx.order_item.id,
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

    test "删除草稿入库单(DB 级联删行)也清理行的图纸挂接", ctx do
      f = drawing!(ctx.material)

      r =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        line!(r, %{
          order_item_id: ctx.order_item.id,
          warehouse_id: ctx.warehouse.id
        })

      assert drawing_file_ids(item.id) == [f.id]

      :ok = r |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

      assert {:error, _} = Ash.get(ReceiptItem, item.id, authorize?: false)
      assert item_drawings(item.id) == []
    end

    test "文件被行挂接时拒删;物料解除挂接后仍拒删(行还挂着)", ctx do
      f = drawing!(ctx.material)

      r =
        receipt!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

      item =
        line!(r, %{
          order_item_id: ctx.order_item.id,
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
