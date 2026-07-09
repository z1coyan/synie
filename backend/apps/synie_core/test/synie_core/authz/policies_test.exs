defmodule SynieCore.Authz.PoliciesTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Authz.Role

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp actor_with(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  test "无 actor 读取被拒绝" do
    assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Role, actor: nil)
  end

  test "无对应权限的 actor 被拒绝" do
    actor = actor_with(["base.company:read"])

    assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Role, actor: actor)
  end

  test "拥有 sys.role:read 可读取角色" do
    actor = actor_with(["sys.role:read"])

    assert {:ok, _roles} = Ash.read(Role, actor: actor)
  end

  test "域通配 sys.* 覆盖角色读取" do
    actor = actor_with(["sys.*"])

    assert {:ok, _roles} = Ash.read(Role, actor: actor)
  end

  test "拥有 sys.role:create 可建角色,无权限不可" do
    can = actor_with(["sys.role:create"])
    cannot = actor_with(["sys.role:read"])

    assert {:ok, _} =
             Role
             |> Ash.Changeset.for_create(
               :create,
               %{code: "r_#{System.unique_integer([:positive])}", name: "新角色"},
               actor: can
             )
             |> Ash.create()

    assert {:error, %Ash.Error.Forbidden{}} =
             Role
             |> Ash.Changeset.for_create(
               :create,
               %{code: "r_#{System.unique_integer([:positive])}", name: "新角色"},
               actor: cannot
             )
             |> Ash.create()
  end

  test "destroy 动作映射为 delete 权限码" do
    actor = actor_with(["sys.role:read", "sys.role:delete"])
    role = role!()

    assert :ok = role |> Ash.Changeset.for_destroy(:destroy, %{}, actor: actor) |> Ash.destroy()
  end

  test "超级管理员绕过全部策略" do
    user = user!()

    super_admin =
      user
      |> Ash.Changeset.for_update(:set_super_admin, %{})
      |> Ash.update!(authorize?: false)
      |> Authz.build_actor()

    assert {:ok, _} = Ash.read(Role, actor: super_admin)
  end
end
