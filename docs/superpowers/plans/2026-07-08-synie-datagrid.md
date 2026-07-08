# SynieDataGrid 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 SynieDataGrid——传入 Ash 资源名自动渲染服务端排序/筛选/分页、按权限自动配置标准与扩展动作的业务表格,试点角色管理页。

**Architecture:** 后端在 AshGraphql 之上加一个 `gridMeta` 查询(白名单 + 列反射 + 权限能力集),并为 Role 开 offset 分页;前端 SynieDataGrid 用 gridMeta 动态拼行查询,把受控排序/筛选/分页/选择状态映射为 AshGraphql 变量,HeroUI Pro DataGrid 只做渲染层,工具栏/筛选/分页器/批量条由封装层组合。

**Tech Stack:** Elixir umbrella(Ash 3 + AshGraphql + Absinthe)、React 19 + TanStack(Start/Router/Query)+ `@heroui/react` v3 + `@heroui-pro/react`、bun。

**Spec:** `docs/superpowers/specs/2026-07-07-synie-datagrid-design.md`(v4)

## Global Constraints

- 项目第一语言中文:UI 文案、注释、commit message 均中文;commit 走 conventional 前缀(`feat:`/`docs:`/`test:`)。
- 后端命令前必须导出 elixir PATH:`export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"`。
- Postgres 在 5440 的 `synie-pg` 容器,跑测试前确保 `docker start synie-pg`;dev/test config 已默认 5440。
- 后端测试:`cd backend && mix test`(全量);targeted:`cd backend/apps/synie_web && mix test test/synie_web/schema_grid_test.exs`。提交前 `cd backend && mix format`。
- 前端检查:`cd web && bunx tsc --noEmit`(类型)+ `bun app/components/synie-data-grid/grid-checks.ts`(纯函数自检);无测试框架,不新增。
- HeroUI v3 约定:交互用 `onPress` 非 `onClick`;子组件点号嵌套;`toast(标题, opts)` / `toast.success` / `toast.danger`(无 `toast.error`),`Toast.Provider` 已在 `__root.tsx`;无数字色阶 token;基础组件从 `@heroui/react`、Pro 组件(DataGrid/ActionBar/EmptyState/InlineSelect/Sheet)从 `@heroui-pro/react` 导入。
- 受控 props 挂载位置:Modal/AlertDialog 挂 `.Backdrop`;Popover/Dropdown/Sheet 挂根;Pagination 无内建受控(自管 state + `onPress`)。
- 前端非幂等请求必须 Toast 反馈并做错误处理(web/CLAUDE.md 守则)。
- `web/app/routeTree.gen.ts` 是生成物,不手改。
- capabilities 只管按钮显隐,服务端 policy 是真正的权限校验(fail-closed)。

## 文件结构

后端:

| 文件 | 职责 |
|---|---|
| M `backend/apps/synie_core/lib/synie_core/authz/role.ex` | read 开 offset 分页;属性加中文 description;时间戳设 public |
| M `backend/apps/synie_core/lib/synie_core.ex` | `sys_roles` 查询 `paginate_with: :offset` |
| C `backend/apps/synie_web/lib/synie_web/grid_meta.ex` | 白名单、列反射、capabilities、extendedActions、destroyMutation |
| M `backend/apps/synie_web/lib/synie_web/schema.ex` | grid_meta 对象与 query 字段 |
| C `backend/apps/synie_web/test/synie_web/schema_grid_test.exs` | 分页/筛选/排序契约 + gridMeta 测试 |
| M `backend/apps/synie_web/test/synie_web/schema_authz_test.exs` | 两处 `sysRoles { id }` 改为 page 形态 |

前端(`web/app/components/synie-data-grid/`,`~/*` 别名指向 `web/app/`):

| 文件 | 职责 |
|---|---|
| C `types.ts` | 元数据/筛选/动作类型 |
| C `meta.ts` | GRID_META_QUERY + useGridMeta |
| C `query.ts` | 行查询字符串构建(filter/sort 字面量) |
| C `csv.ts` | toCsv / fetchAllRows / downloadCsv |
| C `grid-checks.ts` | bun 可跑的纯函数自检 |
| C `filter-popover.tsx` | 按列类型的筛选控件 |
| C `use-grid-actions.tsx` | 动作装配 + 内建 mutation 执行器 + 确认框状态 |
| C `print.ts` | 默认打印视图 |
| C `SynieDataGrid.tsx` | 组装:DataGrid/工具栏/分页/ActionBar/态 |
| C `web/app/routes/_app/system/roles.tsx` | 试点角色管理页(Sheet 表单) |

---

### Task 1: Role 开 offset 分页 + 中文标签(后端)

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/authz/role.ex`
- Modify: `backend/apps/synie_core/lib/synie_core.ex:8`
- Create: `backend/apps/synie_web/test/synie_web/schema_grid_test.exs`
- Modify: `backend/apps/synie_web/test/synie_web/schema_authz_test.exs:51,59`

**Interfaces:**
- Produces: GraphQL `sysRoles(limit: Int, offset: Int, sort: [SysRoleSortInput], filter: SysRoleFilterInput): PageOfSysRole`,page 形态 `{ count, results }`;filter 谓词 `contains/eq/notEq/in/isNil/greaterThanOrEqual/lessThanOrEqual`;sort 形态 `[{field: CODE, order: DESC}]`(field 为列名 SNAKE 大写枚举)。这是前端 `query.ts` 的契约。
- Produces: Role 公开属性含 `inserted_at`/`updated_at`,各属性带中文 `description`。

- [ ] **Step 1: 写失败测试**

创建 `backend/apps/synie_web/test/synie_web/schema_grid_test.exs`:

```elixir
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

      assert %{data: %{"sysRoles" => %{"results" => [%{"code" => "srt_b"}, %{"code" => "srt_a"}]}}} =
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

      result = run!(~s|mutation { destroySysRole(id: "#{role.id}") { errors { message } } }|, actor)

      # AshGraphql 的 policy 拒绝落在 data.errors 或顶层 errors,两者任一即可
      errors = get_in(result, [:data, "destroySysRole", "errors"]) || result[:errors]
      assert errors != nil and errors != []
    end

    test "拥有 sys.role:delete 可删除" do
      [role] = roles!([{"del_ok", "待删", true}])
      actor = Authz.build_actor(user_with!(["sys.role:read", "sys.role:delete"]))

      result = run!(~s|mutation { destroySysRole(id: "#{role.id}") { result { id } errors { message } } }|, actor)

      assert %{data: %{"destroySysRole" => %{"result" => %{"id" => _}}}} = result
    end
  end
end
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"
docker start synie-pg 2>/dev/null
cd backend/apps/synie_web && mix test test/synie_web/schema_grid_test.exs
```

预期:FAIL——`sysRoles` 无 `limit/offset` 参数、无 `count/results` 字段(当前是扁平列表)、无 `insertedAt` 字段。

- [ ] **Step 3: 实现**

`role.ex` 的 actions 块:`defaults [:read, :destroy]` 改为显式 read(**`required?: false` 必须保留**——authz 内部还有非分页读取 Role 的路径,required 会把普通 `Ash.read!` 的返回变成 Page 结构拆坏调用方):

```elixir
  actions do
    defaults [:destroy]

    read :read do
      primary? true
      pagination offset?: true, countable: true, required?: false, default_limit: 20, max_page_size: 200
    end

    create :create do
      accept [:code, :name, :enabled]
    end

    update :update do
      accept [:name, :enabled]
    end
  end
```

`role.ex` 的 attributes 块加中文 description、时间戳设 public(gridMeta 反射用):

```elixir
  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "角色编码"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "角色名称"
    end

    attribute :enabled, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end
```

`synie_core.ex:8` 改为:

```elixir
      # sys_roles 已上数据表格,开 offset 分页;其余系统资源规模小仍为扁平列表
      list SynieCore.Authz.Role, :sys_roles, :read, paginate_with: :offset
