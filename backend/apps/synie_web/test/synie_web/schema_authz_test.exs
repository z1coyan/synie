defmodule SynieWeb.SchemaAuthzTest do
  use ExUnit.Case, async: true

  alias SynieCore.Accounts.User
  alias SynieCore.Authz
  alias SynieCore.Authz.{Role, RolePermission, UserRole}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  # synie_core 的 test/support 不跨应用共享,这里内联最小夹具
  defp user_with!(permissions) do
    user =
      User
      |> Ash.Changeset.for_create(:create, %{
        username: "u_#{System.unique_integer([:positive])}",
        password: "secret123"
      })
      |> Ash.create!(authorize?: false)

    role =
      Role
      |> Ash.Changeset.for_create(:create, %{
        code: "r_#{System.unique_integer([:positive])}",
        name: "角色"
      })
      |> Ash.create!(authorize?: false)

    Enum.each(permissions, fn code ->
      RolePermission
      |> Ash.Changeset.for_create(:create, %{role_id: role.id, permission: code})
      |> Ash.create!(authorize?: false)
    end)

    UserRole
    |> Ash.Changeset.for_create(:create, %{user_id: user.id, role_id: role.id})
    |> Ash.create!(authorize?: false)

    user
  end

  defp run!(doc, actor) do
    {:ok, result} = Absinthe.run(doc, SynieWeb.Schema, context: %{actor: actor})
    result
  end

  test "无 sys.role:read 权限查询 sysRoles 报错" do
    actor = Authz.build_actor(user_with!([]))

    result = run!("query { sysRoles { results { id } } }", actor)

    assert result[:errors] != nil and result[:errors] != []
  end

  test "拥有 sys.role:read 可查询 sysRoles" do
    actor = Authz.build_actor(user_with!(["sys.role:read"]))

    result = run!("query { sysRoles { results { id code } } }", actor)

    assert %{data: %{"sysRoles" => %{"results" => roles}}} = result
    assert is_list(roles) and roles != []
  end

  test "拥有 sys.role:create 可通过 mutation 建角色" do
    actor = Authz.build_actor(user_with!(["sys.role:create"]))

    result =
      run!(
        ~s|mutation { createSysRole(input: {code: "gql_role", name: "GQL角色"}) { result { id code } errors { message } } }|,
        actor
      )

    assert %{data: %{"createSysRole" => %{"result" => %{"code" => "gql_role"}}}} = result
  end

  test "myPermissions 返回展开后的具体权限码" do
    actor = Authz.build_actor(user_with!(["sys.role:*"]))

    result = run!("query { myPermissions }", actor)

    assert %{data: %{"myPermissions" => codes}} = result
    assert "sys.role:read" in codes
    assert "sys.role:delete" in codes
    refute "base.company:read" in codes
  end

  test "未登录 myPermissions 返回空列表" do
    result = run!("query { myPermissions }", nil)

    assert %{data: %{"myPermissions" => []}} = result
  end

  test "permissionCatalog 返回权限组" do
    actor = Authz.build_actor(user_with!([]))

    result = run!("query { permissionCatalog { prefix label actions } }", actor)

    assert %{data: %{"permissionCatalog" => groups}} = result
    assert Enum.any?(groups, &(&1["prefix"] == "sys.role" and &1["label"] == "角色"))
  end

  test "syncSysRolePermissions 整组同步授权" do
    actor =
      Authz.build_actor(user_with!(["sys.role_permission:create", "sys.role_permission:delete"]))

    role =
      Role
      |> Ash.Changeset.for_create(:create, %{
        code: "r_#{System.unique_integer([:positive])}",
        name: "角色"
      })
      |> Ash.create!(authorize?: false)

    doc =
      ~s|mutation { syncSysRolePermissions(roleId: "#{role.id}", permissions: ["sales.order:read", "base.company:read"]) }|

    result = run!(doc, actor)

    assert %{data: %{"syncSysRolePermissions" => codes}} = result
    assert Enum.sort(codes) == ["base.company:read", "sales.order:read"]
  end

  test "syncSysRolePermissions 无权限报错" do
    actor = Authz.build_actor(user_with!([]))

    role =
      Role
      |> Ash.Changeset.for_create(:create, %{
        code: "r_#{System.unique_integer([:positive])}",
        name: "角色"
      })
      |> Ash.create!(authorize?: false)

    doc =
      ~s|mutation { syncSysRolePermissions(roleId: "#{role.id}", permissions: ["sales.order:read"]) }|

    result = run!(doc, actor)

    assert result[:errors] != nil and result[:errors] != []
  end
end
