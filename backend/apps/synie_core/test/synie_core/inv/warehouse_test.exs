defmodule SynieCore.Inv.WarehouseTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.Account
  alias SynieCore.Inv.Warehouse

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    %{company: company!()}
  end

  defp warehouse!(attrs) do
    Warehouse
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp account!(attrs) do
    Account
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["inv.warehouse:*"])},
      overrides
    )
  end

  test "创建成功,has_children 反映有无下级", %{company: co} do
    root = warehouse!(%{name: "总仓", is_leaf: false, company_id: co.id})
    leaf = warehouse!(%{name: "子仓", parent_id: root.id, company_id: co.id})

    assert root.active
    refute root.is_outsourced
    refute root.allow_negative
    assert leaf.is_leaf

    root = Ash.get!(Warehouse, root.id, load: [:has_children], authorize?: false)
    leaf = Ash.get!(Warehouse, leaf.id, load: [:has_children], authorize?: false)
    assert root.has_children
    refute leaf.has_children
  end

  test "仓库名称同公司唯一,跨公司可同名", %{company: co} do
    other = company!()
    warehouse!(%{name: "主仓", company_id: co.id})
    warehouse!(%{name: "主仓", company_id: other.id})

    assert_raise Ash.Error.Invalid, ~r/仓库名称已存在/, fn ->
      warehouse!(%{name: "主仓", company_id: co.id})
    end
  end

  describe "上级仓库" do
    test "不能选自身", %{company: co} do
      wh = warehouse!(%{name: "主仓", company_id: co.id})

      assert_raise Ash.Error.Invalid, ~r/上级仓库不能选择自身/, fn ->
        wh
        |> Ash.Changeset.for_update(:update, %{parent_id: wh.id})
        |> Ash.update!(authorize?: false)
      end
    end

    test "叶子仓库下不能挂子仓库", %{company: co} do
      leaf = warehouse!(%{name: "叶子仓", company_id: co.id})

      assert_raise Ash.Error.Invalid, ~r/上级仓库是叶子仓库,不能挂子仓库/, fn ->
        warehouse!(%{name: "子仓", parent_id: leaf.id, company_id: co.id})
      end
    end

    test "上级仓库必须同公司", %{company: co} do
      other = company!()
      root = warehouse!(%{name: "外司仓", is_leaf: false, company_id: other.id})

      assert_raise Ash.Error.Invalid, ~r/上级仓库不属于本公司/, fn ->
        warehouse!(%{name: "子仓", parent_id: root.id, company_id: co.id})
      end
    end

    test "不存在的上级仓库报错", %{company: co} do
      assert_raise Ash.Error.Invalid, ~r/上级仓库不存在/, fn ->
        warehouse!(%{name: "子仓", parent_id: Ash.UUID.generate(), company_id: co.id})
      end
    end

    test "多根并列允许", %{company: co} do
      warehouse!(%{name: "仓一", company_id: co.id})
      warehouse!(%{name: "仓二", company_id: co.id})

      roots =
        Warehouse
        |> Ash.Query.filter(is_nil(parent_id) and company_id == ^co.id)
        |> Ash.read!(authorize?: false)

      assert length(roots) == 2
    end
  end

  describe "关联科目" do
    test "本币叶子科目可关联,科目可空", %{company: co} do
      acc =
        account!(%{code: "1403", name: "库存商品", direction: :debit, company_id: co.id})

      wh = warehouse!(%{name: "主仓", company_id: co.id, account_id: acc.id})
      assert wh.account_id == acc.id

      assert warehouse!(%{name: "无科目仓", company_id: co.id}).account_id == nil
    end

    test "汇总科目不能作为关联科目", %{company: co} do
      acc =
        account!(%{
          code: "1",
          name: "资产",
          direction: :debit,
          is_group: true,
          company_id: co.id
        })

      assert_raise Ash.Error.Invalid, ~r/汇总科目不能作为关联科目/, fn ->
        warehouse!(%{name: "主仓", company_id: co.id, account_id: acc.id})
      end
    end

    test "外币科目不能作为关联科目", %{company: co} do
      foreign = foreign_currency!(%{})

      acc =
        account!(%{
          code: "1002",
          name: "银行存款",
          direction: :debit,
          currency_id: foreign.id,
          company_id: co.id
        })

      assert_raise Ash.Error.Invalid, ~r/外币科目不能作为关联科目/, fn ->
        warehouse!(%{name: "主仓", company_id: co.id, account_id: acc.id})
      end
    end

    test "跨公司科目不能作为关联科目", %{company: co} do
      other = company!()

      acc =
        account!(%{code: "1403", name: "库存商品", direction: :debit, company_id: other.id})

      assert_raise Ash.Error.Invalid, ~r/关联科目不属于本公司/, fn ->
        warehouse!(%{name: "主仓", company_id: co.id, account_id: acc.id})
      end
    end

    test "不存在的科目报错", %{company: co} do
      assert_raise Ash.Error.Invalid, ~r/关联科目不存在/, fn ->
        warehouse!(%{name: "主仓", company_id: co.id, account_id: Ash.UUID.generate()})
      end
    end
  end

  test "存在下级仓库不能改为叶子仓库", %{company: co} do
    root = warehouse!(%{name: "总仓", is_leaf: false, company_id: co.id})
    warehouse!(%{name: "子仓", parent_id: root.id, company_id: co.id})

    assert_raise Ash.Error.Invalid, ~r/存在下级仓库,不能改为叶子仓库/, fn ->
      root
      |> Ash.Changeset.for_update(:update, %{is_leaf: true})
      |> Ash.update!(authorize?: false)
    end
  end

  test "存在下级仓库不能删除,叶子可删", %{company: co} do
    root = warehouse!(%{name: "总仓", is_leaf: false, company_id: co.id})
    leaf = warehouse!(%{name: "子仓", parent_id: root.id, company_id: co.id})

    assert_raise Ash.Error.Invalid, ~r/存在下级仓库,不能删除/, fn ->
      root |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    end

    :ok = leaf |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    :ok = root |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
  end

  test "update 不接受 company_id(不允许换公司)", %{company: co} do
    other = company!()
    wh = warehouse!(%{name: "主仓", company_id: co.id})

    assert_raise Ash.Error.Invalid, fn ->
      wh
      |> Ash.Changeset.for_update(:update, %{company_id: other.id})
      |> Ash.update!(authorize?: false)
    end

    assert Ash.get!(Warehouse, wh.id, authorize?: false).company_id == co.id
  end

  test "读取按授权公司过滤(fail-closed)", %{company: co} do
    other = company!()
    warehouse!(%{name: "主仓", company_id: co.id})
    warehouse!(%{name: "外司仓", company_id: other.id})

    rows = Ash.read!(Warehouse, actor: actor(%{company_ids: [co.id]}))
    assert Enum.map(rows, & &1.company_id) == [co.id]

    assert Ash.read!(Warehouse, actor: actor(%{})) == []
  end

  describe "seed_defaults" do
    test "建出三仓:根非叶、两子叶、名称含公司 code", %{company: co} do
      count =
        Warehouse
        |> Ash.ActionInput.for_action(:seed_defaults, %{company_id: co.id})
        |> Ash.run_action!(authorize?: false)

      assert count == 3

      rows =
        Warehouse
        |> Ash.Query.filter(company_id == ^co.id)
        |> Ash.read!(authorize?: false)

      assert length(rows) == 3

      [root] = Enum.filter(rows, &is_nil(&1.parent_id))
      assert root.name == "#{co.code} - 所有仓库"
      refute root.is_leaf

      leaves = Enum.filter(rows, &(&1.parent_id == root.id))

      assert leaves |> Enum.map(& &1.name) |> Enum.sort() == [
               "#{co.code} - 在途",
               "#{co.code} - 默认仓库"
             ]

      assert Enum.all?(leaves, & &1.is_leaf)
    end

    test "重复调用幂等返回 0,不重复建仓", %{company: co} do
      Warehouse
      |> Ash.ActionInput.for_action(:seed_defaults, %{company_id: co.id})
      |> Ash.run_action!(authorize?: false)

      count =
        Warehouse
        |> Ash.ActionInput.for_action(:seed_defaults, %{company_id: co.id})
        |> Ash.run_action!(authorize?: false)

      assert count == 0

      rows =
        Warehouse
        |> Ash.Query.filter(company_id == ^co.id)
        |> Ash.read!(authorize?: false)

      assert length(rows) == 3
    end

    test "无公司授权不能初始化", %{company: co} do
      assert {:error, _} =
               Warehouse
               |> Ash.ActionInput.for_action(
                 :seed_defaults,
                 %{company_id: co.id},
                 actor: actor(%{company_ids: []})
               )
               |> Ash.run_action()
    end
  end

  test "资源声明了权限前缀" do
    assert Warehouse.permission_prefix() == "inv.warehouse"
    assert Warehouse.permission_actions() == ~w(create read update delete)
  end
end