```

- [ ] **Step 4: 同步旧测试到 page 形态**

`schema_authz_test.exs` 两处:

```elixir
    # 第 51 行
    result = run!("query { sysRoles { results { id } } }", actor)
    # 第 59-62 行
    result = run!("query { sysRoles { results { id code } } }", actor)

    assert %{data: %{"sysRoles" => %{"results" => roles}}} = result
    assert is_list(roles) and roles != []
```

- [ ] **Step 5: 全量测试通过**

```bash
cd backend && mix format && mix test
```

预期:全部 PASS(含 synie_core 既有测试——若有内部 Role 读取被分页影响会在这里暴露)。

- [ ] **Step 6: Commit**

```bash
git add backend && git commit -m "feat: sys_roles 开 offset 分页,Role 属性中文标签与公开时间戳"
```

---

### Task 2: gridMeta 查询(后端)

**Files:**
- Create: `backend/apps/synie_web/lib/synie_web/grid_meta.ex`
- Modify: `backend/apps/synie_web/lib/synie_web/schema.ex`
- Modify: `backend/apps/synie_web/test/synie_web/schema_grid_test.exs`(追加 describe)

**Interfaces:**
- Consumes: Task 1 的 Role 公开属性(含时间戳)与 description。
- Produces: GraphQL `gridMeta(resource: String!): GridMeta!`,形态:
  `{ columns: [{name, type, label, sortable, filterable, enumOptions: [{value, label}]}], capabilities: [String], extendedActions: [{key, label, scope, mutation, isDanger}], destroyMutation: String }`。
  `type ∈ string|integer|decimal|boolean|date|datetime|enum`;`capabilities` 为权限动作码(不含 read);Elixir 侧 `SynieWeb.GridMeta.resolve(name, actor)` 与 `SynieWeb.GridMeta.resources/0`。

- [ ] **Step 1: 写失败测试**

在 `schema_grid_test.exs` 追加:

```elixir
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend/apps/synie_web && mix test test/synie_web/schema_grid_test.exs
```

预期:FAIL——`Cannot query field "gridMeta"`。

- [ ] **Step 3: 实现 GridMeta 模块**

创建 `backend/apps/synie_web/lib/synie_web/grid_meta.ex`:

```elixir
defmodule SynieWeb.GridMeta do
  @moduledoc """
  数据表格元数据:列定义反射 + 当前 actor 能力集 + 扩展动作描述符。

  资源必须在 @resources 白名单注册(信任边界,不做动态模块查找)。
  capabilities 只驱动前端按钮显隐,真正的权限校验在服务端 Ash policy。
  """

  alias SynieCore.Authz

  @resources %{
    "sysRoles" => SynieCore.Authz.Role
  }

  @spec resolve(String.t(), Authz.Actor.t() | nil) :: {:ok, map()} | {:error, String.t()}
  def resolve(resource_name, actor) do
    case Map.fetch(@resources, resource_name) do
      {:ok, module} -> {:ok, build(module, actor)}
      :error -> {:error, "未知的表格资源: #{resource_name}"}
    end
  end

  def resources, do: @resources

  defp build(module, actor) do
    %{
      columns: module |> Ash.Resource.Info.public_attributes() |> Enum.map(&column/1),
      capabilities: capabilities(module, actor),
      extended_actions: extended_actions(module),
      destroy_mutation: destroy_mutation(module)
    }
  end

  defp column(attr) do
    %{
      name: camelize(attr.name),
      type: type_name(attr.type),
      label: attr.description || to_string(attr.name),
      sortable: true,
      filterable: true,
      enum_options: enum_options(attr.type)
    }
  end

  defp capabilities(module, actor) do
    prefix = module.permission_prefix()

    module.permission_actions()
    |> Enum.reject(&(&1 == "read"))
    |> Enum.filter(&Authz.has_permission?(actor, "#{prefix}:#{&1}"))
  end

  defp extended_actions(module) do
    if function_exported?(module, :grid_actions, 0), do: module.grid_actions(), else: []
  end

  defp destroy_mutation(module) do
    AshGraphql.Domain.Info.mutations(SynieCore)
    |> Enum.find(&(&1.resource == module and &1.type == :destroy))
    |> case do
      nil -> nil
      mutation -> camelize(mutation.name)
    end
  end

  defp camelize(name), do: name |> to_string() |> Absinthe.Utils.camelize(lower: true)

  defp type_name(type) do
    cond do
      enum_type?(type) ->
        "enum"

      type in [Ash.Type.Integer] ->
        "integer"

      type in [Ash.Type.Decimal, Ash.Type.Float] ->
        "decimal"

      type in [Ash.Type.Boolean] ->
        "boolean"

      type in [Ash.Type.Date] ->
        "date"

      type in [Ash.Type.UtcDatetime, Ash.Type.UtcDatetimeUsec, Ash.Type.NaiveDatetime] ->
        "datetime"

      true ->
        # string/ci_string/uuid/atom 及未识别类型都按 string 处理(展示与 contains 筛选均适用)
        "string"
    end
  end

  defp enum_type?(type) do
    is_atom(type) and Code.ensure_loaded?(type) and function_exported?(type, :values, 0)
  end

  defp enum_options(type) do
    if enum_type?(type) do
      Enum.map(type.values(), fn value ->
        %{value: to_string(value), label: enum_label(type, value)}
      end)
    end
  end

  defp enum_label(type, value) do
    if function_exported?(type, :description, 1) do
      type.description(value) || to_string(value)
    else
      to_string(value)
    end
  end
end
```

- [ ] **Step 4: schema.ex 加对象与 query 字段**

在 `object :permission_group ... end` 之后追加:

```elixir
  object :grid_enum_option do
    field :value, non_null(:string)
    field :label, non_null(:string)
  end

  object :grid_column do
    field :name, non_null(:string)
    field :type, non_null(:string)
    field :label, non_null(:string)
    field :sortable, non_null(:boolean)
    field :filterable, non_null(:boolean)
    field :enum_options, list_of(non_null(:grid_enum_option))
  end

  object :grid_action do
    field :key, non_null(:string)
    field :label, non_null(:string)
    field :scope, non_null(:string)
    field :mutation, non_null(:string)
    field :is_danger, non_null(:boolean)
  end

  object :grid_meta do
    field :columns, non_null(list_of(non_null(:grid_column)))
    field :capabilities, non_null(list_of(non_null(:string)))
    field :extended_actions, non_null(list_of(non_null(:grid_action)))
    field :destroy_mutation, :string
  end
```

在 `query do` 块内(`permission_catalog` 字段之后)追加:

```elixir
    field :grid_meta, non_null(:grid_meta) do
      arg(:resource, non_null(:string))

      resolve(fn %{resource: name}, %{context: context} ->
        SynieWeb.GridMeta.resolve(name, context[:actor])
      end)
    end
```

- [ ] **Step 5: 测试通过 + 全量**

```bash
cd backend/apps/synie_web && mix test test/synie_web/schema_grid_test.exs
cd ../.. && mix format && mix test
```

预期:全部 PASS。若 `%Authz.Actor{}` 字段名或 `AshGraphql.Resource.Mutation` 结构与断言不符,以测试报错为准修 GridMeta(契约由测试钉死)。

- [ ] **Step 6: Commit**

```bash
git add backend && git commit -m "feat: gridMeta 查询——列反射 + 权限能力集 + 扩展动作描述符"
```

---

### Task 3: 前端纯逻辑层——类型/meta/行查询构建/CSV(带自检)

**Files:**
- Create: `web/app/components/synie-data-grid/types.ts`
- Create: `web/app/components/synie-data-grid/meta.ts`
- Create: `web/app/components/synie-data-grid/query.ts`
- Create: `web/app/components/synie-data-grid/csv.ts`
- Create: `web/app/components/synie-data-grid/grid-checks.ts`

**Interfaces:**
- Consumes: Task 2 的 gridMeta GraphQL 形态;Task 1 的行查询契约(`{ count, results }`、filter 谓词、sort 枚举)。
- Produces(后续任务用):
  - `types.ts`:`GridColumnMeta`、`GridMeta`、`Row`、`FilterState`、`ColumnFilter`、`SortState`、`ActionContext`、`RowAction`、`BulkAction`、`GridActionMeta`
  - `meta.ts`:`useGridMeta(resource: string)` → react-query result of `GridMeta`
  - `query.ts`:`buildFilterLiteral(filters, search, columns): string | null`、`toSortLiteral(sort): string | null`、`buildRowQuery(resource, columns, opts): string`
  - `csv.ts`:`toCsv(columns, rows): string`、`fetchAllRows(resource, columns, filterLiteral, sortLiteral): Promise<Row[]>`、`downloadCsv(filename, csv): void`

- [ ] **Step 1: 写 types.ts**

```ts
export type GridColumnType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'enum'

