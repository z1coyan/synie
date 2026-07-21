defmodule SynieCore.Sales.SettingTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Sales.Setting

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    :ok
  end

  defp actor_with!(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  test "迁移 seed 保证单行存在,样品/零星上限默认 100,超收比例默认 0" do
    assert %Setting{sample_item_max_qty: 100, spot_item_max_qty: 100} = Setting.get()
    assert Decimal.equal?(Setting.get().receipt_overreceive_ratio, Decimal.new(0))
  end

  test "有 sales.setting:update 权限可更新零星上限与入库超收比例" do
    actor = actor_with!(["sales.setting:read", "sales.setting:update"])

    setting =
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{
        spot_item_max_qty: 20,
        receipt_overreceive_ratio: Decimal.new("0.05")
      })
      |> Ash.update!(actor: actor)

    assert setting.spot_item_max_qty == 20
    assert Decimal.equal?(setting.receipt_overreceive_ratio, Decimal.new("0.05"))
  end

  test "零星上限必须大于零,入库超收比例范围 [0,1]" do
    assert {:error, error} =
             Setting.get()
             |> Ash.Changeset.for_update(:update, %{spot_item_max_qty: 0})
             |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "零星条目数量上限必须大于零"

    assert {:error, error2} =
             Setting.get()
             |> Ash.Changeset.for_update(:update, %{
               receipt_overreceive_ratio: Decimal.new("1.01")
             })
             |> Ash.update(authorize?: false)

    assert Exception.message(error2) =~ "入库超收比例不能超过 100%"
  end

  test "有 sales.setting:update 权限可更新样品上限" do
    actor = actor_with!(["sales.setting:read", "sales.setting:update"])

    setting =
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{sample_item_max_qty: 20})
      |> Ash.update!(actor: actor)

    assert setting.sample_item_max_qty == 20
  end

  test "上限必须大于零" do
    assert {:error, error} =
             Setting.get()
             |> Ash.Changeset.for_update(:update, %{sample_item_max_qty: 0})
             |> Ash.update(authorize?: false)

    assert Exception.message(error) =~ "样品条目数量上限必须大于零"
  end

  test "单行表不开放 create/destroy" do
    actions = Setting |> Ash.Resource.Info.actions() |> Enum.map(& &1.name)

    refute :create in actions
    refute :destroy in actions
    assert :read in actions
    assert :update in actions
  end

  test "无权限者读写皆被拒绝" do
    actor = actor_with!([])

    assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Setting, actor: actor)

    assert_raise Ash.Error.Forbidden, fn ->
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{sample_item_max_qty: 20})
      |> Ash.update!(actor: actor)
    end
  end
end
