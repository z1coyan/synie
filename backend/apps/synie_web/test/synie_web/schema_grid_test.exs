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

  defp company!(code, name, parent_id \\ nil) do
    SynieCore.Base.Company
    |> Ash.Changeset.for_create(:create, %{
      code: code,
      name: name,
      short_name: name,
      parent_id: parent_id,
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

  describe "元数据端点鉴权" do
    test "未认证(actor=nil)拉 permissionCatalog 被拒" do
      result = run!("query { permissionCatalog { prefix } }", nil)
      assert %{errors: [_ | _]} = result
    end

    test "未认证拉 numberableResources 被拒" do
      result = run!("query { numberableResources { grid } }", nil)
      assert %{errors: [_ | _]} = result
    end
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

  # GridMeta.build/2 扩展动作机制测试用:手工构造 actor,权限 MapSet 直填,不经 DB 夹具
  defp no_perm_actor do
    %Authz.Actor{
      user_id: Ash.UUID.generate(),
      permissions: MapSet.new(),
      super_admin: false,
      all_companies: false,
      company_ids: []
    }
  end

  defp actor_with_permissions(codes) do
    %Authz.Actor{
      user_id: Ash.UUID.generate(),
      permissions: MapSet.new(codes),
      super_admin: false,
      all_companies: false,
      company_ids: []
    }
  end

  # 注意:defp 与模块属性放 describe 外(ExUnit 不允许在 describe 内定义函数)
  @meta_query """
  query ($resource: String!) {
    gridMeta(resource: $resource) {
      columns { name type label sortable filterable enumOptions { value label } ref { resource relation labelField discriminator discriminatorType variants { value resource labelField label } } }
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

      # uuid 列:type 仍映射 string(展示不受影响),但 AshGraphql 不为 UUID 生成 contains,filterable 须为 false
      assert by_name["id"]["filterable"] == false
    end

    test "super_admin 拿到全部能力(不含 read),destroyMutation 正确" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor())

      assert Enum.sort(meta["capabilities"]) ==
               ["batch_delete", "batch_print", "create", "delete", "export", "print", "update"]

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
      result = run_meta!(super_actor(), "sysNotARealResource")
      assert result[:errors] != nil and result[:errors] != []
    end
  end

  describe "sysAuditLogs 接入" do
    test "gridMeta:map 列不可筛不可排,时间列公开,只读无能力" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor(), "sysAuditLogs")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      # map(jsonb)列:AshGraphql 不生成 contains,若标 filterable 跨列搜索会拼出非法算子炸整页查询
      assert %{"label" => "变更内容", "filterable" => false, "sortable" => false} = by_name["changes"]
      assert %{"type" => "datetime", "label" => "操作时间"} = by_name["insertedAt"]
      assert meta["capabilities"] == []
      assert meta["destroyMutation"] == nil
    end

    test "行查询:contains 筛选命中审计行,changes 以 JSON 串返回" do
      roles!([{"al_a", "审计源角色", true}])
      actor = Authz.build_actor(user_with!(["sys.audit_log:read"]))

      result =
        run!(
          ~s|query { sysAuditLogs(limit: 10, offset: 0, filter: {resource: {contains: "sys_role"}}) { count results { actionType changes insertedAt } } }|,
          actor
        )

      assert %{data: %{"sysAuditLogs" => %{"results" => rows}}} = result

      # contains 也会命中 sys_role_permission/sys_user_role 等夹具行,按变更内容定位目标行
      changes_list = Enum.map(rows, &Jason.decode!(&1["changes"]))
      assert Enum.any?(changes_list, &match?(%{"code" => %{"to" => "al_a"}}, &1))
    end
  end

  describe "grid_actions 一致性" do
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

  describe "GridMeta.build 扩展动作机制" do
    # 纯反射 + 权限判定,不需要 DB 行;用 test/support/grid_doc.ex 的 GridDoc 资源验证
    # extended_actions 的传导与 capabilities 的授权过滤(白名单资源现均无扩展动作,机制此前空转)

    test "无权限 actor:capabilities 为空" do
      built = SynieWeb.GridMeta.build(SynieWeb.Test.GridDoc, no_perm_actor())
      assert built.capabilities == []
    end

    test "授权 test.grid_doc:audit:capabilities 命中 audit,extended_actions 原样返回两个描述符" do
      actor = actor_with_permissions(["test.grid_doc:audit"])
      built = SynieWeb.GridMeta.build(SynieWeb.Test.GridDoc, actor)

      assert built.capabilities == ["audit"]

      assert [
               %{key: "audit", label: "审核", scope: "row", is_danger: false},
               %{key: "close", label: "关闭", scope: "both", is_danger: true}
             ] =
               Enum.map(built.extended_actions, &Map.take(&1, [:key, :label, :scope, :is_danger]))
    end

    test "super_admin:capabilities 拿到 audit 与 close(不含 read)" do
      built = SynieWeb.GridMeta.build(SynieWeb.Test.GridDoc, super_actor())
      assert built.capabilities == ["audit", "close"]
    end
  end

  describe "gridMeta 外键 ref" do
    test "有目标 read 权限:parentId 为 fk 列并携带 ref" do
      actor = Authz.build_actor(user_with!(["base.company:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "basCompanies")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{
               "type" => "fk",
               "label" => "上级公司",
               "sortable" => false,
               "filterable" => true,
               "ref" => %{
                 "resource" => "basCompanies",
                 "relation" => "parent",
                 "labelField" => "name"
               }
             } = by_name["parentId"]
    end

    test "无目标 read 权限:退化为 uuid 列(string/不可筛/无 ref)" do
      actor = Authz.build_actor(user_with!(["sys.role:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "basCompanies")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{"type" => "string", "label" => "上级公司", "filterable" => false, "ref" => nil} =
               by_name["parentId"]
    end

    test "目标资源无 name 属性:labelField 反射到第一个 public string 属性(凭证 voucherNo)" do
      actor = Authz.build_actor(user_with!(["acc.gl_journal:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "accGlJournalLines")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{
               "type" => "fk",
               "ref" => %{
                 "resource" => "accGlJournals",
                 "relation" => "journal",
                 "labelField" => "voucherNo"
               }
             } = by_name["journalId"]
    end

    test "无 belongs_to 的资源所有列 ref 为空" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor())
      assert Enum.all?(meta["columns"], &(&1["ref"] == nil))
    end
  end

  describe "basCompanies 行查询" do
    test "offset 分页 + parent join + parentId/id in 筛选" do
      actor = Authz.build_actor(user_with!(["base.company:read"]))
      parent = company!("AA", "集团总部")
      _child = company!("AB", "华东子公司", parent.id)
      _other = company!("AC", "独立公司")

      result =
        run!(
          ~s|query { basCompanies(limit: 10, offset: 0, filter: {parentId: {in: ["#{parent.id}"]}}) { count results { id name parent { id name } } } }|,
          actor
        )

      assert %{data: %{"basCompanies" => %{"count" => 1, "results" => [row]}}} = result
      assert row["name"] == "华东子公司"
      assert row["parent"]["name"] == "集团总部"

      by_id =
        run!(
          ~s|query { basCompanies(filter: {id: {in: ["#{parent.id}"]}}) { results { id name } } }|,
          actor
        )

      assert %{data: %{"basCompanies" => %{"results" => [%{"name" => "集团总部"}]}}} = by_id
    end
  end

  describe "accGlJournals 接入" do
    test "status 反射为中文枚举,companyId 反射 fk 指向 basCompanies,extendedActions 含审核/取消" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor(), "accGlJournals")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{"type" => "enum"} = status = by_name["status"]

      assert Enum.sort_by(status["enumOptions"], & &1["value"]) == [
               %{"value" => "AUDITED", "label" => "已审核"},
               %{"value" => "CANCELLED", "label" => "已取消"},
               %{"value" => "DRAFT", "label" => "草稿"}
             ]

      assert %{
               "type" => "fk",
               "ref" => %{"resource" => "basCompanies", "relation" => "company"}
             } = by_name["companyId"]

      assert Enum.map(meta["extendedActions"], & &1["key"]) |> Enum.sort() ==
               ["audit", "cancel"]
    end

    test "借贷合计聚合反射为展示列(decimal,不可排序筛选)" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor(), "accGlJournals")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      for name <- ["debitTotal", "creditTotal"] do
        assert %{"type" => "decimal", "sortable" => false, "filterable" => false, "ref" => nil} =
                 by_name[name]
      end

      assert by_name["debitTotal"]["label"] == "借方总金额"
      assert by_name["creditTotal"]["label"] == "贷方总金额"
    end
  end

  describe "accGlJournalLines 接入" do
    test "accountId 反射 fk 指向 basAccounts,partyType 反射中文枚举,partyId 反射多态 fk" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor(), "accGlJournalLines")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{
               "type" => "fk",
               "ref" => %{"resource" => "basAccounts", "relation" => "account"}
             } = by_name["accountId"]

      assert %{"type" => "enum"} = party_type = by_name["partyType"]
      labels = party_type["enumOptions"] |> Enum.map(& &1["label"]) |> Enum.sort()
      assert labels == ["供应商", "内部公司", "客户"]

      # 多态 fk:无 join(relation null),按 partyType 判别变体;可筛(先选变体再选记录)
      assert %{"type" => "fk", "filterable" => true, "label" => "对手"} = party = by_name["partyId"]

      assert %{
               "resource" => nil,
               "relation" => nil,
               "discriminator" => "partyType",
               "discriminatorType" => "enum",
               "variants" => [
                 %{
                   "value" => "COMPANY",
                   "resource" => "basCompanies",
                   "labelField" => "name",
                   "label" => "内部公司"
                 },
                 %{
                   "value" => "CUSTOMER",
                   "resource" => "salCustomers",
                   "labelField" => "name",
                   "label" => "客户"
                 },
                 %{
                   "value" => "SUPPLIER",
                   "resource" => "purSuppliers",
                   "labelField" => "name",
                   "label" => "供应商"
                 }
               ]
             } = party["ref"]
    end
  end

  describe "多态 fk 权限裁剪" do
    test "无任何变体 read 权限:partyId/voucherId 都退化为普通 uuid 列" do
      actor = Authz.build_actor(user_with!(["acc.gl_entry:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "accGlEntries")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{"type" => "string", "filterable" => false, "ref" => nil} = by_name["partyId"]
      assert %{"type" => "string", "filterable" => false, "ref" => nil} = by_name["voucherId"]
    end

    test "只有客户 read 权限:variants 仅剩 CUSTOMER" do
      actor = Authz.build_actor(user_with!(["acc.gl_entry:read", "sales.customer:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "accGlEntries")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{
               "type" => "fk",
               "filterable" => true,
               "ref" => %{
                 "discriminator" => "partyType",
                 "variants" => [
                   %{"value" => "CUSTOMER", "resource" => "salCustomers", "label" => "客户"}
                 ]
               }
             } = by_name["partyId"]
    end
  end

  describe "accGlEntries 接入" do
    test "只读资源:capabilities 为空,无 destroyMutation,无 extendedActions" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor(), "accGlEntries")

      assert meta["capabilities"] == []
      assert meta["destroyMutation"] == nil
      assert meta["extendedActions"] == []
    end

    test "voucherId 反射字符串判别多态 fk:变体值原样(不大写)、显式中文标签" do
      actor = Authz.build_actor(user_with!(["acc.gl_entry:read", "acc.gl_journal:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "accGlEntries")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{"type" => "fk", "filterable" => true, "label" => "来源单据"} =
               voucher = by_name["voucherId"]

      assert %{
               "resource" => nil,
               "relation" => nil,
               "discriminator" => "voucherType",
               "discriminatorType" => "string",
               "variants" => [
                 %{
                   "value" => "acc.gl_journal",
                   "resource" => "accGlJournals",
                   "labelField" => "voucherNo",
                   "label" => "凭证"
                 }
               ]
             } = voucher["ref"]

      # 同一 actor 无客户/供应商权限:partyId 照常退化,两个多态列互不影响
      assert %{"ref" => nil} = by_name["partyId"]
    end
  end

  # 多态 fk 筛选依赖的算子契约:party_id/party_type 是普通 public 属性,
  # AshGraphql 自动生成 eq/in/isNil,前端拼 {判别 eq} and {id in} 即可,后端零特殊代码
  defp entry!(attrs) do
    SynieCore.Acc.GlEntry
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  defp entry_fixtures! do
    company = company!("GL", "分录公司")

    account =
      SynieCore.Base.Account
      |> Ash.Changeset.for_create(:create, %{
        code: "a#{System.unique_integer([:positive])}",
        name: "库存现金",
        direction: :debit,
        company_id: company.id
      })
      |> Ash.create!(authorize?: false)

    base = %{
      company_id: company.id,
      account_id: account.id,
      posting_date: ~D[2026-07-09],
      debit: Decimal.new("100"),
      credit: Decimal.new("0"),
      voucher_type: "acc.gl_journal",
      voucher_id: Ash.UUID.generate(),
      voucher_no: "记-0001"
    }

    customer_a = Ash.UUID.generate()
    customer_b = Ash.UUID.generate()
    supplier_c = Ash.UUID.generate()

    entry!(Map.merge(base, %{party_type: :customer, party_id: customer_a}))
    entry!(Map.merge(base, %{party_type: :customer, party_id: customer_b}))
    entry!(Map.merge(base, %{party_type: :supplier, party_id: supplier_c}))
    entry!(base)

    %{customer_a: customer_a, base: base}
  end

  describe "多态 fk 筛选执行" do
    test "判别 eq + id in 组合:只命中指定客户的分录" do
      %{customer_a: customer_a} = entry_fixtures!()

      result =
        run!(
          ~s|query { accGlEntries(limit: 10, offset: 0, filter: {and: [{partyType: {eq: CUSTOMER}}, {partyId: {in: ["#{customer_a}"]}}]}) { count results { partyId } } }|,
          super_actor()
        )

      assert %{data: %{"accGlEntries" => %{"count" => 1, "results" => [row]}}} = result
      assert row["partyId"] == customer_a
    end

    test "字符串判别 eq(带引号)+ voucherId in 组合:只命中指定凭证的分录" do
      %{base: base} = entry_fixtures!()
      # 另一张凭证的分录,应被 in 过滤掉
      entry!(Map.merge(base, %{voucher_id: Ash.UUID.generate(), voucher_no: "记-0002"}))

      result =
        run!(
          ~s|query { accGlEntries(limit: 10, offset: 0, filter: {and: [{voucherType: {eq: "acc.gl_journal"}}, {voucherId: {in: ["#{base.voucher_id}"]}}]}) { count results { voucherId } } }|,
          super_actor()
        )

      assert %{data: %{"accGlEntries" => %{"count" => 4, "results" => rows}}} = result
      assert Enum.all?(rows, &(&1["voucherId"] == base.voucher_id))
    end

    test "partyId isNil:只命中无对手的分录" do
      entry_fixtures!()

      result =
        run!(
          ~s|query { accGlEntries(limit: 10, offset: 0, filter: {partyId: {isNil: true}}) { count results { partyId } } }|,
          super_actor()
        )

      assert %{data: %{"accGlEntries" => %{"count" => 1, "results" => [%{"partyId" => nil}]}}} =
               result
    end
  end

  # 销售条目夹具:公司/客户/物料(分类+单位)/订单/条目。dates 每个元素建一单(指定订单日期)一行
  defp sales_item_fixtures!(dates) do
    company = company!("SA", "销售夹具公司")

    customer =
      SynieCore.Sales.Customer
      |> Ash.Changeset.for_create(:create, %{
        code: "C-#{System.unique_integer([:positive])}",
        name: "夹具客户"
      })
      |> Ash.create!(authorize?: false)

    unit =
      SynieCore.Base.Unit
      |> Ash.Changeset.for_create(:create, %{
        unit_type: :quantity,
        is_base: true,
        name: "只",
        symbol: "s#{System.unique_integer([:positive])}",
        ratio: 1
      })
      |> Ash.create!(authorize?: false)

    category =
      SynieCore.Inv.MaterialCategory
      |> Ash.Changeset.for_create(:create, %{
        code: "MC#{System.unique_integer([:positive])}",
        name: "夹具分类"
      })
      |> Ash.create!(authorize?: false)

    # 物料编号仅自动取号(动作不接受 code),夹具用 seed 直写以保留确定性编号
    material =
      Ash.Seed.seed!(SynieCore.Inv.Material, %{
        code: "MAT-#{System.unique_integer([:positive])}",
        name: "夹具物料",
        category_id: category.id,
        default_unit_id: unit.id
      })

    pairs =
      Enum.map(dates, fn date ->
        order =
          SynieCore.Sales.Order
          |> Ash.Changeset.for_create(:create, %{
            company_id: company.id,
            order_no: "SO-#{System.unique_integer([:positive])}",
            order_date: date,
            order_type: :sample,
            party_type: :customer,
            party_id: customer.id
          })
          |> Ash.create!(authorize?: false)

        item =
          SynieCore.Sales.OrderItem
          |> Ash.Changeset.for_create(:create, %{
            order_id: order.id,
            idx: 1,
            material_id: material.id,
            unit_id: unit.id,
            qty: 1,
            price: 1
          })
          |> Ash.create!(authorize?: false)

        {order, item}
      end)

    %{customer: customer, pairs: pairs}
  end

  describe "salOrderItems 头字段 calculation" do
    test "gridMeta:物料快照列反射为普通 string 列(中文标签)" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor(), "salOrderItems")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      for {name, label} <- [
            {"materialCode", "物料编号"},
            {"materialName", "物料名称"},
            {"materialSpec", "规格"},
            {"customerPartNo", "客户料号"},
            {"unitName", "单位名称"}
          ] do
        assert %{"type" => "string", "label" => ^label} = by_name[name]
      end
    end

    test "gridMeta:四个头字段反射成列(类型/中文标签/枚举项),partyId 为多态 fk" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor(), "salOrderItems")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{
               "type" => "date",
               "label" => "订单日期",
               "sortable" => true,
               "filterable" => true
             } = by_name["orderDate"]

      assert %{"type" => "enum", "label" => "状态", "sortable" => true, "filterable" => true} =
               status = by_name["orderStatus"]

      assert Enum.sort_by(status["enumOptions"], & &1["value"]) == [
               %{"value" => "AUDITED", "label" => "已审核"},
               %{"value" => "CLOSED", "label" => "已关闭"},
               %{"value" => "DRAFT", "label" => "草稿"},
               %{"value" => "VOIDED", "label" => "已作废"}
             ]

      assert %{"type" => "enum", "label" => "对手类型(客户/内部公司)"} =
               party_type = by_name["partyType"]

      # PartyType 枚举全量反射(供应商值留给采购域),与 accGlJournalLines 的 partyType 一致
      assert Enum.sort_by(party_type["enumOptions"], & &1["value"]) == [
               %{"value" => "COMPANY", "label" => "内部公司"},
               %{"value" => "CUSTOMER", "label" => "客户"},
               %{"value" => "SUPPLIER", "label" => "供应商"}
             ]

      assert %{"type" => "fk", "label" => "对手", "sortable" => false, "filterable" => true} =
               party = by_name["partyId"]

      assert %{
               "resource" => nil,
               "relation" => nil,
               "discriminator" => "partyType",
               "discriminatorType" => "enum",
               "variants" => [
                 %{
                   "value" => "COMPANY",
                   "resource" => "basCompanies",
                   "labelField" => "name",
                   "label" => "内部公司"
                 },
                 %{
                   "value" => "CUSTOMER",
                   "resource" => "salCustomers",
                   "labelField" => "name",
                   "label" => "客户"
                 }
               ]
             } = party["ref"]
    end

    test "gridMeta:多态 fk 变体按目标资源 read 权限裁剪" do
      actor = Authz.build_actor(user_with!(["sales.customer:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "salOrderItems")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{
               "type" => "fk",
               "ref" => %{
                 "discriminator" => "partyType",
                 "variants" => [
                   %{"value" => "CUSTOMER", "resource" => "salCustomers", "label" => "客户"}
                 ]
               }
             } = by_name["partyId"]

      # 无任何变体 read 权限:partyId 退化为普通列(无 ref)
      no_perm = Authz.build_actor(user_with!([]))
      assert %{data: %{"gridMeta" => meta2}} = run_meta!(no_perm, "salOrderItems")
      by_name2 = Map.new(meta2["columns"], &{&1["name"], &1})
      assert %{"type" => "string", "filterable" => false, "ref" => nil} = by_name2["partyId"]
    end

    test "行查询:四个头字段 calculation 取到订单值" do
      %{pairs: [{_order, item}], customer: customer} = sales_item_fixtures!([~D[2026-07-17]])

      result =
        run!(
          ~s|query { salOrderItems(filter: {id: {eq: "#{item.id}"}}) { results { orderDate orderStatus partyType partyId } } }|,
          super_actor()
        )

      assert %{data: %{"salOrderItems" => %{"results" => [row]}}} = result
      assert row["orderDate"] == "2026-07-17"
      assert row["orderStatus"] == "DRAFT"
      assert row["partyType"] == "CUSTOMER"
      assert row["partyId"] == customer.id
    end

    test "calculation 排序:orderDate DESC 生效(不被行号兜底顶掉)" do
      %{pairs: [{_o1, item1}, {_o2, item2}]} =
        sales_item_fixtures!([~D[2026-07-01], ~D[2026-07-15]])

      result =
        run!(
          ~s|query { salOrderItems(filter: {id: {in: ["#{item1.id}", "#{item2.id}"]}}, sort: [{field: ORDER_DATE, order: DESC}]) { results { id orderDate } } }|,
          super_actor()
        )

      assert %{data: %{"salOrderItems" => %{"results" => rows}}} = result
      assert Enum.map(rows, & &1["id"]) == [item2.id, item1.id]
      assert Enum.map(rows, & &1["orderDate"]) == ["2026-07-15", "2026-07-01"]
    end

    test "calculation 筛选:orderStatus eq 只命中已审核订单的行" do
      %{pairs: [{_o1, item1}, {order2, item2}]} =
        sales_item_fixtures!([~D[2026-07-01], ~D[2026-07-15]])

      order2 |> Ash.Changeset.for_update(:audit, %{}) |> Ash.update!(authorize?: false)

      result =
        run!(
          ~s|query { salOrderItems(filter: {and: [{id: {in: ["#{item1.id}", "#{item2.id}"]}}, {orderStatus: {eq: AUDITED}}]}) { count results { id orderStatus } } }|,
          super_actor()
        )

      assert %{data: %{"salOrderItems" => %{"count" => 1, "results" => [row]}}} = result
      assert row["id"] == item2.id
      assert row["orderStatus"] == "AUDITED"
    end
  end

  describe "枚举数组列(员工参保类型)" do
    test "gridMeta:type enumArray,带 8 险种选项,可筛不可排" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor(), "hrEmployees")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      col = by_name["insuranceTypes"]
      assert col["type"] == "enumArray"
      assert col["label"] == "参保类型"
      assert col["sortable"] == false
      assert col["filterable"] == true
      assert length(col["enumOptions"]) == 8
      assert %{"value" => "SOCIAL_INJURY", "label" => "社保工伤"} in col["enumOptions"]
      assert %{"value" => "HOUSING_FUND", "label" => "公积金"} in col["enumOptions"]
      assert %{"value" => "COMMERCIAL_MEDICAL", "label" => "商保医疗"} in col["enumOptions"]
    end

    test "has 筛选「包含」,not 包裹「不包含」" do
      for {code, types} <- [
            {"ei1", [:social_injury, :housing_fund]},
            {"ei2", [:social_pension]},
            {"ei3", []}
          ] do
        SynieCore.Hr.Employee
        |> Ash.Changeset.for_create(:create, %{
          code: code,
          name: "员工#{code}",
          insurance_types: types
        })
        |> Ash.create!(authorize?: false)
      end

      actor = Authz.build_actor(user_with!(["hr.employee:read"]))

      assert %{data: %{"hrEmployees" => %{"results" => [row]}}} =
               run!(
                 ~s|query { hrEmployees(filter: {insuranceTypesHas: {input: {type: SOCIAL_INJURY}, eq: true}}) { results { code insuranceTypes } } }|,
                 actor
               )

      assert row["code"] == "ei1"
      assert row["insuranceTypes"] == ["SOCIAL_INJURY", "HOUSING_FUND"]

      # 「不包含」= eq false;未参保(空数组)员工也要命中
      result =
        run!(
          ~s|query { hrEmployees(filter: {insuranceTypesHas: {input: {type: SOCIAL_INJURY}, eq: false}}) { results { code } } }|,
          actor
        )

      assert %{data: %{"hrEmployees" => %{"results" => rows}}} = result
      codes = Enum.map(rows, & &1["code"])
      assert "ei2" in codes
      assert "ei3" in codes
      refute "ei1" in codes
    end
  end
end