export interface GridEnumOption {
  value: string
  label: string
}

export interface GridColumnMeta {
  name: string
  type: GridColumnType
  label: string
  sortable: boolean
  filterable: boolean
  enumOptions: GridEnumOption[] | null
}

export interface GridActionMeta {
  key: string
  label: string
  scope: 'row' | 'bulk' | 'both'
  mutation: string
  isDanger: boolean
}

export interface GridMeta {
  columns: GridColumnMeta[]
  capabilities: string[]
  extendedActions: GridActionMeta[]
  destroyMutation: string | null
}

/** 行数据是运行时拼查询取回的,类型边界即 unknown(spec「类型边界」节) */
export type Row = Record<string, unknown> & { id: string }

export interface ActionContext {
  refetch: () => void
}

interface ActionBase {
  key: string
  label: string
  isDanger?: boolean
  /** 填了则按 capabilities 门控;不填总是显示 */
  capability?: string
}

export interface RowAction extends ActionBase {
  onAction: (row: Row, ctx: ActionContext) => void
}

export interface BulkAction extends ActionBase {
  onAction: (rows: Row[], ctx: ActionContext) => void
}

export type ColumnFilter =
  | { kind: 'text'; contains: string }
  | { kind: 'bool'; eq: boolean }
  | { kind: 'enum'; values: string[] }
  | { kind: 'range'; gte?: string; lte?: string }

/** key 为列名(camelCase) */
export type FilterState = Record<string, ColumnFilter>

