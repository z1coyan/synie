defmodule SynieWeb.SchemaGridTest do
  use ExUnit.Case, async: true

  alias SynieCore.Accounts.User
  alias SynieCore.Authz
  alias SynieCore.Authz.{Role, RolePermission, UserRole}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  # synie_core 的 test/support 不跨应用共享,内联最小夹具(与 schema_authz_test 同款)
  defp user_with!(permissions) do
    user =
      User
      |> Ash.Changeset.for_create(:register, %{
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

  defp roles!(specs) do
    Enum.map(specs, fn {code, name, enabled} ->
      Role
      |> Ash.Changeset.for_create(:create, %{code: code, name: name, enabled: enabled})
      |> Ash.create!(authorize?: false)
    end)
  end

  defp run!(doc, actor) do
    {:ok, result} = Absinthe.run(doc, SynieWeb.Schema, context: %{actor: actor})
    result
  end

  describe "sysRoles offset 分页" do
    test "返回 count 与 results,limit/offset 生效" do
      roles!([{"pg1", "分页一", true}, {"pg2", "分页二", true}, {"pg3", "分页三", true}])
      actor = Authz.build_actor(user_with!(["sys.role:read"]))

      result =
        run!(
          "query { sysRoles(limit: 2, offset: 0, sort: [{field: CODE, order: ASC}]) { count results { code } } }",
          actor
        )

      assert %{data: %{"sysRoles" => %{"count" => count, "results" => rows}}} = result
      assert count >= 3
      assert length(rows) == 2
    end

    test "filter:字符串 contains 与布尔 eq" do
      roles!([{"ft1", "采购管理员", true}, {"ft2", "采购只读", false}, {"ft3", "销售", true}])
      actor = Authz.build_actor(user_with!(["sys.role:read"]))

      result =
        run!(
          ~s|query { sysRoles(filter: {name: {contains: "采购"}, enabled: {eq: true}}) { results { code } } }|,
          actor
        )

      assert %{data: %{"sysRoles" => %{"results" => rows}}} = result
      codes = Enum.map(rows, & &1["code"])
      assert "ft1" in codes
      refute "ft2" in codes
      refute "ft3" in codes
    end

    test "sort DESC 生效" do
      roles!([{"srt_a", "甲", true}, {"srt_b", "乙", true}])
      actor = Authz.build_actor(user_with!(["sys.role:read"]))

      result =
        run!(
          ~s|query { sysRoles(filter: {code: {contains: "srt_"}}, sort: [{field: CODE, order: DESC}]) { results { code } } }|,
          actor
        )

      assert %{
               data: %{"sysRoles" => %{"results" => [%{"code" => "srt_b"}, %{"code" => "srt_a"}]}}
             } =
               result
    end

    test "datetime 列可查询" do
      roles!([{"ts1", "带时间戳", true}])
      actor = Authz.build_actor(user_with!(["sys.role:read"]))

      result =
        run!(
          ~s|query { sysRoles(filter: {code: {eq: "ts1"}}) { results { code insertedAt updatedAt } } }|,
          actor
        )

      assert %{data: %{"sysRoles" => %{"results" => [row]}}} = result
      assert is_binary(row["insertedAt"])
    end
  end

  describe "destroySysRole 权限两分支" do
    test "无 sys.role:delete 被 policy 拒绝" do
      [role] = roles!([{"del_deny", "待删", true}])
      actor = Authz.build_actor(user_with!(["sys.role:read"]))

      result =
        run!(~s|mutation { destroySysRole(id: "#{role.id}") { errors { message } } }|, actor)

      # AshGraphql 的 policy 拒绝落在 data.errors 或顶层 errors,两者任一即可
      errors = get_in(result, [:data, "destroySysRole", "errors"]) || result[:errors]
      assert errors != nil and errors != []
    end

    test "拥有 sys.role:delete 可删除" do
      [role] = roles!([{"del_ok", "待删", true}])
      actor = Authz.build_actor(user_with!(["sys.role:read", "sys.role:delete"]))

      result =
        run!(
          ~s|mutation { destroySysRole(id: "#{role.id}") { result { id } errors { message } } }|,
          actor
        )

      assert %{data: %{"destroySysRole" => %{"result" => %{"id" => _}}}} = result
    end
  end
end
