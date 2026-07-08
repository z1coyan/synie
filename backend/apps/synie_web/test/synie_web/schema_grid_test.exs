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

  defp super_actor do
    %Authz.Actor{
      user_id: Ash.UUID.generate(),
      username: "root",
      super_admin: true,
      all_companies: true,
      permissions: MapSet.new(),
      company_ids: []
    }
  end

  # 注意:defp 与模块属性放 describe 外(ExUnit 不允许在 describe 内定义函数)
  @meta_query """
  query ($resource: String!) {
    gridMeta(resource: $resource) {
      columns { name type label sortable filterable enumOptions { value label } }
      capabilities
      extendedActions { key label scope mutation isDanger }
      destroyMutation
    }
  }
  """

  defp run_meta!(actor, resource \\ "sysRoles") do
    {:ok, result} =
      Absinthe.run(@meta_query, SynieWeb.Schema,
        context: %{actor: actor},
        variables: %{"resource" => resource}
      )

    result
  end

  describe "gridMeta" do
    test "反射 Role 列定义(名称/类型/中文标签)" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor())

      by_name = Map.new(meta["columns"], &{&1["name"], &1})
      assert %{"type" => "string", "label" => "角色编码"} = by_name["code"]
      assert %{"type" => "boolean", "label" => "启用"} = by_name["enabled"]
      assert %{"type" => "datetime", "label" => "创建时间"} = by_name["insertedAt"]
      assert by_name["id"]["type"] == "string"
    end

    test "super_admin 拿到全部能力(不含 read),destroyMutation 正确" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor())

      assert Enum.sort(meta["capabilities"]) == ["create", "delete", "update"]
      refute "read" in meta["capabilities"]
      assert meta["destroyMutation"] == "destroySysRole"
      assert meta["extendedActions"] == []
    end

    test "capabilities 随授权变化" do
      no_perm = Authz.build_actor(user_with!([]))
      assert %{data: %{"gridMeta" => %{"capabilities" => []}}} = run_meta!(no_perm)

      update_only = Authz.build_actor(user_with!(["sys.role:update"]))
      assert %{data: %{"gridMeta" => %{"capabilities" => ["update"]}}} = run_meta!(update_only)
    end

    test "未登录 actor 能力为空但列可见" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(nil)
      assert meta["capabilities"] == []
      assert meta["columns"] != []
    end

    test "白名单外资源报错" do
      result = run_meta!(super_actor(), "sysUsers")
      assert result[:errors] != nil and result[:errors] != []
    end

    test "白名单资源的 grid_actions 与权限动作、schema mutation 一致" do
      mutation_fields =
        Absinthe.Schema.lookup_type(SynieWeb.Schema, :mutation).fields
        |> Map.keys()
        |> Enum.map(&Absinthe.Utils.camelize(to_string(&1), lower: true))

      for {_name, module} <- SynieWeb.GridMeta.resources(),
          function_exported?(module, :grid_actions, 0),
          action <- module.grid_actions() do
        assert action.key in module.permission_actions(),
               "#{inspect(module)} 的扩展动作 #{action.key} 未声明在 permission_actions/0"

        assert action.mutation in mutation_fields,
               "#{inspect(module)} 的扩展动作 mutation #{action.mutation} 不存在于 schema"
      end
    end
  end
end
