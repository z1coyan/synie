defmodule SynieWeb.PrintControllerTest do
  use ExUnit.Case, async: true

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.{Role, RolePermission, UserRole}

  @endpoint SynieWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    :ok
  end

  describe "GET /api/print/field-catalog" do
    test "有模板管理读权限，任意权限目录资源返回 {fields, loops} 派生清单" do
      conn =
        authed_get("/api/print/field-catalog", %{"resource" => "mfg.bom"}, [
          "sys.print_template:read"
        ])

      assert %{"fields" => fields, "loops" => loops} = json_response(conn, 200)

      head_names = Enum.map(fields, & &1["name"])
      assert "material.name" in head_names
      assert "material.code" in head_names
      refute "material_id" in head_names

      loop_names = Enum.map(loops, & &1["name"])
      assert "components" in loop_names
      assert "routes" in loop_names
      assert "byproducts" in loop_names

      components = Enum.find(loops, &(&1["name"] == "components"))
      component_fields = Enum.map(components["fields"], & &1["name"])
      assert "quantity" in component_fields
      assert "material.name" in component_fields
    end

    test "无 has_many 资源 loops 为空（如物料）" do
      conn =
        authed_get("/api/print/field-catalog", %{"resource" => "inv.material"}, [
          "sys.print_template:read"
        ])

      assert %{"fields" => fields, "loops" => loops} = json_response(conn, 200)
      assert is_list(loops)

      names = Enum.map(fields, & &1["name"])
      assert "code" in names
      assert "name" in names
      assert "category.name" in names
      assert "default_unit.name" in names
    end

    test "仅该资源打印权限（无模板管理权限）也可查看字段清单" do
      conn =
        authed_get("/api/print/field-catalog", %{"resource" => "mfg.bom"}, ["mfg.bom:print"])

      assert %{"fields" => _fields, "loops" => _loops} = json_response(conn, 200)
    end

    test "未知资源 404" do
      conn =
        authed_get("/api/print/field-catalog", %{"resource" => "nope.res"}, [
          "sys.print_template:read"
        ])

      assert json_response(conn, 404)
    end

    test "未登录 401" do
      conn = get(build_conn(), "/api/print/field-catalog", %{"resource" => "mfg.bom"})
      assert json_response(conn, 401)
    end

    test "登录但零权限 403（无模板管理权限也无该资源打印类权限）" do
      conn = authed_get("/api/print/field-catalog", %{"resource" => "mfg.bom"}, [])
      assert json_response(conn, 403)
    end
  end

  describe "GET /api/print/templates" do
    test "登录但零权限 403" do
      conn = authed_get("/api/print/templates", %{"resource" => "sales.order"}, [])
      assert json_response(conn, 403)
    end

    test "仅该资源打印权限（无模板管理权限）200，空列表也算" do
      conn =
        authed_get("/api/print/templates", %{"resource" => "sales.order"}, ["sales.order:print"])

      assert %{"templates" => templates} = json_response(conn, 200)
      assert is_list(templates)
    end
  end

  defp authed_get(path, params, permissions) do
    build_conn()
    |> put_req_header("authorization", "Bearer " <> token_with!(permissions))
    |> get(path, params)
  end

  # synie_core 的 test/support 不跨应用共享,内联最小夹具(与 file_controller_test 同款)
  defp token_with!(permissions) do
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

    SynieWeb.Auth.sign_token(user)
  end
end
