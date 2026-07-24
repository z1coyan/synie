defmodule SynieWeb.AuthzMatrixGridmetaTest do
  @moduledoc """
  R2 定点断言(authz-e2e 工单09):表格元数据反射的 fail-closed 降级。
  反射机制不得成为探测面或关联资源入口。

  与既有 `SynieWeb.SchemaGridTest`(直构 actor + Absinthe.run,机制级)互补:
  本模块用工单02的极值主体生成器(真实用户/角色/授权链 + 真实 Bearer token)
  经完整 HTTP 管线打 gridMeta——主体构法与权限码来源(权限目录反射)与矩阵同源。

  定点覆盖:
  1. 白名单外资源报错,且真实资源与虚构资源的错误形态一致(不泄露存在性差异);
  2. 无目标资源 read 码时,外键列不产出 ref、降级为普通列(不可筛);
  3. 多态外键变体按目标 read 权限逐个裁剪,全裁则整列降级;
  4. 能力清单随主体权限过滤(元数据侧正向对照)。
  """

  use ExUnit.Case, async: true

  alias SynieWeb.AuthzMatrix.{Gql, Subjects}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp meta_query(resource) do
    """
    query {
      gridMeta(resource: "#{resource}") {
        columns { name type filterable ref { resource relation variants { value resource } } }
        capabilities
      }
    }
    """
  end

  defp run_meta(token, resource), do: Gql.run(meta_query(resource), token)

  defp column(resp, name) do
    %{"data" => %{"gridMeta" => %{"columns" => columns}}} = resp
    Enum.find(columns, &(&1["name"] == name)) || flunk("gridMeta 未返回列 #{name}")
  end

  describe "白名单外资源(探测面)" do
    test "真实资源(白名单外)与纯虚构资源的报错形态一致,不泄露存在性" do
      token = Subjects.token!([], super_admin: true)

      # salSetting 是真实资源但不在 GridMeta 白名单;noSuchGrid 纯属虚构
      responses =
        for name <- ["salSetting", "noSuchGrid"] do
          resp = run_meta(token, name)

          assert resp["data"]["gridMeta"] == nil,
                 "白名单外资源 #{name} 不应返回元数据:#{inspect(resp)}"

          assert [%{"message" => message} | _] = resp["errors"],
                 "白名单外资源 #{name} 应报错:#{inspect(resp)}"

          # 报错必须只回显请求名,除名字外零差异——差异信息就是探测信号
          String.replace(message, name, "<资源名>")
        end

      assert [msg, msg] = responses,
             "真实资源与虚构资源的报错除回显名外应逐字一致(不泄露资源是否存在):#{inspect(responses)}"
    end
  end

  describe "外键引用 fail-closed(关联入口)" do
    test "无目标 read 码:fk 列降级为普通列,ref 不产出、不可筛" do
      token = Subjects.token!([])
      resp = run_meta(token, "basCompanies")
      parent = column(resp, "parentId")

      assert parent["ref"] == nil, "无 base.company:read 时 parentId 不应携带 ref:#{inspect(parent)}"
      assert parent["type"] == "string", "降级列应为普通 string 列:#{inspect(parent)}"
      refute parent["filterable"], "降级列不应开放筛选:#{inspect(parent)}"
    end

    test "有目标 read 码:fk 列携带 ref(正向对照)" do
      token = Subjects.token!([Subjects.action_code!("base.company", "read")])
      resp = run_meta(token, "basCompanies")
      parent = column(resp, "parentId")

      assert %{"resource" => "basCompanies", "relation" => "parent"} = parent["ref"]
      assert parent["type"] == "fk"
    end
  end

  describe "多态外键变体裁剪" do
    test "仅剩持 read 码的变体;全无则整列降级" do
      gl_read = Subjects.action_code!("acc.gl_entry", "read")

      # 只持一个变体目标(销售发货)的 read:8 个变体裁到恰好 1 个
      one = Subjects.token!([gl_read, Subjects.action_code!("sales.delivery", "read")])
      voucher = column(run_meta(one, "accGlEntries"), "voucherId")

      assert %{"variants" => [%{"value" => "sales.delivery", "resource" => "salDeliveries"}]} =
               voucher["ref"]

      # 一个变体目标的码都不持:全裁,整列降级为普通 uuid 列
      none = Subjects.token!([gl_read])
      degraded = column(run_meta(none, "accGlEntries"), "voucherId")

      assert degraded["ref"] == nil, "全部变体被裁后不应残留 ref:#{inspect(degraded)}"
      assert degraded["type"] == "string"
    end
  end

  describe "能力清单(按钮显隐驱动,正向对照)" do
    test "无码为空;持码恰好命中;super_admin 全量(不含 read)" do
      resp = run_meta(Subjects.token!([]), "sysRoles")
      assert %{"data" => %{"gridMeta" => %{"capabilities" => []}}} = resp

      update_only = Subjects.token!([Subjects.action_code!("sys.role", "update")])
      resp = run_meta(update_only, "sysRoles")
      assert %{"data" => %{"gridMeta" => %{"capabilities" => ["update"]}}} = resp

      resp = run_meta(Subjects.token!([], super_admin: true), "sysRoles")
      %{"data" => %{"gridMeta" => %{"capabilities" => capabilities}}} = resp

      # 权限目录反射:除 read(读不是按钮)外的全部动作
      expected =
        "sys.role"
        |> then(fn prefix ->
          Enum.find(SynieCore.Authz.Registry.catalog(), &(&1.prefix == prefix)).actions
        end)
        |> Enum.reject(&(&1 == "read"))
        |> Enum.sort()

      assert Enum.sort(capabilities) == expected
    end
  end
end