export interface SortState {
  column: string
  direction: 'ascending' | 'descending'
}
```

- [ ] **Step 2: 写 meta.ts**

```ts
import { useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import type { GridMeta } from './types'

const GRID_META_QUERY = `
  query GridMeta($resource: String!) {
    gridMeta(resource: $resource) {
      columns { name type label sortable filterable enumOptions { value label } }
      capabilities
      extendedActions { key label scope mutation isDanger }
      destroyMutation
    }
  }
`

export function useGridMeta(resource: string) {
  return useQuery({
    queryKey: ['gridMeta', resource],
    queryFn: () =>
      gqlFetch<{ gridMeta: GridMeta }>(GRID_META_QUERY, { resource }).then((d) => d.gridMeta),
    staleTime: 5 * 60_000,
  })
}
```

- [ ] **Step 3: 写 query.ts(先写 grid-checks.ts 会引用的实现)**

filter/sort 以**字面量**内联进查询串(AshGraphql 的 filter input 类型名、sort field 枚举都是资源相关的,走 variables 需要拼类型名,内联更简单且枚举值本来就不能带引号):

```ts
import type { FilterState, GridColumnMeta, SortState } from './types'

/** camelCase → SNAKE 大写(AshGraphql sort field 枚举值) */
export function toSortField(column: string): string {
  return column.replace(/([A-Z])/g, '_$1').toUpperCase()
}

export function toSortLiteral(sort: SortState | null): string | null {
  if (!sort) return null
  return `[{field: ${toSortField(sort.column)}, order: ${sort.direction === 'descending' ? 'DESC' : 'ASC'}}]`
}

const str = (v: string) => JSON.stringify(v)

function columnClause(name: string, filter: FilterState[string], columns: GridColumnMeta[]): string | null {
  const col = columns.find((c) => c.name === name)
  if (!col) return null
  switch (filter.kind) {
    case 'text':
      return filter.contains ? `{${name}: {contains: ${str(filter.contains)}}}` : null
    case 'bool':
      return `{${name}: {eq: ${filter.eq}}}`
    case 'enum':
      // AshGraphql 枚举字面量为大写 token,不带引号
      return filter.values.length > 0
        ? `{${name}: {in: [${filter.values.map((v) => v.toUpperCase()).join(', ')}]}}`
        : null
    case 'range': {
      const parts: string[] = []
      const numeric = col.type === 'integer' || col.type === 'decimal'
      const lit = (v: string) => (numeric ? v : str(v))
      if (filter.gte) parts.push(`greaterThanOrEqual: ${lit(filter.gte)}`)
      if (filter.lte) parts.push(`lessThanOrEqual: ${lit(filter.lte)}`)
      return parts.length > 0 ? `{${name}: {${parts.join(', ')}}}` : null
    }
  }
}

export function buildFilterLiteral(
  filters: FilterState,
  search: string,
  columns: GridColumnMeta[]
): string | null {
  const clauses = Object.entries(filters)
    .map(([name, f]) => columnClause(name, f, columns))
    .filter((c): c is string => c !== null)

  const trimmed = search.trim()
  if (trimmed) {
    const searchable = columns.filter((c) => c.filterable && c.type === 'string' && c.name !== 'id')
    if (searchable.length > 0) {
      const ors = searchable.map((c) => `{${c.name}: {contains: ${str(trimmed)}}}`)
      clauses.push(`{or: [${ors.join(', ')}]}`)
    }
  }

  if (clauses.length === 0) return null
  if (clauses.length === 1) return clauses[0]
  return `{and: [${clauses.join(', ')}]}`
}

export function buildRowQuery(
  resource: string,
  columns: GridColumnMeta[],
  opts: { limit: number; offset: number; sortLiteral: string | null; filterLiteral: string | null }
): string {
  const names = columns.map((c) => c.name)
  const fields = (names.includes('id') ? names : ['id', ...names]).join(' ')
  const args = [`limit: ${opts.limit}`, `offset: ${opts.offset}`]
  if (opts.sortLiteral) args.push(`sort: ${opts.sortLiteral}`)
  if (opts.filterLiteral) args.push(`filter: ${opts.filterLiteral}`)
  return `query { ${resource}(${args.join(', ')}) { count results { ${fields} } } }`
}
```

- [ ] **Step 4: 写 csv.ts**

```ts
import { gqlFetch } from '~/lib/graphql'
import { buildRowQuery } from './query'
import type { GridColumnMeta, Row } from './types'

export function toCsv(columns: Pick<GridColumnMeta, 'name' | 'label'>[], rows: Row[]): string {
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const header = columns.map((c) => escape(c.label)).join(',')
  const lines = rows.map((r) => columns.map((c) => escape(r[c.name])).join(','))
  return [header, ...lines].join('\r\n')
}

const EXPORT_PAGE = 200
// ponytail: 前端循环拉页导出,万行级数据再改后端流式导出
export async function fetchAllRows(
  resource: string,
  columns: GridColumnMeta[],
  filterLiteral: string | null,
  sortLiteral: string | null
): Promise<Row[]> {
  const rows: Row[] = []
  let offset = 0
  for (;;) {
    const query = buildRowQuery(resource, columns, { limit: EXPORT_PAGE, offset, sortLiteral, filterLiteral })
    const data = await gqlFetch<Record<string, { count: number; results: Row[] }>>(query)
    const page = data[resource]
    rows.push(...page.results)
    offset += EXPORT_PAGE
    if (rows.length >= page.count || page.results.length === 0) return rows
  }
}

export function downloadCsv(filename: string, csv: string): void {
  // UTF-8 BOM,Excel 打开中文不乱码
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 5: 写 grid-checks.ts 自检并运行**

```ts
// bun app/components/synie-data-grid/grid-checks.ts 可直接运行的纯函数自检
import { buildFilterLiteral, buildRowQuery, toSortLiteral } from './query'
import { toCsv } from './csv'
import type { GridColumnMeta, Row } from './types'

const cols: GridColumnMeta[] = [
  { name: 'code', type: 'string', label: '编码', sortable: true, filterable: true, enumOptions: null },
  { name: 'name', type: 'string', label: '名称', sortable: true, filterable: true, enumOptions: null },
  { name: 'enabled', type: 'boolean', label: '启用', sortable: true, filterable: true, enumOptions: null },
  { name: 'insertedAt', type: 'datetime', label: '创建时间', sortable: true, filterable: true, enumOptions: null },
]

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

eq(toSortLiteral({ column: 'insertedAt', direction: 'descending' }), '[{field: INSERTED_AT, order: DESC}]', 'sort 字面量')
eq(toSortLiteral(null), null, '空排序')

eq(
  buildFilterLiteral({ name: { kind: 'text', contains: '采购' } }, '', cols),
  '{name: {contains: "采购"}}',
  '单列 contains'
)
eq(
  buildFilterLiteral(
    { enabled: { kind: 'bool', eq: true }, insertedAt: { kind: 'range', gte: '2026-01-01T00:00:00Z' } },
    'x',
    cols
  ),
  '{and: [{enabled: {eq: true}}, {insertedAt: {greaterThanOrEqual: "2026-01-01T00:00:00Z"}}, {or: [{code: {contains: "x"}}, {name: {contains: "x"}}]}]}',
  '组合筛选+搜索'
)
eq(buildFilterLiteral({}, '', cols), null, '空筛选')

eq(
  buildRowQuery('sysRoles', cols, { limit: 20, offset: 40, sortLiteral: null, filterLiteral: null }),
  'query { sysRoles(limit: 20, offset: 40) { count results { id code name enabled insertedAt } } }',
  '行查询'
)

const rows: Row[] = [{ id: '1', code: 'a,b', name: '含"引号"', enabled: true }]
eq(
  toCsv([{ name: 'code', label: '编码' }, { name: 'name', label: '名称' }], rows),
  '编码,名称\r\n"a,b","含""引号"""',
  'CSV 转义'
)

console.log('grid-checks ok')
```

运行:

```bash
cd web && bun app/components/synie-data-grid/grid-checks.ts
```

预期:`grid-checks ok`(先跑一次确认失败态可略——文件与实现同任务落地,以自检通过为准)。

- [ ] **Step 6: 类型检查 + Commit**

```bash
cd web && bunx tsc --noEmit
git add web/app/components/synie-data-grid && git commit -m "feat: SynieDataGrid 逻辑层——meta/行查询构建/CSV 与自检"
```

---

### Task 4: SynieDataGrid 组件骨架——渲染/排序/分页/选择/三态 + 试点路由挂载

**Files:**
- Create: `web/app/components/synie-data-grid/SynieDataGrid.tsx`
- Create: `web/app/routes/_app/system/roles.tsx`(最小挂载,Task 8 完成表单)

**Interfaces:**
- Consumes: Task 3 全部导出;DataGrid 受控 props(`sortDescriptor/onSortChange`、`selectedKeys/onSelectionChange`、`renderEmptyState`)。
- Produces: `<SynieDataGrid resource exclude? overrides? …/>`(props 形态见下,动作类 props Task 6 接线);内部导出 `selectedRows(selection, rows): Row[]` 供动作层用。

- [ ] **Step 1: 写组件**

```tsx
import { useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { DataGrid, EmptyState, InlineSelect, type DataGridColumn, type DataGridSortDescriptor } from '@heroui-pro/react'
import { Button, Chip, ListBox, Pagination, Spinner } from '@heroui/react'
import type { Selection } from 'react-aria-components'
import { gqlFetch } from '~/lib/graphql'
import { useGridMeta } from './meta'
import { buildFilterLiteral, buildRowQuery, toSortLiteral } from './query'
import type { ActionContext, BulkAction, FilterState, GridColumnMeta, Row, RowAction, SortState } from './types'

export interface ColumnOverride {
  render?: (value: unknown, row: Row) => ReactNode
  label?: string
  width?: number
}

export interface SynieDataGridProps {
  /** 与后端 GridMeta 白名单同名,如 "sysRoles" */
  resource: string
  exclude?: string[]
  overrides?: Record<string, ColumnOverride>
  onCreate?: () => void
  onEdit?: (row: Row) => void
  onImport?: (ctx: ActionContext) => void
  onPrint?: (rows: Row[]) => void
  actionHandlers?: Record<string, (rows: Row[], ctx: ActionContext) => void>
  bulkActions?: BulkAction[]
  rowActions?: RowAction[]
}

const PAGE_SIZES = [10, 20, 50, 100]

export function selectedRows(selection: Selection, rows: Row[]): Row[] {
  // DataGrid 的 "all" 语义 = 当前页全选(spec 非目标:不做跨页全选)
  if (selection === 'all') return rows
  return rows.filter((r) => selection.has(r.id))
}

function defaultCell(col: GridColumnMeta, value: unknown): ReactNode {
  if (value == null || value === '') return <span className="text-muted">—</span>
  switch (col.type) {
    case 'boolean':
      return <Chip size="sm" color={value ? 'success' : 'default'}>{value ? '是' : '否'}</Chip>
    case 'datetime':
      return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
    case 'enum':
      return col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)
    default:
      return String(value)
  }
}

export function SynieDataGrid(props: SynieDataGridProps) {
  const { resource, exclude = [], overrides = {} } = props

  const meta = useGridMeta(resource)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [sort, setSort] = useState<SortState | null>(null)
  const [filters, setFilters] = useState<FilterState>({})
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<Selection>(new Set())

  const columns = useMemo(
    () => (meta.data?.columns ?? []).filter((c) => c.name !== 'id' && !exclude.includes(c.name)),
    [meta.data, exclude]
  )

  const filterLiteral = meta.data ? buildFilterLiteral(filters, search, meta.data.columns) : null
  const sortLiteral = toSortLiteral(sort)

  const rowsQuery = useQuery({
    queryKey: ['gridRows', resource, page, pageSize, sortLiteral, filterLiteral],
    enabled: !!meta.data,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const query = buildRowQuery(resource, columns, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
        sortLiteral,
        filterLiteral,
      })
      return gqlFetch<Record<string, { count: number; results: Row[] }>>(query).then((d) => d[resource])
    },
  })

  const rows = rowsQuery.data?.results ?? []
  const count = rowsQuery.data?.count ?? 0
  const totalPages = Math.max(1, Math.ceil(count / pageSize))

  const gridColumns: DataGridColumn<Row>[] = columns.map((col) => ({
    id: col.name,
    header: overrides[col.name]?.label ?? col.label,
    allowsSorting: col.sortable,
    width: overrides[col.name]?.width,
    cell: (row) => overrides[col.name]?.render?.(row[col.name], row) ?? defaultCell(col, row[col.name]),
  }))

  const sortDescriptor: DataGridSortDescriptor | undefined = sort
    ? { column: sort.column, direction: sort.direction }
    : undefined

  if (meta.isPending || (rowsQuery.isPending && !rowsQuery.data)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (meta.isError || rowsQuery.isError) {
    const err = (meta.error ?? rowsQuery.error) as Error
    return (
      <EmptyState size="md" className="h-64 justify-center">
        <EmptyState.Header>
          <EmptyState.Title>数据加载失败</EmptyState.Title>
          <EmptyState.Description>{err.message}</EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content>
          <Button variant="secondary" onPress={() => (meta.isError ? meta.refetch() : rowsQuery.refetch())}>
            重试
          </Button>
        </EmptyState.Content>
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 工具栏:Task 5 加搜索/筛选,Task 6 加动作按钮 */}
      <DataGrid
        aria-label={`${resource} 数据表格`}
        data={rows}
        columns={gridColumns}
        getRowId={(r) => r.id}
        selectionMode="multiple"
        showSelectionCheckboxes
        selectedKeys={selection}
        onSelectionChange={setSelection}
        sortDescriptor={sortDescriptor}
        onSortChange={(d) => {
          setSort({ column: String(d.column), direction: d.direction })
          setPage(1)
        }}
        renderEmptyState={() => (
          <EmptyState size="sm" className="py-10">
            <EmptyState.Header>
              <EmptyState.Title>暂无数据</EmptyState.Title>
              <EmptyState.Description>没有符合条件的记录。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        )}
        contentClassName="min-w-[720px]"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted">共 {count} 条</span>
        <div className="flex items-center gap-3">
          <InlineSelect
            aria-label="每页条数"
            value={String(pageSize)}
            onChange={(v) => {
              if (v != null) {
                setPageSize(Number(v))
                setPage(1)
              }
            }}
          >
            <InlineSelect.Trigger>
              <InlineSelect.Value />
              <InlineSelect.Indicator />
            </InlineSelect.Trigger>
            <InlineSelect.Popover className="w-[120px]">
              <ListBox>
                {PAGE_SIZES.map((n) => (
                  <ListBox.Item key={n} id={String(n)} textValue={`${n} 条/页`}>
                    {n} 条/页
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </InlineSelect.Popover>
          </InlineSelect>
          <Pager page={page} totalPages={totalPages} onChange={setPage} />
        </div>
      </div>
    </div>
  )
}

/** >7 页时:首尾 + 当前±1 + 省略号 */
function pageNumbers(page: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const middle = [page - 1, page, page + 1].filter((p) => p > 1 && p < total)
  const out: (number | 'ellipsis')[] = [1]
  if (middle[0] !== undefined && middle[0] > 2) out.push('ellipsis')
  out.push(...middle)
  if (middle.length > 0 && middle[middle.length - 1] < total - 1) out.push('ellipsis')
  out.push(total)
  return out
}

function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  return (
    <Pagination size="sm">
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous isDisabled={page <= 1} onPress={() => onChange(page - 1)}>
            <Pagination.PreviousIcon />
          </Pagination.Previous>
        </Pagination.Item>
        {pageNumbers(page, totalPages).map((p, i) => (
          <Pagination.Item key={`${p}-${i}`}>
            {p === 'ellipsis' ? (
              <Pagination.Ellipsis />
            ) : (
              <Pagination.Link isActive={p === page} onPress={() => onChange(p)}>
                {p}
              </Pagination.Link>
            )}
          </Pagination.Item>
        ))}
        <Pagination.Item>
          <Pagination.Next isDisabled={page >= totalPages} onPress={() => onChange(page + 1)}>
            <Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  )
}
```

注意:`selection`/`selectedRows` 本任务只建状态,ActionBar 在 Task 6 消费。

- [ ] **Step 2: 最小试点路由**

创建 `web/app/routes/_app/system/roles.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'

export const Route = createFileRoute('/_app/system/roles')({
  component: RolesPage,
})

function RolesPage() {
  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">角色权限</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统角色与其权限授权。</p>
      <div className="mt-6">
        <SynieDataGrid resource="sysRoles" />
      </div>
    </>
  )
}
```

- [ ] **Step 3: 类型检查**

```bash
cd web && bunx tsc --noEmit
```

预期:无错误。若 DataGrid/InlineSelect 的 props 类型名与速查表有出入(beta 包),以 `node_modules/@heroui-pro/react` 的 `.d.ts` 为准调整。

- [ ] **Step 4: 手动冒烟**

```bash
docker start synie-pg 2>/dev/null
export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"
cd backend && mix phx.server &   # 后端 4000
cd web && bun run dev            # 前端 3000
```

浏览器(或 playwright)访问 `http://localhost:3000/system/roles`,admin/admin123 登录。验收:表格渲染出 编码/名称/启用/创建时间/更新时间 列(中文表头);点列头排序生效且请求带 sort;分页器与每页条数生效;空态/加载态正常。

- [ ] **Step 5: Commit**

```bash
git add web/app/components/synie-data-grid web/app/routes/_app/system
git commit -m "feat: SynieDataGrid 骨架——服务端排序分页与三态,试点路由挂载"
```

---

### Task 5: 列头筛选 + 跨列搜索

**Files:**
- Create: `web/app/components/synie-data-grid/filter-popover.tsx`
- Modify: `web/app/components/synie-data-grid/SynieDataGrid.tsx`

**Interfaces:**
- Consumes: `FilterState`/`ColumnFilter`(Task 3)、`filters/setFilters/search/setSearch` state(Task 4)。
- Produces: `<ColumnFilterButton column filter onChange />`;SynieDataGrid 工具栏含 SearchField 与活跃筛选 Chip;任何筛选变化 `setPage(1)`。

- [ ] **Step 1: 写 filter-popover.tsx**

```tsx
import { useState } from 'react'
import { Button, Checkbox, Input, Label, Popover, Switch } from '@heroui/react'
import type { ColumnFilter, GridColumnMeta } from './types'

/** 列头筛选按钮:按列类型出控件,受控于 FilterState */
export function ColumnFilterButton({
  column,
  filter,
  onChange,
}: {
  column: GridColumnMeta
  filter: ColumnFilter | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const active = filter !== undefined

  return (
    <Popover isOpen={isOpen} onOpenChange={setIsOpen}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={`筛选 ${column.label}`}
        className={active ? 'text-accent' : 'text-muted'}
      >
        <FilterIcon />
      </Button>
      <Popover.Content placement="bottom" className="max-w-72">
        <Popover.Dialog className="flex flex-col gap-3 p-1">
          <Popover.Heading className="text-sm font-medium">{column.label}</Popover.Heading>
          <FilterControl column={column} filter={filter} onChange={onChange} />
          {active && (
            <Button size="sm" variant="tertiary" onPress={() => { onChange(null); setIsOpen(false) }}>
              清除筛选
            </Button>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

function FilterControl({
  column,
  filter,
  onChange,
}: {
  column: GridColumnMeta
  filter: ColumnFilter | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  switch (column.type) {
    case 'boolean':
      return (
        <Switch
          isSelected={filter?.kind === 'bool' ? filter.eq : false}
          onChange={(selected) => onChange({ kind: 'bool', eq: selected })}
        >
          <Switch.Content className="text-sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            仅看「是」
          </Switch.Content>
        </Switch>
      )
    case 'enum':
      return (
        <div className="flex flex-col gap-1">
          {(column.enumOptions ?? []).map((o) => {
            const values = filter?.kind === 'enum' ? filter.values : []
            const checked = values.includes(o.value)
            return (
              <Checkbox
                key={o.value}
                isSelected={checked}
                onChange={(sel) => {
                  const next = sel ? [...values, o.value] : values.filter((v) => v !== o.value)
                  onChange(next.length > 0 ? { kind: 'enum', values: next } : null)
                }}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {o.label}
                </Checkbox.Content>
              </Checkbox>
            )
          })}
        </div>
      )
    case 'date':
    case 'datetime':
    case 'integer':
    case 'decimal': {
      const isDate = column.type === 'date' || column.type === 'datetime'
      const range = filter?.kind === 'range' ? filter : {}
      const update = (patch: { gte?: string; lte?: string }) => {
        const next = { kind: 'range' as const, gte: range.gte, lte: range.lte, ...patch }
        onChange(next.gte || next.lte ? next : null)
      }
      // 后端 datetime 需要完整 ISO;日期输入按当天起止补全
      const toIso = (v: string, end: boolean) =>
        v && column.type === 'datetime' ? `${v}T${end ? '23:59:59' : '00:00:00'}Z` : v
      return (
        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted">起</Label>
          <Input
            type={isDate ? 'date' : 'number'}
            value={range.gte?.slice(0, 10) ?? ''}
            onChange={(e) => update({ gte: toIso(e.target.value, false) || undefined })}
          />
          <Label className="text-xs text-muted">止</Label>
          <Input
            type={isDate ? 'date' : 'number'}
            value={range.lte?.slice(0, 10) ?? ''}
            onChange={(e) => update({ lte: toIso(e.target.value, true) || undefined })}
          />
        </div>
      )
    }
    default:
      return (
        <Input
          placeholder="包含…"
          value={filter?.kind === 'text' ? filter.contains : ''}
          onChange={(e) =>
            onChange(e.target.value ? { kind: 'text', contains: e.target.value } : null)
          }
        />
      )
  }
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M1.5 3h13l-5 6v4.5l-3-1.5V9l-5-6z" />
    </svg>
  )
}
```

注:`<input type="date">` 用原生控件(阶梯:原生平台特性够用);Checkbox/Switch 按 v3 点号 anatomy。若 `Input` 的 onChange 是值而非事件(v3 部分字段组件如此),以 `.d.ts` 为准就地调整。

- [ ] **Step 2: 接入 SynieDataGrid**

在 SynieDataGrid.tsx:

a. 引入 `SearchField` 与 `ColumnFilterButton`;
b. 列 header 改为带筛选按钮的组合(仅 `col.filterable` 时):

```tsx
  const gridColumns: DataGridColumn<Row>[] = columns.map((col) => ({
    id: col.name,
    header: ({ sortDirection }) => (
      <span className="inline-flex items-center gap-1">
        {overrides[col.name]?.label ?? col.label}
        {col.filterable && (
          <ColumnFilterButton
            column={col}
            filter={filters[col.name]}
            onChange={(f) => {
              setFilters((prev) => {
                const next = { ...prev }
                if (f === null) delete next[col.name]
                else next[col.name] = f
                return next
              })
              setPage(1)
            }}
          />
        )}
      </span>
    ),
    ...
  }))
```

(若 DataGrid 的 `header` 函数式渲染与排序指示冲突,把排序箭头交回 DataGrid 处理——header 只返回文本+筛选按钮的 ReactNode。)

c. 工具栏加搜索(表格上方):

```tsx
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          aria-label="搜索"
          value={search}
          onChange={(v) => {
            setSearch(v)
            setPage(1)
          }}
          className="w-64"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="搜索…" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <div className="ml-auto flex items-center gap-2">{/* Task 6: 动作按钮 */}</div>
      </div>
```

d. 活跃筛选 Chips(工具栏下、表格上):

```tsx
      {Object.keys(filters).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {Object.keys(filters).map((name) => {
            const col = meta.data!.columns.find((c) => c.name === name)
            return (
              <Chip key={name} size="sm" onClose={() => {
                setFilters((prev) => {
                  const next = { ...prev }
                  delete next[name]
                  return next
                })
                setPage(1)
              }}>
                {col?.label ?? name}
              </Chip>
            )
          })}
          <Button size="sm" variant="ghost" onPress={() => { setFilters({}); setPage(1) }}>
            清除全部
          </Button>
        </div>
      )}
```

(若 v3 Chip 无 `onClose`,退化为 Chip + 相邻小关闭按钮。)

- [ ] **Step 3: 类型检查 + 手动冒烟**

```bash
cd web && bunx tsc --noEmit
```

冒烟(服务照 Task 4 起):名称筛选「采购」只剩匹配行;启用开关筛选生效;创建时间起止筛选生效;搜索框对 编码+名称 or-contains;筛选 Chip 可单个/全部清除;所有筛选变化后回到第 1 页。

- [ ] **Step 4: Commit**

```bash
git add web/app/components/synie-data-grid
git commit -m "feat: SynieDataGrid 列头筛选与跨列搜索"
```

---

### Task 6: 动作系统——权限门控 + 内建 mutation + 确认框 + ActionBar

**Files:**
- Create: `web/app/components/synie-data-grid/use-grid-actions.tsx`
- Modify: `web/app/components/synie-data-grid/SynieDataGrid.tsx`

**Interfaces:**
- Consumes: `meta.data.capabilities/extendedActions/destroyMutation`、`selection`/`selectedRows`、`rowsQuery.refetch`、props 的 `onCreate/onEdit/onImport/actionHandlers/bulkActions/rowActions`(print 类 Task 7 接)。
- Produces: `useGridActions(opts)` 返回 `{ toolbarActions, rowMenuFor(row), bulkBarActions, confirm, ConfirmDialog }`;内建执行器 `runIdMutation(mutation, ids)`。

- [ ] **Step 1: 写 use-grid-actions.tsx**

```tsx
import { useState, type ReactNode } from 'react'
import { AlertDialog, Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import type { ActionContext, BulkAction, GridActionMeta, GridMeta, Row, RowAction } from './types'

export interface ResolvedAction {
  key: string
  label: string
  isDanger: boolean
  run: (rows: Row[]) => void
}

interface PendingConfirm {
  label: string
  isDanger: boolean
  rows: Row[]
  execute: (rows: Row[]) => Promise<void>
}

/** 逐条执行仅吃 id 的 mutation(destroy/扩展工作流动作)。 */
// ponytail: 前端逐条循环,量大或需事务性时后端加 Ash bulk action 再切
async function runIdMutation(mutation: string, ids: string[]): Promise<{ ok: number; fail: number }> {
  let ok = 0
  let fail = 0
  for (const id of ids) {
    try {
      const data = await gqlFetch<Record<string, { errors: { message: string }[] | null }>>(
        `mutation ($id: ID!) { ${mutation}(id: $id) { errors { message } } }`,
        { id }
      )
      const errors = data[mutation]?.errors
      if (errors && errors.length > 0) fail += 1
      else ok += 1
    } catch {
      fail += 1
    }
  }
  return { ok, fail }
}

export function useGridActions(opts: {
  meta: GridMeta | undefined
  refetch: () => void
  clearSelection: () => void
  onCreate?: () => void
  onEdit?: (row: Row) => void
  onImport?: (ctx: ActionContext) => void
  onExport?: () => void
  onPrintRows?: (rows: Row[]) => void
  actionHandlers?: Record<string, (rows: Row[], ctx: ActionContext) => void>
  bulkActions?: BulkAction[]
  rowActions?: RowAction[]
}) {
  const { meta, refetch, clearSelection } = opts
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [running, setRunning] = useState(false)

  const can = (capability?: string) =>
    !capability || (meta?.capabilities ?? []).includes(capability)
  const ctx: ActionContext = { refetch }

  const confirmThenMutate = (label: string, isDanger: boolean, mutation: string) => (rows: Row[]) =>
    setPending({
      label,
      isDanger,
      rows,
      execute: async (rs) => {
        const { ok, fail } = await runIdMutation(mutation, rs.map((r) => r.id))
        if (fail === 0) toast.success(`${label}成功(${ok} 条)`)
        else toast.danger(`${label}部分失败`, { description: `成功 ${ok} 条,失败 ${fail} 条` })
        if (ok > 0) {
          refetch()
          clearSelection()
        }
      },
    })

  // 扩展动作:默认内建确认+mutation,actionHandlers[key] 覆盖
  const extendedAction = (a: GridActionMeta): ResolvedAction => ({
    key: a.key,
    label: a.label,
    isDanger: a.isDanger,
    run: opts.actionHandlers?.[a.key]
      ? (rows) => opts.actionHandlers![a.key](rows, ctx)
      : confirmThenMutate(a.label, a.isDanger, a.mutation),
  })

  const extended = (scope: 'row' | 'bulk') =>
    (meta?.extendedActions ?? [])
      .filter((a) => can(a.key) && (a.scope === scope || a.scope === 'both'))
      .map(extendedAction)

  // 工具栏:新增/导入/导出(print 由行内与批量承载)
  const toolbarActions: ResolvedAction[] = [
    ...(can('create') && opts.onCreate
      ? [{ key: 'create', label: '新增', isDanger: false, run: () => opts.onCreate!() }]
      : []),
    ...(can('import') && opts.onImport
      ? [{ key: 'import', label: '导入', isDanger: false, run: () => opts.onImport!(ctx) }]
      : []),
    ...(can('export') && opts.onExport
      ? [{ key: 'export', label: '导出', isDanger: false, run: () => opts.onExport!() }]
      : []),
  ]

  // 行内菜单
  const rowMenuFor = (row: Row): ResolvedAction[] => [
    ...(can('update') && opts.onEdit
      ? [{ key: 'edit', label: '编辑', isDanger: false, run: () => opts.onEdit!(row) }]
      : []),
    ...(can('print') && opts.onPrintRows
      ? [{ key: 'print', label: '打印', isDanger: false, run: () => opts.onPrintRows!([row]) }]
      : []),
    ...extended('row'),
    ...(opts.rowActions ?? [])
      .filter((a) => can(a.capability))
      .map((a) => ({
        key: a.key,
        label: a.label,
        isDanger: a.isDanger ?? false,
        run: () => a.onAction(row, ctx),
      })),
    ...(can('delete') && meta?.destroyMutation
      ? [{ key: 'delete', label: '删除', isDanger: true, run: confirmThenMutate('删除', true, meta.destroyMutation) }]
      : []),
  ]

  // 批量条
  const bulkBarActions: ResolvedAction[] = [
    ...(can('batch_print') && opts.onPrintRows
      ? [{ key: 'batch_print', label: '批量打印', isDanger: false, run: (rows: Row[]) => opts.onPrintRows!(rows) }]
      : []),
    ...extended('bulk'),
    ...(opts.bulkActions ?? [])
      .filter((a) => can(a.capability))
      .map((a) => ({
        key: a.key,
        label: a.label,
        isDanger: a.isDanger ?? false,
        run: (rows: Row[]) => a.onAction(rows, ctx),
      })),
    ...(can('batch_delete') && meta?.destroyMutation
      ? [{ key: 'batch_delete', label: '批量删除', isDanger: true, run: confirmThenMutate('批量删除', true, meta.destroyMutation) }]
      : []),
  ]

  const ConfirmDialog = (): ReactNode => (
    <AlertDialog.Backdrop isOpen={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialog.Container>
        <AlertDialog.Dialog className="sm:max-w-[400px]">
          {pending && (
            <>
              <AlertDialog.Header>
                <AlertDialog.Icon status={pending.isDanger ? 'danger' : 'accent'} />
                <AlertDialog.Heading>确认{pending.label}?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>将对 {pending.rows.length} 条记录执行「{pending.label}」,此操作不可撤销。</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="tertiary" isDisabled={running}>取消</Button>
                <Button
                  variant={pending.isDanger ? 'danger' : 'primary'}
                  isPending={running}
                  onPress={async () => {
                    setRunning(true)
                    try {
                      await pending.execute(pending.rows)
                    } finally {
                      setRunning(false)
                      setPending(null)
                    }
                  }}
                >
                  确认
                </Button>
              </AlertDialog.Footer>
            </>
          )}
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )

  return { toolbarActions, rowMenuFor, bulkBarActions, ConfirmDialog }
}
```

- [ ] **Step 2: SynieDataGrid 接线**

a. 组件内调用:

```tsx
  const actions = useGridActions({
    meta: meta.data,
    refetch: () => rowsQuery.refetch(),
    clearSelection: () => setSelection(new Set()),
    onCreate: props.onCreate,
    onEdit: props.onEdit,
    onImport: props.onImport,
    actionHandlers: props.actionHandlers,
    bulkActions: props.bulkActions,
    rowActions: props.rowActions,
    // onExport / onPrintRows 在 Task 7 接
  })
```

b. 工具栏右侧按钮(Task 5 预留的 `ml-auto` 容器):

```tsx
          {actions.toolbarActions.map((a) => (
            <Button
              key={a.key}
              size="sm"
              variant={a.key === 'create' ? 'primary' : 'secondary'}
              onPress={() => a.run([])}
            >
              {a.label}
            </Button>
          ))}
```

c. 行内菜单列(拼进 gridColumns 末尾,仅当该行有动作):

```tsx
import { Dropdown, Label } from '@heroui/react'

  const hasRowMenu = rows.some((r) => actions.rowMenuFor(r).length > 0)
  if (hasRowMenu) {
    gridColumns.push({
      id: '__actions',
      header: '',
      pinned: 'end',
      width: 56,
      cell: (row) => {
        const items = actions.rowMenuFor(row)
        if (items.length === 0) return null
        return (
          <Dropdown>
            <Button isIconOnly size="sm" variant="ghost" aria-label="行操作">
              <EllipsisIcon />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                onAction={(key) => items.find((a) => a.key === key)?.run([row])}
              >
                {items.map((a) => (
                  <Dropdown.Item key={a.key} id={a.key} textValue={a.label} variant={a.isDanger ? 'danger' : undefined}>
                    <Label>{a.label}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )
      },
    })
  }
```

行内 run 传 `[row]`——`ResolvedAction.run` 统一吃 `Row[]`。两个内联图标(与 FilterIcon 同风格,放 SynieDataGrid.tsx 底部):

```tsx
function EllipsisIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
      <circle cx="8" cy="3" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="8" cy="13" r="1.5" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
```

d. ActionBar(组件 JSX 末尾、ConfirmDialog 之前):

```tsx
import { ActionBar } from '@heroui-pro/react'
import { Chip, Separator } from '@heroui/react'
import { selectedRows } from './SynieDataGrid'  // 同文件内直接用

  const picked = selectedRows(selection, rows)

      <ActionBar isOpen={picked.length > 0 && actions.bulkBarActions.length > 0} aria-label="批量操作">
        <ActionBar.Prefix>
          <Chip size="sm">{picked.length}</Chip>
        </ActionBar.Prefix>
        <Separator />
        <ActionBar.Content>
          {actions.bulkBarActions.map((a) => (
            <Button
              key={a.key}
              size="sm"
              variant={a.isDanger ? 'danger-soft' : 'ghost'}
              onPress={() => a.run(picked)}
            >
              <span className="action-bar__label">{a.label}</span>
            </Button>
          ))}
        </ActionBar.Content>
        <Separator />
        <ActionBar.Suffix>
          <Button isIconOnly size="sm" variant="ghost" aria-label="取消选择" onPress={() => setSelection(new Set())}>
            <XIcon />
          </Button>
        </ActionBar.Suffix>
      </ActionBar>

      <actions.ConfirmDialog />
```

e. `selectionMode`/`showSelectionCheckboxes` 改为仅在 `actions.bulkBarActions.length > 0` 时开启。

- [ ] **Step 3: 类型检查 + 手动冒烟**

```bash
cd web && bunx tsc --noEmit
```

冒烟(试点页暂未传 onCreate/onEdit,super_admin 下应看到):行内菜单只有「删除」;选中行浮出 ActionBar 只有「批量删除」;删除/批量删除弹确认框,确认后 Toast + 列表刷新 + 选择清空;造一次失败(删掉一个已被删的行)看部分失败 Toast。

- [ ] **Step 4: Commit**

```bash
git add web/app/components/synie-data-grid
git commit -m "feat: SynieDataGrid 动作系统——权限门控、内建删除/扩展 mutation、确认框与批量条"
```

---

### Task 7: 导出 CSV + 默认打印视图

**Files:**
- Create: `web/app/components/synie-data-grid/print.ts`
- Modify: `web/app/components/synie-data-grid/SynieDataGrid.tsx`

**Interfaces:**
- Consumes: `fetchAllRows/toCsv/downloadCsv`(Task 3)、`useGridActions` 的 `onExport/onPrintRows` 入口(Task 6)。
- Produces: `printRows(columns, rows, title): void`;导出按当前筛选+排序拉全量;print 支持 `props.onPrint` 覆盖。

- [ ] **Step 1: 写 print.ts**

```ts
import type { GridColumnMeta, Row } from './types'

function cellText(col: GridColumnMeta, value: unknown): string {
  if (value == null || value === '') return ''
  if (col.type === 'boolean') return value ? '是' : '否'
  if (col.type === 'datetime') return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
  if (col.type === 'enum') return col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)
  return String(value)
}

const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** 默认打印视图:列定义渲染成打印友好表格。正式单据模板走 onPrint 覆盖。 */
export function printRows(columns: GridColumnMeta[], rows: Row[], title: string): void {
  const win = window.open('', '_blank', 'width=900,height=650')
  if (!win) return
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('')
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${esc(cellText(c, r[c.name]))}</td>`).join('')}</tr>`)
    .join('')
  win.document.write(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; }
  thead { background: #f0f0f0; }
</style></head>
<body><h1>${esc(title)}</h1><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<script>window.onload = () => { window.print(); }</script></body></html>`)
  win.document.close()
}
```

- [ ] **Step 2: SynieDataGrid 接线**

```tsx
import { fetchAllRows, toCsv, downloadCsv } from './csv'
import { printRows } from './print'

  const [exporting, setExporting] = useState(false)

  const handleExport = async () => {
    setExporting(true)
    const id = toast(`正在导出…`, { isLoading: true, timeout: 0 })
    try {
      const all = await fetchAllRows(resource, columns, filterLiteral, sortLiteral)
      downloadCsv(`${resource}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(columns, all))
      toast.close(id)
      toast.success(`已导出 ${all.length} 条`)
    } catch (e) {
      toast.close(id)
      toast.danger('导出失败', { description: (e as Error).message })
    } finally {
      setExporting(false)
    }
  }

  const handlePrintRows = (rows: Row[]) =>
    props.onPrint ? props.onPrint(rows) : printRows(columns, rows, `${resource} 打印`)
```

传入 `useGridActions({ ..., onExport: handleExport, onPrintRows: handlePrintRows })`;工具栏导出按钮加 `isPending={exporting}`(在 toolbarActions 渲染处对 `a.key === 'export'` 特判)。

- [ ] **Step 3: 类型检查 + 手动冒烟**

```bash
cd web && bunx tsc --noEmit
```

冒烟:带筛选导出 CSV,用 Excel/LibreOffice 打开确认中文表头不乱码、行数与筛选一致;行内「打印」与选中后「批量打印」弹出打印视图且自动唤起打印对话框。

- [ ] **Step 4: Commit**

```bash
git add web/app/components/synie-data-grid
git commit -m "feat: SynieDataGrid 导出 CSV 与默认打印视图"
```

---

### Task 8: 试点角色管理页完成 + 全链路验收

**Files:**
- Modify: `web/app/routes/_app/system/roles.tsx`

**Interfaces:**
- Consumes: SynieDataGrid 全部 props;GraphQL `createSysRole(input: {code, name, enabled})`、`updateSysRole(id, input: {name, enabled})`(形态同 schema_authz_test)。

- [ ] **Step 1: 完成角色页(Sheet 表单 + 新增/编辑接线)**

```tsx
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Label, Switch, TextField, toast } from '@heroui/react'
import { Sheet } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/roles')({
  component: RolesPage,
})

interface RoleForm {
  id: string | null
  code: string
  name: string
  enabled: boolean
}

const CREATE_ROLE = `
  mutation ($input: CreateSysRoleInput!) {
    createSysRole(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ROLE = `
  mutation ($id: ID!, $input: UpdateSysRoleInput!) {
    updateSysRole(id: $id, input: $input) { result { id } errors { message } }
  }
`

function RolesPage() {
  const [form, setForm] = useState<RoleForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const save = async () => {
    if (!form) return
    if (!form.code.trim() || !form.name.trim()) {
      toast.danger('请填写角色编码与名称')
      return
    }
    setSaving(true)
    try {
      const data = form.id
        ? await gqlFetch<{ updateSysRole: { errors: { message: string }[] | null } }>(UPDATE_ROLE, {
            id: form.id,
            input: { name: form.name, enabled: form.enabled },
          })
        : await gqlFetch<{ createSysRole: { errors: { message: string }[] | null } }>(CREATE_ROLE, {
            input: { code: form.code, name: form.name, enabled: form.enabled },
          })
      const errors = Object.values(data)[0]?.errors
      if (errors && errors.length > 0) {
        toast.danger('保存失败', { description: errors.map((e) => e.message).join('; ') })
        return
      }
      toast.success(form.id ? '角色已更新' : '角色已创建')
      setForm(null)
      setReloadKey((k) => k + 1) // 触发 SynieDataGrid 重挂载刷新
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">角色权限</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统角色与其权限授权。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="sysRoles"
          onCreate={() => setForm({ id: null, code: '', name: '', enabled: true })}
          onEdit={(row: Row) =>
            setForm({
              id: row.id,
              code: String(row.code ?? ''),
              name: String(row.name ?? ''),
              enabled: Boolean(row.enabled),
            })
          }
        />
      </div>

      <Sheet isOpen={form !== null} onOpenChange={(open) => !open && setForm(null)} placement="right">
        <Sheet.Backdrop>
          <Sheet.Content className="w-[400px]">
            <Sheet.Dialog className="h-full">
              <Sheet.CloseTrigger />
              <Sheet.Header>
                <Sheet.Heading>{form?.id ? '编辑角色' : '新增角色'}</Sheet.Heading>
              </Sheet.Header>
              {form && (
                <Sheet.Body className="flex flex-col gap-4">
                  <TextField
                    value={form.code}
                    onChange={(v) => setForm({ ...form, code: v })}
                    isDisabled={form.id !== null}
                    isRequired
                  >
                    <Label>角色编码</Label>
                    <TextField.Input placeholder="如 purchaser" />
                  </TextField>
                  <TextField value={form.name} onChange={(v) => setForm({ ...form, name: v })} isRequired>
                    <Label>角色名称</Label>
                    <TextField.Input placeholder="如 采购管理员" />
                  </TextField>
                  <Switch
                    isSelected={form.enabled}
                    onChange={(selected) => setForm({ ...form, enabled: selected })}
                  >
                    <Switch.Content className="text-sm">
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      启用
                    </Switch.Content>
                  </Switch>
                </Sheet.Body>
              )}
              <Sheet.Footer>
                <Sheet.Close>
                  <Button variant="secondary" isDisabled={saving}>取消</Button>
                </Sheet.Close>
                <Button onPress={save} isPending={saving}>保存</Button>
              </Sheet.Footer>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
    </>
  )
}
```

(TextField 的 onChange 若是事件而非值,以 `.d.ts` 为准调整——login.tsx 有现成用法可参照。Switch anatomy 注意 `Control` 嵌在 `Content` 内。)

- [ ] **Step 2: 类型检查**

```bash
cd web && bunx tsc --noEmit
```

- [ ] **Step 3: 全链路手动验收(playwright 或人工)**

服务照 Task 4 起,admin/admin123 登录 `/system/roles`,逐项过:

1. 列:中文表头、时间格式化、启用列 Chip。
2. 排序:编码/创建时间 升降序,翻页后排序保持。
3. 筛选:名称 contains、启用布尔、创建时间范围、组合筛选;Chip 清除;搜索框 or-contains。
4. 分页:页码/上一页/下一页/每页条数,count 正确。
5. 新增:表单校验(空值 Toast)、成功 Toast、列表出现新行;重复编码看服务端报错 Toast。
6. 编辑:编码只读、改名/停用生效。
7. 删除/批量删除:确认框文案含条数、成功 Toast、选择清空;super_admin 全按钮可见。
8. 导出:CSV 行数与筛选一致、中文不乱码。
9. 打印:单行/批量打印视图正常。
10. 权限显隐:建一个只有 `sys.role:read` 的用户(可用 iex 或临时 SQL),登录后表格可见但无新增/编辑/删除按钮;服务端兜底——直接 curl 发 destroySysRole 应被 policy 拒绝。

- [ ] **Step 4: 全量回归 + Commit**

```bash
cd backend && mix test
cd web && bunx tsc --noEmit && bun app/components/synie-data-grid/grid-checks.ts
git add web && git commit -m "feat: 角色管理试点页——SynieDataGrid 全链路(表单/动作/导出/打印)"
```

---

## 计划外(明确不做)

- 扩展动作(audit 等)的真实资源:机制已由 gridMeta 测试与 use-grid-actions 覆盖,首个使用者出现在未来业务单据表(spec「启动实现前的剩余事项」第 2 条)。
- 跨页全选、列显隐持久化、虚拟化、后端流式导出:spec 非目标/ponytail 注释的升级路径。
- `reloadKey` 重挂载刷新是试点页的偷懒做法;多页共用后若嫌重,再给 SynieDataGrid 暴露 ref/refetch。
