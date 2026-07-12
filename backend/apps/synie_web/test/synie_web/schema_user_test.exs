defmodule SynieWeb.SchemaUserTest do
  use ExUnit.Case, async: true

  alias SynieCore.Accounts
  alias SynieCore.Accounts.User
  alias SynieCore.Authz
  alias SynieCore.Authz.{Role, RolePermission, UserRole}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  # synie_core 的 test/support 不跨应用共享,内联最小夹具(与 schema_grid_test 同款)
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
        name: "夹具角色"
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

  defp create_doc(username) do
    """
    mutation { createSysUser(username: "#{username}", name: "测试用户") { id username password } }
    """
  end

  describe "createSysUser" do
    test "有 create 权限:创建成功,明文密码仅随响应返回一次且可登录" do
      actor = Authz.build_actor(user_with!(["sys.user:create"]))
      username = "nu_#{System.unique_integer([:positive])}"

      assert %{data: %{"createSysUser" => %{"password" => password, "username" => ^username}}} =
               run!(create_doc(username), actor)

      # 库里只有哈希,明文可认证
      assert {:ok, user} = Accounts.authenticate(username, password)
      assert String.starts_with?(user.hashed_password, "$pbkdf2-")
      refute user.hashed_password == password
    end

    test "无 create 权限:拒绝" do
      actor = Authz.build_actor(user_with!(["sys.user:read"]))
      result = run!(create_doc("nu_#{System.unique_integer([:positive])}"), actor)
      assert result[:errors] != nil and result[:errors] != []
    end
  end

  describe "resetSysUserPassword" do
    test "有 update 权限:旧密码失效,新密码可登录" do
      actor = Authz.build_actor(user_with!(["sys.user:read", "sys.user:update"]))

      target =
        User
        |> Ash.Changeset.for_create(:create, %{
          username: "rt_#{System.unique_integer([:positive])}",
          password: "oldpass123"
        })
        |> Ash.create!(authorize?: false)

      doc = """
      mutation { resetSysUserPassword(id: "#{target.id}") { password } }
      """

      assert %{data: %{"resetSysUserPassword" => %{"password" => password}}} = run!(doc, actor)

      assert {:error, :invalid_credentials} =
               Accounts.authenticate(to_string(target.username), "oldpass123")

      assert {:ok, _} = Accounts.authenticate(to_string(target.username), password)
    end

    test "仅 read 权限:拒绝" do
      actor = Authz.build_actor(user_with!(["sys.user:read"]))

      target =
        User
        |> Ash.Changeset.for_create(:create, %{
          username: "rt_#{System.unique_integer([:positive])}",
          password: "oldpass123"
        })
        |> Ash.create!(authorize?: false)

      doc = """
      mutation { resetSysUserPassword(id: "#{target.id}") { password } }
      """

      result = run!(doc, actor)
      assert result[:errors] != nil and result[:errors] != []
      assert {:ok, _} = Accounts.authenticate(to_string(target.username), "oldpass123")
    end
  end
end
