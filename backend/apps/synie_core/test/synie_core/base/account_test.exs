defmodule SynieCore.Base.AccountTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz.Actor
  alias SynieCore.Base.{Account, AccountTemplates}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    %{company: company!()}
  end

  defp account!(attrs) do
    Account
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp actor(overrides) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["base.account:*"])},
      overrides
    )
  end

  test "创建根科目与子科目,children_count 聚合", %{company: co} do
    root =
      account!(%{code: "1", name: "资产", direction: :debit, is_group: true, company_id: co.id})

    account!(%{
      code: "1001",
      name: "库存现金",
      direction: :debit,
      parent_id: root.id,
      company_id: co.id
    })

    root = Ash.get!(Account, root.id, load: [:has_children], authorize?: false)
    assert root.has_children == true
  end

  test "编码同公司唯一,跨公司可重复", %{company: co} do
    other = company!()
    account!(%{code: "1001", name: "库存现金", direction: :debit, company_id: co.id})
    account!(%{code: "1001", name: "库存现金", direction: :debit, company_id: other.id})

    assert_raise Ash.Error.Invalid, fn ->
      account!(%{code: "1001", name: "重复", direction: :debit, company_id: co.id})
    end
  end

  test "上级科目不能选自身", %{company: co} do
    acc = account!(%{code: "1001", name: "库存现金", direction: :debit, company_id: co.id})

    assert_raise Ash.Error.Invalid, fn ->
      acc
      |> Ash.Changeset.for_update(:update, %{parent_id: acc.id})
      |> Ash.update!(authorize?: false)
    end
  end

  test "上级科目必须同公司", %{company: co} do
    other = company!()

    root =
      account!(%{code: "1", name: "资产", direction: :debit, is_group: true, company_id: other.id})

    assert_raise Ash.Error.Invalid, fn ->
      account!(%{
        code: "1001",
        name: "库存现金",
        direction: :debit,
        parent_id: root.id,
        company_id: co.id
      })
    end
  end

  test "存在下级科目不能删除", %{company: co} do
    root =
      account!(%{code: "1", name: "资产", direction: :debit, is_group: true, company_id: co.id})

    child =
      account!(%{
        code: "1001",
        name: "库存现金",
        direction: :debit,
        parent_id: root.id,
        company_id: co.id
      })

    assert_raise Ash.Error.Invalid, fn ->
      root |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
    end

    :ok = child |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy!(authorize?: false)
  end

  test "读取按授权公司过滤(fail-closed)", %{company: co} do
    other = company!()
    account!(%{code: "1", name: "资产", direction: :debit, company_id: co.id})
    account!(%{code: "1", name: "资产", direction: :debit, company_id: other.id})

    rows = Ash.read!(Account, actor: actor(%{company_ids: [co.id]}))
    assert Enum.map(rows, & &1.company_id) == [co.id]

    assert Ash.read!(Account, actor: actor(%{})) == []
  end

  for template <- [:cas, :small, :intl] do
    test "模板 #{template} 初始化整套科目", %{company: co} do
      count =
        Account
        |> Ash.ActionInput.for_action(:init_from_template, %{
          company_id: co.id,
          template: unquote(template)
        })
        |> Ash.run_action!(authorize?: false)

      assert count == length(AccountTemplates.entries(unquote(template)))
      assert count > 30

      roots =
        Account
        |> Ash.Query.filter(is_nil(parent_id) and company_id == ^co.id)
        |> Ash.read!(authorize?: false)

      assert length(roots) in [5, 6]
      assert Enum.all?(roots, & &1.is_group)
    end
  end

  describe "科目角色" do
    test "叶子科目可挂,汇总科目自动清空角色", %{company: co} do
      leaf =
        account!(%{
          code: "1122",
          name: "应收账款",
          direction: :debit,
          role: :receivable,
          company_id: co.id
        })

      assert leaf.role == :receivable

      # 创建时同时给汇总+角色:自动丢掉角色
      group =
        account!(%{
          code: "1",
          name: "资产",
          direction: :debit,
          is_group: true,
          role: :receivable,
          company_id: co.id
        })

      assert group.is_group
      assert group.role == nil

      # 已挂角色的叶子改成汇总:自动清空角色(前端勾选汇总后角色不进 payload)
      updated =
        leaf
        |> Ash.Changeset.for_update(:update, %{is_group: true})
        |> Ash.update!(authorize?: false)

      assert updated.is_group
      assert updated.role == nil
    end

    test "外币科目不能挂角色,人民币科目可以", %{company: co} do
      # 外币:唯一码夹具(iso_code 全局唯一,避免多 async 模块并发建同码互锁)
      usd = foreign_currency!()

      # CNY 已由迁移种入(公司本币兜底),取或建而非直建
      cny = cny!()

      assert_raise Ash.Error.Invalid, ~r/外币科目不能设置科目角色/, fn ->
        account!(%{
          code: "1122",
          name: "应收账款",
          direction: :debit,
          role: :receivable,
          currency_id: usd.id,
          company_id: co.id
        })
      end

      assert account!(%{
               code: "1122",
               name: "应收账款",
               direction: :debit,
               role: :receivable,
               currency_id: cny.id,
               company_id: co.id
             }).role == :receivable
    end

    test "模板初始化预设四个往来科目的角色", %{company: co} do
      Account
      |> Ash.ActionInput.for_action(:init_from_template, %{company_id: co.id, template: :cas})
      |> Ash.run_action!(authorize?: false)

      roles =
        Account
        |> Ash.Query.filter(company_id == ^co.id and not is_nil(role))
        |> Ash.read!(authorize?: false)
        |> Map.new(&{&1.name, &1.role})

      assert roles == %{
               "应收账款" => :receivable,
               "预付账款" => :advance_paid,
               "应付账款" => :payable,
               "预收账款" => :advance_received
             }
    end

    test "往来/费用两族角色清单;其他应付款自然方向为贷", %{company: co} do
      alias SynieCore.Base.AccountRole

      assert AccountRole.party_roles() ==
               AccountRole.receivable_roles() ++ AccountRole.payable_roles()

      assert AccountRole.payable_roles() ==
               [:unbilled_payable, :payable, :other_payable, :advance_paid]

      assert AccountRole.expense_roles() ==
               [:travel, :office, :entertainment, :transport, :other_expense]

      assert AccountRole.natural_direction(:other_payable) == :credit

      # 费用角色同往来角色一样可挂叶子本币科目
      assert account!(%{
               code: "660201",
               name: "差旅费",
               direction: :debit,
               role: :travel,
               company_id: co.id
             }).role == :travel
    end
  end

  test "已有科目的公司不能重复初始化", %{company: co} do
    account!(%{code: "1", name: "资产", direction: :debit, company_id: co.id})

    assert {:error, _} =
             Account
             |> Ash.ActionInput.for_action(:init_from_template, %{
               company_id: co.id,
               template: :small
             })
             |> Ash.run_action(authorize?: false)
  end

  test "无公司授权不能初始化", %{company: co} do
    assert {:error, _} =
             Account
             |> Ash.ActionInput.for_action(
               :init_from_template,
               %{company_id: co.id, template: :small},
               actor: actor(%{company_ids: []})
             )
             |> Ash.run_action()
  end

  test "资源声明了权限前缀;模板初始化复用 create 不占独立权限点" do
    assert Account.permission_prefix() == "base.account"
    assert Account.permission_actions() == ~w(create read update delete)
  end
end
