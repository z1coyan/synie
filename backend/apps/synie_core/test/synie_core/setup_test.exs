defmodule SynieCore.SetupTest do
  use ExUnit.Case, async: true

  require Ash.Query

  alias SynieCore.{Authz, Setup}
  alias SynieCore.Accounts.User
  alias SynieCore.Base.Currency
  alias SynieCore.Base.Unit
  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Inv.MaterialCategory
  alias SynieCore.Numbering.Rule

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "初始状态:未初始化、无用户(测试库迁移种子的完成旗标留空)" do
    assert %{initialized: false, has_users: false} = Setup.status()
  end

  test "create_first_user 建首个用户并打超管旗标,之后拒绝再建" do
    assert {:ok, user} =
             Setup.create_first_user(%{username: "first_admin", name: "管理员", password: "s3cret"})

    assert user.super_admin
    assert %{initialized: false, has_users: true} = Setup.status()

    assert {:error, "已存在用户,请直接登录"} =
             Setup.create_first_user(%{username: "second", password: "x"})
  end

  test "seed_common_currencies 幂等补齐常用货币且全部停用,已初始化后拒绝" do
    # 迁移已保底 CNY,故新建 19 种、总量 20 种齐全;尚无公司时清单内全部停用
    assert {:ok, 19} = Setup.seed_common_currencies()

    currencies = Currency |> Ash.read!(authorize?: false)
    codes = Enum.map(currencies, & &1.iso_code)

    for code <-
          ~w(CNY USD EUR JPY HKD TWD GBP KRW SGD AUD CAD CHF MOP THB MYR IDR VND PHP INR RUB) do
      assert code in codes
    end

    for c <- currencies, c.iso_code in ~w(CNY USD EUR JPY) do
      assert c.active == false, "#{c.iso_code} 应停用"
    end

    assert {:ok, 0} = Setup.seed_common_currencies()

    {:ok, user} = Setup.create_first_user(%{username: "admin_for_seed", password: "s3cret"})
    :ok = Setup.complete(Authz.build_actor(user), "zh-CN")

    assert {:error, "系统已完成初始化"} = Setup.seed_common_currencies()
  end

  test "activate_only_base_currency 仅启用选定本币,已初始化后拒绝" do
    assert {:ok, _} = Setup.seed_common_currencies()

    usd =
      Currency
      |> Ash.Query.filter(iso_code == "USD")
      |> Ash.read_one!(authorize?: false)

    assert usd.active == false
    assert :ok = Setup.activate_only_base_currency(usd.id)

    by_code = Currency |> Ash.read!(authorize?: false) |> Map.new(&{&1.iso_code, &1})
    assert by_code["USD"].active == true
    assert by_code["CNY"].active == false
    assert by_code["EUR"].active == false

    # 改选本币:仅新本币启用
    cny = by_code["CNY"]
    assert :ok = Setup.activate_only_base_currency(cny.id)
    by_code = Currency |> Ash.read!(authorize?: false) |> Map.new(&{&1.iso_code, &1})
    assert by_code["CNY"].active == true
    assert by_code["USD"].active == false

    {:ok, user} = Setup.create_first_user(%{username: "admin_for_base", password: "s3cret"})
    :ok = Setup.complete(Authz.build_actor(user), "zh-CN")

    assert {:error, "系统已完成初始化"} = Setup.activate_only_base_currency(usd.id)
  end

  test "complete 写首选语言、种子存储/编号/分类、落完成旗标,随后 setup 接口全面关闭" do
    {:ok, user} = Setup.create_first_user(%{username: "admin_done", password: "s3cret"})
    actor = Authz.build_actor(user)

    assert {:error, "不支持的语言"} = Setup.complete(actor, "fr-FR")
    assert %{initialized: false} = Setup.status()
    # 完成前不应有存储接入/编号规则/物料分类
    assert [] = StorageEndpoint |> Ash.read!(authorize?: false)
    assert [] = Rule |> Ash.read!(authorize?: false)
    assert [] = MaterialCategory |> Ash.read!(authorize?: false)

    assert :ok = Setup.complete(actor, "zh-CN")

    user = Ash.get!(User, user.id, authorize?: false)
    assert user.preferred_language == "zh-CN"
    assert %{initialized: true} = Setup.status()

    # 内置 local 存储接入
    local = StorageEndpoint |> Ash.Query.filter(name == "local") |> Ash.read_one!(authorize?: false)
    assert local.builtin
    assert local.is_default
    assert local.kind == :local
    assert local.root == "uploads"

    # 编号规则:物料 + 员工 + 15 种业务单据
    rules = Rule |> Ash.read!(authorize?: false)
    assert length(rules) == 17
    resources = MapSet.new(rules, & &1.resource)
    assert "inv.material" in resources
    assert "hr.employee" in resources
    assert "sales.order" in resources
    assert "acc.gl_journal" in resources

    material_rule = Enum.find(rules, &(&1.resource == "inv.material"))
    assert material_rule.per_company == false
    assert Enum.any?(material_rule.segments, &(&1["type"] == "seq" and &1["padding"] == 0))

    sales_order = Enum.find(rules, &(&1.resource == "sales.order"))
    assert sales_order.per_company == true
    assert Enum.any?(sales_order.segments, &(&1["type"] == "text" and &1["value"] == "S(O)-"))

    # 物料两级分类:5 大类 + 叶子
    cats = MaterialCategory |> Ash.read!(authorize?: false)
    by_code = Map.new(cats, &{&1.code, &1})
    assert by_code["F"].is_leaf == false
    assert by_code["F(P)"].is_leaf == true
    assert by_code["F(P)"].parent_id == by_code["F"].id
    assert by_code["P(W)"].name == "木箱"
    assert by_code["S(G)"].is_leaf == true
    assert length(cats) == 16

    # 机加工计量单位(按 symbol;重量吨/千克可能已由迁移存在)
    by_symbol = Unit |> Ash.read!(authorize?: false) |> Map.new(&{&1.symbol, &1})
    assert by_symbol["mm"].is_base == true
    assert by_symbol["mm"].unit_type == :length
    assert by_symbol["μm"].unit_type == :length
    assert by_symbol["mm²"].is_base == true
    assert by_symbol["pcs"].is_base == true
    assert by_symbol["pcs"].unit_type == :quantity
    assert by_symbol["打"].ratio == Decimal.new("12")
    assert by_symbol["台"].unit_type == :quantity
    # 迁移已有重量基准「吨」时,setup 不另抢基准
    assert by_symbol["t"].is_base == true
    assert by_symbol["g"].unit_type == :weight

    assert {:error, "系统已完成初始化"} = Setup.complete(actor, "en-US")

    assert {:error, "系统已完成初始化"} =
             Setup.create_first_user(%{username: "latecomer", password: "x"})
  end

  test "complete seed_sample_data 写入示例客商/物料/报价,幂等跳过" do
    alias SynieCore.Base.Company
    alias SynieCore.Inv.Material
    alias SynieCore.Purchase.Supplier
    alias SynieCore.Sales.Customer
    alias SynieCore.Setup.SampleData

    {:ok, _} = Setup.seed_common_currencies()

    cny =
      Currency
      |> Ash.Query.filter(iso_code == "CNY")
      |> Ash.read_one!(authorize?: false)

    assert :ok = Setup.activate_only_base_currency(cny.id)

    company =
      Company
      |> Ash.Changeset.for_create(:create, %{
        code: "JT",
        name: "台州京泰电气有限公司",
        short_name: "台州京泰",
        base_currency_id: cny.id
      })
      |> Ash.create!(authorize?: false)

    {:ok, user} = Setup.create_first_user(%{username: "admin_sample", name: "管理员", password: "s3cret"})
    actor = Authz.build_actor(user)

    assert :ok = Setup.complete(actor, "zh-CN", seed_sample_data: true)

    customers = Customer |> Ash.read!(authorize?: false)
    suppliers = Supplier |> Ash.read!(authorize?: false)
    materials = Material |> Ash.read!(authorize?: false)
    sales_qs = SynieCore.Sales.Quotation |> Ash.read!(authorize?: false)
    pur_qs = SynieCore.Purchase.Quotation |> Ash.read!(authorize?: false)

    assert length(customers) == 3
    assert Enum.any?(customers, &(&1.code == "C01" and &1.short_name == "海纳电气"))
    assert length(suppliers) == 3
    assert Enum.any?(suppliers, &(&1.code == "S01"))
    assert length(materials) == 6
    assert Enum.count(materials, & &1.is_customer_material) == 2
    assert length(sales_qs) == 2
    assert Enum.count(sales_qs, &(&1.status == :audited)) == 1
    assert Enum.count(sales_qs, &(&1.status == :draft)) == 1
    assert length(pur_qs) == 2
    assert Enum.count(pur_qs, &(&1.status == :audited)) == 1

    # 幂等:再次 seed 不增行
    {summary, []} = SampleData.seed!(company.id, actor)
    assert summary == %{
             customers: 0,
             suppliers: 0,
             materials: 0,
             sales_quotations: 0,
             purchase_quotations: 0
           }

    assert length(Customer |> Ash.read!(authorize?: false)) == 3
    assert length(Material |> Ash.read!(authorize?: false)) == 6
  end

  test "complete 幂等:已有存储/编号规则/分类时不覆盖" do
    StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{
      name: "local",
      label: "改过的本地",
      kind: :local,
      root: "custom_uploads"
    })
    |> Ash.Changeset.force_change_attribute(:builtin, true)
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)

    Rule
    |> Ash.Changeset.for_create(:create, %{
      resource: "inv.material",
      name: "用户改过的物料编号",
      segments: [
        %{"type" => "text", "value" => "X-"},
        %{"type" => "seq", "padding" => 4}
      ],
      per_company: false,
      enabled: true
    })
    |> Ash.create!(authorize?: false)

    MaterialCategory
    |> Ash.Changeset.for_create(:create, %{code: "Z", name: "自定义", is_leaf: true, active: true})
    |> Ash.create!(authorize?: false)

    {:ok, user} = Setup.create_first_user(%{username: "admin_idem", password: "s3cret"})
    assert :ok = Setup.complete(Authz.build_actor(user), "zh-CN")

    local = StorageEndpoint |> Ash.Query.filter(name == "local") |> Ash.read_one!(authorize?: false)
    assert local.root == "custom_uploads"
    assert local.label == "改过的本地"

    material = Rule |> Ash.Query.filter(resource == "inv.material") |> Ash.read_one!(authorize?: false)
    assert material.name == "用户改过的物料编号"

    # 已有任一分类则整棵跳过,不会再补默认树
    codes = MaterialCategory |> Ash.read!(authorize?: false) |> Enum.map(& &1.code)
    assert codes == ["Z"]
    # 其余单据规则仍会补齐
    assert Rule |> Ash.Query.filter(resource == "sales.order") |> Ash.exists?(authorize?: false)
  end
end
