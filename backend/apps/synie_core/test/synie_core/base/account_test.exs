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
    root = account!(%{code: "1", name: "资产", direction: :debit, is_group: true, company_id: co.id})
    account!(%{code: "1001", name: "库存现金", direction: :debit, parent_id: root.id, company_id: co.id})

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
    root = account!(%{code: "1", name: "资产", direction: :debit, is_group: true, company_id: other.id})

    assert_raise Ash.Error.Invalid, fn ->
      account!(%{code: "1001", name: "库存现金", direction: :debit, parent_id: root.id, company_id: co.id})
    end
  end

  test "存在下级科目不能删除", %{company: co} do
    root = account!(%{code: "1", name: "资产", direction: :debit, is_group: true, company_id: co.id})
    child = account!(%{code: "1001", name: "库存现金", direction: :debit, parent_id: root.id, company_id: co.id})

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

  test "资源声明了权限前缀" do
    assert Account.permission_prefix() == "base.account"
    assert "init_from_template" in Account.permission_actions()
  end
end
