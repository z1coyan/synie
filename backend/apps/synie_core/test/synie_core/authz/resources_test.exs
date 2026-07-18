defmodule SynieCore.Authz.ResourcesTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  require Ash.Query

  alias SynieCore.Authz.{Role, RolePermission}

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

    assert SynieCore.Authz.Role.permission_actions() ==
             ~w(create read update delete batch_delete export print batch_print)

    # UserRole 复用 sys.user 权限码,不设独立权限点
    assert SynieCore.Authz.UserRole.permission_prefix() == "sys.user"
    assert SynieCore.Authz.UserRole.permission_actions() == []
    assert SynieCore.Authz.RolePermission.permission_prefix() == "sys.role_permission"
  end

  test "内置 admin 角色随迁移种子,持全域通配 * 授权" do
    role = Role |> Ash.Query.filter(code == "admin") |> Ash.read_one!(authorize?: false)

    assert role.builtin
    assert role.enabled

    grants =
      RolePermission |> Ash.Query.filter(role_id == ^role.id) |> Ash.read!(authorize?: false)

    assert Enum.map(grants, & &1.permission) == ["*"]
  end

  test "内置角色不可更新、不可删除,其授权不可增删" do
    role = Role |> Ash.Query.filter(code == "admin") |> Ash.read_one!(authorize?: false)

    assert {:error, _} =
             role
             |> Ash.Changeset.for_update(:update, %{enabled: false})
             |> Ash.update(authorize?: false)

    assert {:error, _} =
             role
             |> Ash.Changeset.for_destroy(:destroy)
             |> Ash.destroy(authorize?: false)

    assert {:error, _} =
             RolePermission
             |> Ash.Changeset.for_create(:create, %{role_id: role.id, permission: "sales.*"})
             |> Ash.create(authorize?: false)

    grant =
      RolePermission |> Ash.Query.filter(role_id == ^role.id) |> Ash.read_one!(authorize?: false)

    assert {:error, _} =
             grant
             |> Ash.Changeset.for_destroy(:destroy)
             |> Ash.destroy(authorize?: false)
  end

  test "普通角色不受内置守卫影响" do
    role = role!()
    grant = grant!(role, "sales.*")

    assert {:ok, _} =
             role
             |> Ash.Changeset.for_update(:update, %{enabled: false})
             |> Ash.update(authorize?: false)

    assert :ok = grant |> Ash.Changeset.for_destroy(:destroy) |> Ash.destroy(authorize?: false)
  end
end
