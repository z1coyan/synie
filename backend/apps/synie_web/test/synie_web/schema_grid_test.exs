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
    |> Ash.Changeset.for_create(:create, %{code: code, name: name, short_name: name, parent_id: parent_id})
    |> Ash.create!(authorize?: false)
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
      columns { name type label sortable filterable enumOptions { value label } ref { resource relation labelField discriminator variants { value resource labelField label } } }
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
               "ref" => %{"resource" => "basCompanies", "relation" => "parent", "labelField" => "name"}
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
               "ref" => %{"resource" => "accGlJournals", "relation" => "journal", "labelField" => "voucherNo"}
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
      assert labels == ["供应商", "客户"]

      # 多态 fk:无 join(relation null),按 partyType 判别变体;可筛(先选变体再选记录)
      assert %{"type" => "fk", "filterable" => true, "label" => "对手"} = party = by_name["partyId"]

      assert %{
               "resource" => nil,
               "relation" => nil,
               "discriminator" => "partyType",
               "variants" => [
                 %{"value" => "CUSTOMER", "resource" => "salCustomers", "labelField" => "name", "label" => "客户"},
                 %{"value" => "SUPPLIER", "resource" => "purSuppliers", "labelField" => "name", "label" => "供应商"}
               ]
             } = party["ref"]
    end
  end

  describe "多态 fk 权限裁剪" do
    test "无任何变体 read 权限:partyId 退化为普通 uuid 列" do
      actor = Authz.build_actor(user_with!(["acc.gl_entry:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "accGlEntries")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{"type" => "string", "filterable" => false, "ref" => nil} = by_name["partyId"]
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
                 "variants" => [%{"value" => "CUSTOMER", "resource" => "salCustomers", "label" => "客户"}]
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

    %{customer_a: customer_a}
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

    test "partyId isNil:只命中无对手的分录" do
      entry_fixtures!()

      result =
        run!(
          ~s|query { accGlEntries(limit: 10, offset: 0, filter: {partyId: {isNil: true}}) { count results { partyId } } }|,
          super_actor()
        )

      assert %{data: %{"accGlEntries" => %{"count" => 1, "results" => [%{"partyId" => nil}]}}} = result
    end
  end
end
