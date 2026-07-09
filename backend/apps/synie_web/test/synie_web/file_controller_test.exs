defmodule SynieWeb.FileControllerTest do
  # 改全局 storage 配置,不能 async
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.{Role, RolePermission, UserRole}

  @endpoint SynieWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_upload_test_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "发票.pdf")
    File.write!(src, "PDF 字节")

    old_storages = Application.fetch_env(:synie_core, :storages)
    old_default = Application.fetch_env(:synie_core, :default_storage)

    Application.put_env(:synie_core, :storages,
      test_local: %{adapter: SynieCore.Storage.Local, root: root}
    )

    Application.put_env(:synie_core, :default_storage, :test_local)

    on_exit(fn ->
      File.rm_rf!(base)

      restore = fn key, old ->
        case old do
          {:ok, v} -> Application.put_env(:synie_core, key, v)
          :error -> Application.delete_env(:synie_core, key)
        end
      end

      restore.(:storages, old_storages)
      restore.(:default_storage, old_default)
    end)

    %{src: src}
  end

  # synie_core 的 test/support 不跨应用共享,内联最小夹具(与 schema_user_test 同款)
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

  defp upload_conn(token, params) do
    build_conn()
    |> put_req_header("authorization", "Bearer " <> token)
    |> post("/api/files", params)
  end

  defp upload_struct(src) do
    %Plug.Upload{path: src, filename: "发票.pdf", content_type: "application/pdf"}
  end

  describe "POST /api/files" do
    test "有权上传:返回文件元数据", %{src: src} do
      token = token_with!(["sys.file:create"])

      resp = upload_conn(token, %{"file" => upload_struct(src)}) |> json_response(200)

      assert %{"file" => file, "attachment" => nil} = resp
      assert file["filename"] == "发票.pdf"
      assert file["contentType"] == "application/pdf"
      assert file["size"] == byte_size("PDF 字节")
      assert file["id"]
    end

    test "带 owner 参数:同时返回附件关联", %{src: src} do
      token = token_with!(["sys.file:create"])
      owner_id = Ash.UUID.generate()

      resp =
        upload_conn(token, %{
          "file" => upload_struct(src),
          "owner_type" => "sal_customer",
          "owner_id" => owner_id,
          "category" => "contract"
        })
        |> json_response(200)

      assert %{"attachment" => %{"ownerId" => ^owner_id, "category" => "contract"}} = resp
    end

    test "未登录:401", %{src: src} do
      conn = build_conn() |> post("/api/files", %{"file" => upload_struct(src)})
      assert json_response(conn, 401)
    end

    test "无 sys.file:create:403", %{src: src} do
      token = token_with!(["sys.file:read"])
      conn = upload_conn(token, %{"file" => upload_struct(src)})
      assert json_response(conn, 403)
    end

    test "缺 file 字段:400" do
      token = token_with!(["sys.file:create"])
      conn = upload_conn(token, %{})
      assert json_response(conn, 400)
    end
  end

  describe "GET /api/files/:id" do
    setup %{src: src} do
      token = token_with!(["sys.file:create", "sys.file:read"])

      %{"file" => %{"id" => id}} =
        upload_conn(token, %{"file" => upload_struct(src)}) |> json_response(200)

      %{token: token, file_id: id}
    end

    test "有权下载:返回原字节与元信息头", %{token: token, file_id: id} do
      conn =
        build_conn()
        |> put_req_header("authorization", "Bearer " <> token)
        |> get("/api/files/#{id}")

      assert response(conn, 200) == "PDF 字节"
      assert response_content_type(conn, :pdf)
      [disposition] = Plug.Conn.get_resp_header(conn, "content-disposition")
      assert disposition =~ "attachment"
      assert disposition =~ URI.encode("发票.pdf", &URI.char_unreserved?/1)
    end

    test "无 sys.file:read:403", %{file_id: id} do
      token = token_with!(["sys.file:create"])

      conn =
        build_conn()
        |> put_req_header("authorization", "Bearer " <> token)
        |> get("/api/files/#{id}")

      assert json_response(conn, 403)
    end

    test "未登录:401", %{file_id: id} do
      conn = build_conn() |> get("/api/files/#{id}")
      assert json_response(conn, 401)
    end

    test "不存在:404", %{token: token} do
      conn =
        build_conn()
        |> put_req_header("authorization", "Bearer " <> token)
        |> get("/api/files/#{Ash.UUID.generate()}")

      assert json_response(conn, 404)
    end
  end
end
