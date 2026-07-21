defmodule SynieCore.Authz.RolePermissionSyncTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz.{Role, RolePermission}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp sync(role, permissions) do
    RolePermission
    |> Ash.ActionInput.for_action(:sync, %{role_id: role.id, permissions: permissions})
    |> Ash.run_action(authorize?: false)
  end

  defp codes_of(role) do
    RolePermission
    |> Ash.Query.filter(role_id == ^role.id)
    |> Ash.read!(authorize?: false)
    |> Enum.map(& &1.permission)
    |> Enum.sort()
  end

  test "按目标列表增删目录内具体码,返回同步后全部授权码" do
    role = role!()
    grant!(role, "sales.order:read")
    grant!(role, "sales.order:create")

    assert {:ok, codes} = sync(role, ["sales.order:read", "base.company:read"])

    assert codes == ["base.company:read", "sales.order:read"]
    assert codes_of(role) == codes
  end

  test "目标为空列表时清空目录内具体码" do
    role = role!()
    grant!(role, "sales.order:read")

    assert {:ok, []} = sync(role, [])
    assert codes_of(role) == []
  end

  test "存量通配码原样保留" do
    role = role!()
    grant!(role, "sales.*")
    grant!(role, "*")
    grant!(role, "sales.order:read")

    assert {:ok, codes} = sync(role, ["base.company:read"])

    assert codes == ["*", "base.company:read", "sales.*"]
    assert codes_of(role) == codes
  end

  test "目录外存量码原样保留" do
    role = role!()
    grant!(role, "legacy.thing:read")
    grant!(role, "sales.order:read")

    assert {:ok, codes} = sync(role, [])

    assert codes == ["legacy.thing:read"]
    assert codes_of(role) == codes
  end

  test "目标码不在目录内则整笔报错且不落库" do
    role = role!()
    grant!(role, "sales.order:read")

    assert {:error, error} = sync(role, ["sales.order:read", "sales.order:frobnicate"])
    assert Exception.message(error) =~ "frobnicate"

    assert codes_of(role) == ["sales.order:read"]
  end

  test "内置角色拒绝同步" do
    role = Role |> Ash.Query.filter(code == "admin") |> Ash.read_one!(authorize?: false)

    assert {:error, error} = sync(role, ["sales.order:read"])
    assert Exception.message(error) =~ "内置角色"

    assert codes_of(role) == ["*"]
  end

  test "同步幂等:目标与存量一致时不增不删" do
    role = role!()
    grant!(role, "sales.order:read")
    grant!(role, "sales.*")

    assert {:ok, codes} = sync(role, ["sales.order:read"])

    assert codes == ["sales.*", "sales.order:read"]
    assert codes_of(role) == codes
  end
end
