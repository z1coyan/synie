defmodule SynieCore.Authz.ResourcesTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "创建角色、授权、指派用户" do
    user = user!()
    role = role!(%{code: "sales_clerk", name: "销售员"})
    grant!(role, "sales.order:read")
    grant!(role, "sales.order:create")
    assign!(user, role)

    assert role.enabled
    assert to_string(role.code) == "sales_clerk"
  end

  test "角色 code 唯一" do
    role!(%{code: "dup_role"})

    assert_raise Ash.Error.Invalid, fn ->
      role!(%{code: "dup_role"})
    end
  end

  test "同一用户不能重复指派同一角色" do
    user = user!()
    role = role!()
    assign!(user, role)

    assert_raise Ash.Error.Invalid, fn ->
      assign!(user, role)
    end
  end

  test "同一角色不能重复授予同一权限码" do
    role = role!()
    grant!(role, "sys.role:read")

    assert_raise Ash.Error.Invalid, fn ->
      grant!(role, "sys.role:read")
    end
  end

  test "新用户默认不是超级管理员" do
    user = user!()
    refute user.super_admin
    refute user.all_companies
  end

  test "set_super_admin 动作" do
    user = user!()

    updated =
      user
      |> Ash.Changeset.for_update(:set_super_admin, %{})
      |> Ash.update!(authorize?: false)

    assert updated.super_admin
  end

  test "资源声明了权限前缀与动作集" do
    assert SynieCore.Authz.Role.permission_prefix() == "sys.role"
    assert SynieCore.Authz.Role.permission_actions() == ~w(create read update delete)
    assert SynieCore.Authz.UserRole.permission_prefix() == "sys.user_role"
    assert SynieCore.Authz.RolePermission.permission_prefix() == "sys.role_permission"
  end
end
