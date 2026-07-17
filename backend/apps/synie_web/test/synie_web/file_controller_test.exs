defmodule SynieWeb.FileControllerTest do
  # 改全局 storage 配置,不能 async
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]

  alias SynieCore.Accounts.User
  alias SynieCore.Acc.GlJournal
  alias SynieCore.Authz.{Role, RolePermission, UserCompany, UserRole}
  alias SynieCore.Base.Company
  alias SynieCore.Sales.Customer

  @endpoint SynieWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_upload_test_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "发票.pdf")
    File.write!(src, "PDF 字节")

    SynieCore.Files.StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{
      name: "test_local",
      label: "测试本地",
      kind: :local,
      root: root
    })
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)

    on_exit(fn -> File.rm_rf!(base) end)

    %{src: src}
  end

  # synie_core 的 test/support 不跨应用共享,内联最小夹具(与 schema_user_test 同款)
  # opts: :companies(授权公司 id 列表)、:super_admin(布尔)
  defp token_with!(permissions, opts \\ []) do
    user =
      User
      |> Ash.Changeset.for_create(:create, %{
        username: "u_#{System.unique_integer([:positive])}",
        password: "secret123"
      })
      |> Ash.create!(authorize?: false)

    user =
      if opts[:super_admin] do
        user
        |> Ash.Changeset.for_update(:set_super_admin, %{})
        |> Ash.update!(authorize?: false)
      else
        user
      end

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

    for company_id <- Keyword.get(opts, :companies, []) do
      UserCompany
      |> Ash.Changeset.for_create(:create, %{user_id: user.id, company_id: company_id})
      |> Ash.create!(authorize?: false)
    end

    SynieWeb.Auth.sign_token(user)
  end

  defp company! do
    i = System.unique_integer([:positive])
    code = <<?a + rem(div(i, 26), 26), ?a + rem(i, 26)>>

    Company
    |> Ash.Changeset.for_create(:create, %{
      code: code,
      name: "测试公司",
      short_name: "测司",
      base_currency_id: base_currency_id!()
    })
    |> Ash.create!(authorize?: false)
  end

  # 公司本币必填;CNY 已由迁移种入,取或建(synie_web 用不到 synie_core 的测试夹具)
  defp base_currency_id! do
    case Ash.get(SynieCore.Base.Currency, %{iso_code: "CNY"}, authorize?: false, error?: false) do
      {:ok, %{id: id}} when is_binary(id) ->
        id

      _ ->
        SynieCore.Base.Currency
        |> Ash.Changeset.for_create(:create, %{name: "人民币", iso_code: "CNY", symbol: "￥"})
        |> Ash.create!(authorize?: false)
        |> Map.fetch!(:id)
    end
  end

  defp gl_journal!(company_id) do
    GlJournal
    |> Ash.Changeset.for_create(:create, %{
      company_id: company_id,
      voucher_no: "V#{System.unique_integer([:positive])}",
      date: Date.utc_today()
    })
    |> Ash.create!(authorize?: false)
  end

  defp customer! do
    Customer
    |> Ash.Changeset.for_create(:create, %{
      code: "C#{System.unique_integer([:positive])}",
      name: "测试客户"
    })
    |> Ash.create!(authorize?: false)
  end

  defp get_file(token, id) do
    build_conn()
    |> put_req_header("authorization", "Bearer " <> token)
    |> get("/api/files/#{id}")
  end

  # 上传一个挂到某公司凭证宿主的文件,返回 file id
  defp upload_attached_to(src, company_id) do
    host = gl_journal!(company_id)
    uploader = token_with!(["sys.file:create", "acc.gl_journal:read"], companies: [company_id])

    %{"file" => %{"id" => id}} =
      upload_conn(uploader, %{
        "file" => upload_struct(src),
        "owner_type" => "acc_gl_journal",
        "owner_id" => host.id
      })
      |> json_response(200)

    id
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
      # maybe_attach 现会用 actor 读宿主:真实客户 + sales.customer:read
      token = token_with!(["sys.file:create", "sales.customer:read"])
      customer = customer!()
      owner_id = customer.id

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

    test "未知 owner_type:422", %{src: src} do
      token = token_with!(["sys.file:create"])

      conn =
        upload_conn(token, %{
          "file" => upload_struct(src),
          "owner_type" => "not_a_resource",
          "owner_id" => Ash.UUID.generate()
        })

      assert json_response(conn, 422)
    end

    test "宿主 actor 看不见:403", %{src: src} do
      co_a = company!()
      co_b = company!()
      host_b = gl_journal!(co_b.id)
      token = token_with!(["sys.file:create", "acc.gl_journal:read"], companies: [co_a.id])

      conn =
        upload_conn(token, %{
          "file" => upload_struct(src),
          "owner_type" => "acc_gl_journal",
          "owner_id" => host_b.id
        })

      assert json_response(conn, 403)
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

  describe "GET /api/files/:id 宿主可见性授权" do
    test "跨公司下载被拒:A actor 下 B 公司凭证的文件 → 403", %{src: src} do
      co_a = company!()
      co_b = company!()
      file_id = upload_attached_to(src, co_b.id)

      # A 只有 sys.file:read + A 公司:能读文件行,但看不见 B 的附件
      token_a = token_with!(["sys.file:read"], companies: [co_a.id])
      assert json_response(get_file(token_a, file_id), 403)
    end

    test "同公司下载放行:B actor 下 B 公司凭证的文件 → 200", %{src: src} do
      co_b = company!()
      file_id = upload_attached_to(src, co_b.id)

      token_b = token_with!(["sys.file:read"], companies: [co_b.id])
      assert response(get_file(token_b, file_id), 200) == "PDF 字节"
    end

    test "裸文件:上传人可下 → 200", %{src: src} do
      uploader = token_with!(["sys.file:create", "sys.file:read"])

      %{"file" => %{"id" => id}} =
        upload_conn(uploader, %{"file" => upload_struct(src)}) |> json_response(200)

      assert response(get_file(uploader, id), 200) == "PDF 字节"
    end

    test "裸文件:非上传人(有 sys.file:read)也被拒 → 403", %{src: src} do
      uploader = token_with!(["sys.file:create", "sys.file:read"])

      %{"file" => %{"id" => id}} =
        upload_conn(uploader, %{"file" => upload_struct(src)}) |> json_response(200)

      other = token_with!(["sys.file:read"])
      assert json_response(get_file(other, id), 403)
    end

    test "裸文件:super_admin 可下 → 200", %{src: src} do
      uploader = token_with!(["sys.file:create", "sys.file:read"])

      %{"file" => %{"id" => id}} =
        upload_conn(uploader, %{"file" => upload_struct(src)}) |> json_response(200)

      admin = token_with!([], super_admin: true)
      assert response(get_file(admin, id), 200) == "PDF 字节"
    end
  end
end
