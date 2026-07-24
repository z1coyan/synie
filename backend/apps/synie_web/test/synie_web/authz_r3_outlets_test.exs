defmodule SynieWeb.AuthzR3OutletsTest do
  @moduledoc """
  R3 出口场景集(authz-e2e 工单08):两个绕开 GraphQL 的 REST 数据出口——
  文件补挂(`POST /api/files/:id/attachments`)与打印导出(`POST /api/print`)
  ——的越权定向断言。历史上真实出过修复的高危面(#41 打印/文件出口审计),
  本套件为其上回归保险。全部走真实 HTTP 管线(带 Bearer token)。

  ## 与既有测试的分工

  裸文件下载(上传者/他人/超管)与附件下载(跨公司/无宿主码/有码同司正向)
  已由 `SynieWeb.FileControllerTest` 的「GET /api/files/:id 宿主可见性授权」
  全覆盖(#41 修复的回归网),本套件不重复,只补两处 #41 网未覆盖的出口:

  - **补挂**(attach endpoint):非上传者本人把裸文件挂宿主被拒(洗白越权下载);
  - **打印导出**(print endpoint):跨公司单据 / 无 print/export 码 / 可打印清单外
    资源被拒,有码本司成功产出二进制(正向对照)。

  ## 夹具

  复用双公司世界(`World.build!`)取:公司甲/乙、可打印的销售订单(已审核含明细,
  两司各一张)、销售订单打印模板、公司甲的总账凭证(补挂宿主)。主体 token 经
  `Subjects.token!` 合成。Sandbox 皱褶同读写矩阵(shared owner + async: false)。
  """

  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]

  alias SynieWeb.AuthzMatrix.{Subjects, World}

  @endpoint SynieWeb.Endpoint

  setup_all do
    owner = Ecto.Adapters.SQL.Sandbox.start_owner!(SynieCore.Repo, shared: true)
    world = World.build!()

    # 上传源:小文件(REST multipart 需真实落盘临时文件)
    src = Path.join(world.storage_root, "r3_src.bin")
    File.write!(src, "R3 出口字节")

    on_exit(fn ->
      File.rm_rf!(world.storage_root)
      Ecto.Adapters.SQL.Sandbox.stop_owner(owner)
      Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, :manual)
    end)

    order_a =
      Enum.find(world.records[SynieCore.Sales.Order], &(&1.company_id == world.company_a.id))

    order_b =
      Enum.find(world.records[SynieCore.Sales.Order], &(&1.company_id == world.company_b.id))

    [template] = world.records[SynieCore.Printing.Template]

    journal_a =
      Enum.find(world.records[SynieCore.Acc.GlJournal], &(&1.company_id == world.company_a.id))

    %{
      world: world,
      src: src,
      order_a: order_a,
      order_b: order_b,
      template: template,
      journal_a: journal_a
    }
  end

  # ── 补挂:非上传者不得把裸文件挂到宿主(否则=洗白越权下载)────────────────────

  describe "POST /api/files/:id/attachments 补挂授权" do
    test "非上传者本人补挂裸文件被拒(403 仅能挂接本人上传的文件)", ctx do
      %{world: world, src: src, journal_a: journal_a} = ctx

      # 上传者 X 传一个裸文件(无宿主)
      uploader = Subjects.token!(["sys.file:create"], companies: [world.company_a.id])
      file_id = upload_bare!(uploader, src)

      # 另一用户 Y(能读文件、能读宿主、同公司)——唯一差别是「不是上传者」
      other =
        Subjects.token!(["sys.file:read", "acc.gl_journal:read", "sys.file:create"],
          companies: [world.company_a.id]
        )

      resp =
        build_conn()
        |> put_req_header("authorization", "Bearer " <> other)
        |> post("/api/files/#{file_id}/attachments", %{
          "owner_type" => "acc_gl_journal",
          "owner_id" => journal_a.id
        })

      assert json_response(resp, 403)
    end

    test "上传者本人补挂裸文件成功(正向对照,证明拒因是上传者身份而非别的)", ctx do
      %{world: world, src: src, journal_a: journal_a} = ctx

      uploader =
        Subjects.token!(["sys.file:create", "sys.file:read", "acc.gl_journal:read"],
          companies: [world.company_a.id]
        )

      file_id = upload_bare!(uploader, src)

      resp =
        build_conn()
        |> put_req_header("authorization", "Bearer " <> uploader)
        |> post("/api/files/#{file_id}/attachments", %{
          "owner_type" => "acc_gl_journal",
          "owner_id" => journal_a.id
        })

      assert %{"attachment" => %{"ownerId" => owner_id}} = json_response(resp, 200)
      assert owner_id == journal_a.id
    end
  end

  # ── 打印导出:批量二进制出口不得绕过数据权限/功能权限/清单边界 ──────────────

  describe "POST /api/print 打印导出授权" do
    test "有 export 码 + 本司:导出成功产出 xlsx 二进制(正向对照)", ctx do
      %{world: world, order_a: order_a, template: template} = ctx

      token =
        Subjects.token!(["sales.order:read", "sales.order:export"],
          companies: [world.company_a.id]
        )

      resp = print_req(token, "sales.order", [order_a.id], template.id, "export")

      assert resp.status == 200
      assert byte_size(resp.resp_body) > 0
      [ctype] = Plug.Conn.get_resp_header(resp, "content-type")
      assert ctype =~ "spreadsheetml"
    end

    test "跨公司单据被拒:授甲主体导出乙司订单 → 拒(单据不可见)", ctx do
      %{world: world, order_b: order_b, template: template} = ctx

      token =
        Subjects.token!(["sales.order:read", "sales.order:export"],
          companies: [world.company_a.id]
        )

      resp = print_req(token, "sales.order", [order_b.id], template.id, "export")

      # 跨公司记录经 actor 授权读取时不可见 → load_records 失败 → 422(非 200 二进制)
      assert resp.status == 422
      assert %{"error" => _} = Jason.decode!(resp.resp_body)
    end

    test "无 export 码被拒:仅有 read 码 → 403", ctx do
      %{world: world, order_a: order_a, template: template} = ctx

      token = Subjects.token!(["sales.order:read"], companies: [world.company_a.id])
      resp = print_req(token, "sales.order", [order_a.id], template.id, "export")

      assert resp.status == 403
    end

    test "无 print 码被拒:仅有 read 码 → 403(单条打印门)", ctx do
      %{world: world, order_a: order_a, template: template} = ctx

      token = Subjects.token!(["sales.order:read"], companies: [world.company_a.id])
      resp = print_req(token, "sales.order", [order_a.id], template.id, "print")

      assert resp.status == 403
    end

    test "可打印清单外资源被拒:反射面不被扩大 → 422", ctx do
      %{world: world, template: template} = ctx

      token =
        Subjects.token!(["sales.order:read", "sales.order:export"],
          companies: [world.company_a.id]
        )

      resp = print_req(token, "bogus.resource", [Ash.UUID.generate()], template.id, "export")

      assert resp.status == 422
      assert %{"error" => msg} = Jason.decode!(resp.resp_body)
      assert msg =~ "不支持的资源类型"
    end

    test "未登录被拒:无 token → 401", ctx do
      %{order_a: order_a, template: template} = ctx

      resp =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post(
          "/api/print",
          Jason.encode!(%{
            "resource" => "sales.order",
            "ids" => [order_a.id],
            "template_id" => template.id,
            "mode" => "export"
          })
        )

      assert resp.status == 401
    end
  end

  # ── 载具 ──────────────────────────────────────────────────────────────────

  defp upload_bare!(token, src) do
    upload = %Plug.Upload{path: src, filename: "r3.bin", content_type: "application/octet-stream"}

    %{"file" => %{"id" => id}} =
      build_conn()
      |> put_req_header("authorization", "Bearer " <> token)
      |> post("/api/files", %{"file" => upload})
      |> json_response(200)

    id
  end

  defp print_req(token, resource, ids, template_id, mode) do
    build_conn()
    |> put_req_header("authorization", "Bearer " <> token)
    |> put_req_header("content-type", "application/json")
    |> post(
      "/api/print",
      Jason.encode!(%{
        "resource" => resource,
        "ids" => ids,
        "template_id" => template_id,
        "mode" => mode
      })
    )
  end
end
