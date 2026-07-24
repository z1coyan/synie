defmodule SynieCore.Purchase.QuotationTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz
  alias SynieCore.Base.Unit
  alias SynieCore.Inv.{Material, MaterialCategory, MaterialUnit}
  alias SynieCore.Purchase.{Quotation, QuotationItem, QuotationTier, Supplier}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    company = company!()
    other_company = company!()

    supplier = supplier!()

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

    quotation =
      quotation!(%{company_id: company.id, party_type: :supplier, party_id: supplier.id})

    %{
      company: company,
      other_company: other_company,
      supplier: supplier,
      kg: kg,
      box: box,
      pcs: pcs,
      leaf: leaf,
      material: material,
      quotation: quotation
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

  defp quotation!(attrs) do
    attrs =
      Map.merge(
        %{
          quotation_no: "PQ-#{System.unique_integer([:positive])}",
          quotation_date: ~D[2026-07-17],
          valid_until: ~D[2026-08-17]
        },
        attrs
      )

    Quotation |> Ash.Changeset.for_create(:create, attrs) |> Ash.create!(authorize?: false)
  end

  defp item!(quotation, attrs) do
    attrs = Map.merge(%{idx: 1, price: Decimal.new("3.50")}, attrs)

    QuotationItem
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{quotation_id: quotation.id}))
    |> Ash.create!(authorize?: false)
  end

  defp tiered_item!(quotation, attrs) do
    attrs = Map.merge(%{idx: 1, pricing_mode: :qty_tiered}, attrs) |> Map.delete(:price)

    QuotationItem
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{quotation_id: quotation.id}))
    |> Ash.create!(authorize?: false)
  end

  defp tier!(item, attrs) do
    QuotationTier
    |> Ash.Changeset.for_create(:create, Map.merge(attrs, %{item_id: item.id}))
    |> Ash.create!(authorize?: false)
  end

  test "创建默认草稿态,报价日期缺省今天,币种默认公司本币", ctx do
    assert ctx.quotation.status == :draft
    assert ctx.quotation.currency_id == ctx.company.base_currency_id

    quotation =
      Quotation
      |> Ash.Changeset.for_create(:create, %{
        company_id: ctx.company.id,
        party_type: :supplier,
        party_id: ctx.supplier.id,
        quotation_no: "PQ-#{System.unique_integer([:positive])}",
        valid_until: Date.add(Date.utc_today(), 30)
      })
      |> Ash.create!(authorize?: false)

    assert quotation.quotation_date == Date.utc_today()
  end

  test "报价单号全局唯一", ctx do
    assert_raise Ash.Error.Invalid, ~r/报价单号已存在/, fn ->
      quotation!(%{
        company_id: ctx.other_company.id,
        party_type: :supplier,
        party_id: ctx.supplier.id,
        quotation_no: ctx.quotation.quotation_no
      })
    end
  end

  test "报价截止不得早于报价日期;同日允许", ctx do
    assert_raise Ash.Error.Invalid, ~r/报价截止不得早于报价日期/, fn ->
      quotation!(%{
        company_id: ctx.company.id,
        party_type: :supplier,
        party_id: ctx.supplier.id,
        quotation_date: ~D[2026-07-17],
        valid_until: ~D[2026-07-16]
      })
    end

    same_day =
      quotation!(%{
        company_id: ctx.company.id,
        party_type: :supplier,
        party_id: ctx.supplier.id,
        quotation_date: ~D[2026-07-17],
        valid_until: ~D[2026-07-17]
      })

    assert same_day.valid_until == ~D[2026-07-17]
  end

  test "对手类型限供应商/内部公司,客户被拒", ctx do
    customer =
      SynieCore.Sales.Customer
      |> Ash.Changeset.for_create(:create, %{
        code: "C-#{System.unique_integer([:positive])}",
        name: "客户"
      })
      |> Ash.create!(authorize?: false)

    assert {:error, error} =
             Quotation
             |> Ash.Changeset.for_create(:create, %{
               company_id: ctx.company.id,
               quotation_no: "PQ-X1",
               valid_until: ~D[2026-08-17],
               party_type: :customer,
               party_id: customer.id
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "对手类型只能为供应商或内部公司"
  end

  test "内部公司作对手时不能是本公司,另一家公司可以", ctx do
    assert {:error, error} =
             Quotation
             |> Ash.Changeset.for_create(:create, %{
               company_id: ctx.company.id,
               quotation_no: "PQ-X2",
               valid_until: ~D[2026-08-17],
               party_type: :company,
               party_id: ctx.company.id
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "对手不能是本公司"

    quotation =
      quotation!(%{
        company_id: ctx.company.id,
        party_type: :company,
        party_id: ctx.other_company.id
      })

    assert quotation.party_type == :company
  end

  test "固定价条目必须填含税单价", ctx do
    assert {:error, error} =
             QuotationItem
             |> Ash.Changeset.for_create(:create, %{
               quotation_id: ctx.quotation.id,
               idx: 1,
               material_id: ctx.material.id,
               unit_id: ctx.kg.id
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "固定价条目必须填写含税单价"
  end

  test "梯度条目单价强制空置(传了也被清)", ctx do
    item =
      QuotationItem
      |> Ash.Changeset.for_create(:create, %{
        quotation_id: ctx.quotation.id,
        idx: 1,
        pricing_mode: :qty_tiered,
        price: Decimal.new("9.99"),
        material_id: ctx.material.id,
        unit_id: ctx.kg.id
      })
      |> Ash.create!(authorize?: false)

    assert item.pricing_mode == :qty_tiered
    assert item.price == nil
  end

  test "(物料, 单位) 单内唯一;同物料不同单位允许", ctx do
    item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    assert_raise Ash.Error.Invalid, ~r/同一物料与单位在本报价单已有报价行/, fn ->
      item!(ctx.quotation, %{idx: 2, material_id: ctx.material.id, unit_id: ctx.kg.id})
    end

    # 同物料按箱报价是另一种成交口径,允许
    item!(ctx.quotation, %{idx: 2, material_id: ctx.material.id, unit_id: ctx.box.id})

    # 另一张报价单不受影响
    other =
      quotation!(%{company_id: ctx.company.id, party_type: :supplier, party_id: ctx.supplier.id})

    item!(other, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
  end

  test "条目单位限默认单位或转换单位", ctx do
    item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
    item!(ctx.quotation, %{idx: 2, material_id: ctx.material.id, unit_id: ctx.box.id})

    assert {:error, error} =
             QuotationItem
             |> Ash.Changeset.for_create(:create, %{
               quotation_id: ctx.quotation.id,
               idx: 3,
               price: 1,
               material_id: ctx.material.id,
               unit_id: ctx.pcs.id
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "单位必须是物料默认单位或其单位转换单位"
  end

  test "采购侧不校验客户物料约束:其他客户的专属料也可报价", ctx do
    customer =
      SynieCore.Sales.Customer
      |> Ash.Changeset.for_create(:create, %{
        code: "C-#{System.unique_integer([:positive])}",
        name: "客户"
      })
      |> Ash.create!(authorize?: false)

    # 客户方产品编号仅客户料可持有(非客户料保存即清空),先升级为客户料
    ctx.material
    |> Ash.Changeset.for_update(:update, %{
      spec: "Φ12×45",
      is_customer_material: true,
      customer_id: customer.id,
      customer_part_no: "KH-518"
    })
    |> Ash.update!(authorize?: false)

    item = item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    assert item.material_code == ctx.material.code
    assert item.material_name == "螺丝"
    assert item.material_spec == "Φ12×45"
    assert item.customer_part_no == "KH-518"
    assert item.unit_name == "千克"
    assert item.company_id == ctx.company.id
  end

  test "价格档:起订量>0、同条目内唯一;档价可为 0", ctx do
    item = tiered_item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    tier!(item, %{min_qty: 100, price: Decimal.new("9.50")})
    tier!(item, %{min_qty: 500, price: Decimal.new("9.20")})

    assert_raise Ash.Error.Invalid, ~r/同一起订量档已存在/, fn ->
      tier!(item, %{min_qty: 100, price: Decimal.new("9.00")})
    end

    assert {:error, error} =
             QuotationTier
             |> Ash.Changeset.for_create(:create, %{item_id: item.id, min_qty: 0, price: 1})
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "起订量必须大于零"

    # 免费档(赠送场景)允许
    tier!(item, %{min_qty: 1000, price: 0})

    [loaded] =
      QuotationItem
      |> Ash.Query.filter(id == ^item.id)
      |> Ash.Query.load(:tier_count)
      |> Ash.read!(authorize?: false)

    assert loaded.tier_count == 3
  end

  test "价格档默认按起订量升序", ctx do
    item = tiered_item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    tier!(item, %{min_qty: 500, price: Decimal.new("9.20")})
    tier!(item, %{min_qty: 100, price: Decimal.new("9.50")})
    tier!(item, %{min_qty: 300, price: Decimal.new("9.35")})

    mins =
      QuotationTier
      |> Ash.Query.filter(item_id == ^item.id)
      |> Ash.read!(authorize?: false)
      |> Enum.map(&Decimal.to_integer(Decimal.round(&1.min_qty)))

    assert mins == [100, 300, 500]
  end

  test "固定价条目拒挂价格档", ctx do
    item = item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    assert {:error, error} =
             QuotationTier
             |> Ash.Changeset.for_create(:create, %{item_id: item.id, min_qty: 100, price: 1})
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "仅数量梯度条目可维护价格档"
  end

  test "条目从梯度切回固定价:清空价格档,须补含税单价", ctx do
    item = tiered_item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
    tier!(item, %{min_qty: 100, price: Decimal.new("9.50")})

    # 不补单价被拒
    assert {:error, error} =
             item
             |> Ash.Changeset.for_update(:update, %{pricing_mode: :fixed})
             |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "固定价条目必须填写含税单价"

    updated =
      item
      |> Ash.Changeset.for_update(:update, %{pricing_mode: :fixed, price: Decimal.new("9.40")})
      |> Ash.update!(authorize?: false)

    assert updated.pricing_mode == :fixed
    assert Decimal.equal?(updated.price, Decimal.new("9.40"))

    assert QuotationTier
           |> Ash.Query.filter(item_id == ^item.id)
           |> Ash.read!(authorize?: false) == []
  end

  test "空单不允许审核,至少一行", ctx do
    assert {:error, error} =
             ctx.quotation
             |> Ash.Changeset.for_update(:audit, %{})
             |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "审核前必须至少填写一行条目"
  end

  test "梯度条目无档不允许审核,补档后可审", ctx do
    item = tiered_item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    assert {:error, error} =
             ctx.quotation
             |> Ash.Changeset.for_update(:audit, %{})
             |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "数量梯度条目必须至少填写一个价格档"

    tier!(item, %{min_qty: 100, price: Decimal.new("9.50")})

    audited =
      ctx.quotation
      |> Ash.Changeset.for_update(:audit, %{})
      |> Ash.update!(authorize?: false)

    assert audited.status == :audited
    assert audited.audited_at
  end

  test "审核后锁死:头不可改、行不可增、档不可增、单不可删", ctx do
    item = tiered_item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
    tier!(item, %{min_qty: 100, price: Decimal.new("9.50")})

    audited =
      ctx.quotation
      |> Ash.Changeset.for_update(:audit, %{})
      |> Ash.update!(authorize?: false)

    assert {:error, error} =
             audited
             |> Ash.Changeset.for_update(:update, %{remarks: "改"})
             |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "仅草稿报价单可修改或删除"

    assert {:error, error} =
             QuotationItem
             |> Ash.Changeset.for_create(:create, %{
               quotation_id: audited.id,
               idx: 2,
               price: 1,
               material_id: ctx.material.id,
               unit_id: ctx.box.id
             })
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "仅草稿报价单可编辑条目"

    assert {:error, error} =
             QuotationTier
             |> Ash.Changeset.for_create(:create, %{item_id: item.id, min_qty: 500, price: 1})
             |> Ash.create(authorize?: false)

    assert Exception.message(error) =~ "仅草稿报价单可编辑价格档"

    assert {:error, error} =
             audited
             |> Ash.Changeset.for_destroy(:destroy)
             |> Ash.destroy(authorize?: false)

    assert Exception.message(error) =~ "仅草稿报价单可修改或删除"
  end

  test "仅已审核可作废;草稿不可作废;作废终态", ctx do
    assert {:error, _} =
             ctx.quotation
             |> Ash.Changeset.for_update(:void, %{})
             |> Ash.update(authorize?: false)

    item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    voided =
      ctx.quotation
      |> Ash.Changeset.for_update(:audit, %{})
      |> Ash.update!(authorize?: false)
      |> Ash.Changeset.for_update(:void, %{})
      |> Ash.update!(authorize?: false)

    assert voided.status == :voided

    # 作废后不可再作废/审核
    assert {:error, _} =
             voided |> Ash.Changeset.for_update(:void, %{}) |> Ash.update(authorize?: false)

    assert {:error, _} =
             voided |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update(authorize?: false)
  end

  test "已过期(截止日在过去)的已审核单仍可作废(过期是派生态)", ctx do
    quotation =
      quotation!(%{
        company_id: ctx.company.id,
        party_type: :supplier,
        party_id: ctx.supplier.id,
        quotation_date: ~D[2026-01-01],
        valid_until: ~D[2026-01-31]
      })

    item!(quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    voided =
      quotation
      |> Ash.Changeset.for_update(:audit, %{})
      |> Ash.update!(authorize?: false)
      |> Ash.Changeset.for_update(:void, %{})
      |> Ash.update!(authorize?: false)

    assert voided.status == :voided
  end

  test "删除草稿报价单级联删行删档", ctx do
    item = tiered_item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})
    tier = tier!(item, %{min_qty: 100, price: Decimal.new("9.50")})

    :ok = ctx.quotation |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)

    assert {:error, _} = Ash.get(QuotationItem, item.id, authorize?: false)
    assert {:error, _} = Ash.get(QuotationTier, tier.id, authorize?: false)
  end

  test "头字段 calculation 沿报价单实时取数", ctx do
    item = item!(ctx.quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

    [loaded] =
      QuotationItem
      |> Ash.Query.filter(id == ^item.id)
      |> Ash.Query.load([
        :quotation_date,
        :valid_until,
        :quotation_status,
        :party_type,
        :party_id
      ])
      |> Ash.read!(authorize?: false)

    assert loaded.quotation_date == ~D[2026-07-17]
    assert loaded.valid_until == ~D[2026-08-17]
    assert loaded.quotation_status == :draft
    assert loaded.party_type == :supplier
    assert loaded.party_id == ctx.supplier.id
  end

  test "条目主读未指定排序时兜底行号升序", ctx do
    item!(ctx.quotation, %{idx: 2, material_id: ctx.material.id, unit_id: ctx.kg.id})
    item!(ctx.quotation, %{idx: 1, material_id: ctx.material.id, unit_id: ctx.box.id})

    results =
      QuotationItem
      |> Ash.Query.filter(quotation_id == ^ctx.quotation.id)
      |> Ash.read!(authorize?: false)

    assert Enum.map(results, & &1.idx) == [1, 2]
  end

  describe "自动编号" do
    defp numbering_rule! do
      SynieCore.Numbering.Rule
      |> Ash.Changeset.for_create(
        :create,
        %{
          resource: "purchase.quotation",
          name: "采购报价单",
          segments: [
            %{"type" => "text", "value" => "PQ-"},
            %{"type" => "seq", "padding" => 4}
          ]
        },
        authorize?: false
      )
      |> Ash.create!()
    end

    test "报价单号留空按规则自动取号,手填原样保留", ctx do
      numbering_rule!()

      auto =
        Quotation
        |> Ash.Changeset.for_create(:create, %{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          valid_until: ~D[2026-08-17]
        })
        |> Ash.create!(authorize?: false)

      assert auto.quotation_no == "PQ-0001"

      manual =
        quotation!(%{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          quotation_no: "PQ-手填"
        })

      assert manual.quotation_no == "PQ-手填"
    end
  end

  describe "权限" do
    defp actor_with!(permissions, company) do
      user = user!()
      role = role!()
      Enum.each(permissions, &grant!(role, &1))
      assign!(user, role)
      grant_company!(user, company)
      Authz.build_actor(user)
    end

    test "无权限者读写皆被拒绝", ctx do
      actor = actor_with!([], ctx.company)

      assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Quotation, actor: actor)

      assert_raise Ash.Error.Forbidden, fn ->
        Quotation
        |> Ash.Changeset.for_create(:create, %{
          company_id: ctx.company.id,
          party_type: :supplier,
          party_id: ctx.supplier.id,
          quotation_no: "PQ-N1",
          valid_until: ~D[2026-08-17]
        })
        |> Ash.create!(actor: actor)
      end
    end

    test "有 purchase.quotation 权限且授权公司可创建并审核", ctx do
      actor =
        actor_with!(
          ["purchase.quotation:create", "purchase.quotation:read", "purchase.quotation:audit"],
          ctx.company
        )

      quotation =
        Quotation
        |> Ash.Changeset.for_create(
          :create,
          %{
            company_id: ctx.company.id,
            party_type: :supplier,
            party_id: ctx.supplier.id,
            quotation_no: "PQ-#{System.unique_integer([:positive])}",
            valid_until: ~D[2026-08-17]
          },
          actor: actor
        )
        |> Ash.create!()

      assert quotation.created_by_id == actor.user_id

      item!(quotation, %{material_id: ctx.material.id, unit_id: ctx.kg.id})

      audited =
        quotation
        |> Ash.Changeset.for_update(:audit, %{}, actor: actor)
        |> Ash.update!()

      assert audited.status == :audited
      assert audited.audited_by_id == actor.user_id
    end
  end
end
