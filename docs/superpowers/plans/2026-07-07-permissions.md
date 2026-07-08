# Synie ERP 权限能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 spec(`docs/superpowers/specs/2026-07-07-permissions-design.md`)定义的权限能力:RBAC 功能权限(权限码 `域.资源:动作` + 通配符)+ 公司维度数据权限(fail-closed)。

**Architecture:** 权限点由代码派生(资源声明 `permission_prefix/0` 与 `permission_actions/0`),数据库仅存角色授权(`sys_role` / `sys_user_role` / `sys_role_permission`)与公司授权(`sys_company` / `sys_user_company`)。校验落在 Ash policies:全局一个 `HasPermission` SimpleCheck 管功能权限,一个 `CompanyScope` FilterCheck 管读取侧公司过滤,写入侧用 `CompanyAccessible` validation。请求期 actor 为 `SynieCore.Authz.Actor` 结构体,由 GraphQL context plug 每请求构建。

**Tech Stack:** Elixir 1.20 umbrella(apps: `synie_core`、`synie_web`),Ash ~> 3.29,AshPostgres ~> 2.10,AshGraphql ~> 1.9,Absinthe,ExUnit + Ecto SQL Sandbox。

## Global Constraints

- 项目第一语言为中文:moduledoc、注释、commit message、错误消息一律中文。
- 权限码格式:`域.资源:动作`(如 `sales.order:audit`);通配符仅两种:`前缀:*`(资源全部动作)、`域.*`(域内全部资源全部动作)。
- 动作名→权限动作码映射:`:destroy` → `"delete"`,其余动作码即动作名字符串。
- 公司数据权限 fail-closed:无 actor 或无授权公司 → 看不到任何行;`super_admin` 与 `all_companies` 例外。
- `authorize?: false` 只允许出现在受信内部路径(actor 构建、测试夹具、seeds),业务入口一律走 policies。
- 默认动作集(10 个,导入/导出天然批量,无 `batch_` 前缀):`create delete update read print import export batch_delete batch_update batch_print`。
- 数据库:synie-pg 容器,端口 5440,dev/test 配置已就绪,无需传 PGPORT。
- 工作目录为 git worktree,与主 checkout 共享同一个 dev/test 数据库;迁移会作用于共享库(本特性合并后一致,可接受)。
- 首个任务开始前需 `cd backend && mix deps.get`(worktree 内 deps/_build 独立于主 checkout 的相对路径)。
- 每个任务:先写失败测试 → 实现 → 测试通过 → 提交(TDD、小步提交)。
- commit message 结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 与 spec 的已知偏差

- spec 写"写入越权返回 Forbidden";实现为 validation 错误(`Ash.Error.Invalid`,字段级消息"无权在该公司下操作数据")。原因:Ash 的 filter check 不适用于 create,validation 是写入侧的正确挂点,且字段级错误对前端更友好。

---

### Task 1: 权限码匹配核心(纯逻辑)

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/authz/permission.ex`
- Test: `backend/apps/synie_core/test/synie_core/authz/permission_test.exs`

**Interfaces:**
- Consumes: 无(纯函数)
- Produces: `SynieCore.Authz.Permission.matches?(permissions :: Enumerable.t(String.t()), code :: String.t()) :: boolean()`;`SynieCore.Authz.Permission.default_actions() :: [String.t()]`

- [ ] **Step 0: 准备 worktree 依赖**

```bash
cd backend && mix deps.get && mix compile
```

预期:编译通过,无告警中断。

- [ ] **Step 1: 写失败测试**

创建 `backend/apps/synie_core/test/synie_core/authz/permission_test.exs`:

```elixir
defmodule SynieCore.Authz.PermissionTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.Permission

  test "精确匹配" do
    assert Permission.matches?(["sales.order:read"], "sales.order:read")
    refute Permission.matches?(["sales.order:read"], "sales.order:update")
  end

  test "资源通配:前缀:*" do
    assert Permission.matches?(["sales.order:*"], "sales.order:audit")
    refute Permission.matches?(["sales.order:*"], "sales.refund:read")
  end

  test "域通配:域.*" do
    assert Permission.matches?(["sales.*"], "sales.order:batch_delete")
    assert Permission.matches?(["sales.*"], "sales.refund:read")
    refute Permission.matches?(["sales.*"], "fi.voucher:read")
  end

  test "权限集可以是 MapSet" do
    perms = MapSet.new(["sys.role:*"])
    assert Permission.matches?(perms, "sys.role:create")
  end

  test "空权限集与畸形权限码不匹配" do
    refute Permission.matches?([], "sales.order:read")
    refute Permission.matches?(["sales.order:read"], "not-a-code")
  end

  test "无域前缀的权限码只做精确与资源通配匹配" do
    assert Permission.matches?(["hello:read"], "hello:read")
    assert Permission.matches?(["hello:*"], "hello:read")
  end

  test "默认动作集为 10 个" do
    assert Permission.default_actions() == ~w(create delete update read print import export batch_delete batch_update batch_print)
  end
end
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/permission_test.exs
```

预期:编译失败,`SynieCore.Authz.Permission is undefined`。

- [ ] **Step 3: 最小实现**

创建 `backend/apps/synie_core/lib/synie_core/authz/permission.ex`:

```elixir
defmodule SynieCore.Authz.Permission do
  @moduledoc """
  权限码工具。格式:`域.资源:动作`,如 `sales.order:audit`。

  匹配支持通配:`sales.order:*`(该资源全部动作)、`sales.*`(该域全部资源的全部动作)。
  """

  @default_actions ~w(create delete update read print import export batch_delete batch_update batch_print)

  @doc "默认动作集。资源可在 `permission_actions/0` 中增删。"
  @spec default_actions() :: [String.t()]
  def default_actions, do: @default_actions

  @doc "判断权限集(具体码或通配码)是否覆盖给定的具体权限码。"
  @spec matches?(Enumerable.t(), String.t()) :: boolean()
  def matches?(permissions, code) do
    Enum.any?(candidates(code), &(&1 in permissions))
  end

  # "sales.order:audit" 的候选:自身、"sales.order:*"、"sales.*"
  defp candidates(code) do
    case String.split(code, ":", parts: 2) do
      [prefix, _action] -> [code, prefix <> ":*" | domain_wildcard(prefix)]
      _ -> [code]
    end
  end

  defp domain_wildcard(prefix) do
    case String.split(prefix, ".", parts: 2) do
      [domain, _rest] -> [domain <> ".*"]
      _ -> []
    end
  end
end
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/permission_test.exs
```

预期:7 tests, 0 failures。

- [ ] **Step 5: 提交**

```bash
git add backend/apps/synie_core/lib/synie_core/authz/permission.ex backend/apps/synie_core/test/synie_core/authz/permission_test.exs
git commit -m "feat: 权限码匹配与默认动作集

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: RBAC 资源(sys_role / sys_user_role / sys_role_permission)+ sys_user 加列

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/authz/role.ex`
- Create: `backend/apps/synie_core/lib/synie_core/authz/user_role.ex`
- Create: `backend/apps/synie_core/lib/synie_core/authz/role_permission.ex`
- Modify: `backend/apps/synie_core/lib/synie_core/accounts/user.ex`(加 `super_admin`、`all_companies` 列与 `set_super_admin` 动作)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(注册资源)
- Modify: `backend/apps/synie_core/mix.exs`(增加 test/support 编译路径)
- Modify: `backend/apps/synie_core/priv/repo/seeds.exs`(admin 标记为超级管理员)
- Create: `backend/apps/synie_core/test/support/authz_fixtures.ex`
- Test: `backend/apps/synie_core/test/synie_core/authz/resources_test.exs`
- 迁移文件由 `mix ash_postgres.generate_migrations` 自动生成

**Interfaces:**
- Consumes: 无
- Produces:
  - 资源 `SynieCore.Authz.Role`(attrs: `id, code, name, enabled`;actions: `:create`(accept code/name/enabled)、`:read`、`:update`(accept name/enabled)、`:destroy`;identity `unique_code`)
  - 资源 `SynieCore.Authz.UserRole`(attrs: `id, user_id, role_id`;actions: `:create`(accept user_id/role_id)、`:read`、`:destroy`;identity `[user_id, role_id]`)
  - 资源 `SynieCore.Authz.RolePermission`(attrs: `id, role_id, permission`;actions: `:create`(accept role_id/permission)、`:read`、`:destroy`;identity `[role_id, permission]`)
  - `SynieCore.Accounts.User` 新增 `super_admin :: boolean`、`all_companies :: boolean`(默认 false)与 `:set_super_admin` update 动作
  - 测试夹具 `SynieCore.AuthzFixtures`:`user!(attrs \\ %{})`、`role!(attrs \\ %{})`、`grant!(role, permission :: String.t())`、`assign!(user, role)`
  - 各资源声明 `permission_prefix/0`、`permission_actions/0`(`sys.role` / `sys.user_role` / `sys.role_permission`)

- [ ] **Step 1: 打开 test/support 编译路径**

修改 `backend/apps/synie_core/mix.exs` 的 `project/0`,增加 `elixirc_paths`:

```elixir
  def project do
    [
      app: :synie_core,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.20",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]
```

- [ ] **Step 2: 写失败测试与夹具**

创建 `backend/apps/synie_core/test/support/authz_fixtures.ex`:

```elixir
defmodule SynieCore.AuthzFixtures do
  @moduledoc "权限相关测试夹具。内部路径统一 `authorize?: false`。"

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.{Role, RolePermission, UserRole}

  def user!(attrs \\ %{}) do
    attrs =
      Map.merge(
        %{username: "user_#{System.unique_integer([:positive])}", password: "secret123"},
        attrs
      )

    User
    |> Ash.Changeset.for_create(:register, attrs)
    |> Ash.create!(authorize?: false)
  end

  def role!(attrs \\ %{}) do
    attrs =
      Map.merge(
        %{code: "role_#{System.unique_integer([:positive])}", name: "测试角色"},
        attrs
      )

    Role
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  def grant!(role, permission) do
    RolePermission
    |> Ash.Changeset.for_create(:create, %{role_id: role.id, permission: permission})
    |> Ash.create!(authorize?: false)
  end

  def assign!(user, role) do
    UserRole
    |> Ash.Changeset.for_create(:create, %{user_id: user.id, role_id: role.id})
    |> Ash.create!(authorize?: false)
  end
end
```

创建 `backend/apps/synie_core/test/synie_core/authz/resources_test.exs`:

```elixir
defmodule SynieCore.Authz.ResourcesTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "创建角色、授权、指派用户" do
    user = user!()
    role = role!(%{code: "sales_clerk", name: "销售员"})
    grant!(role, "sales.order:read")
    grant!(role, "sales.order:create")
    assign!(user, role)

    assert role.enabled
    assert to_string(role.code) == "sales_clerk"
  end

  test "角色 code 唯一" do
    role!(%{code: "dup_role"})

    assert_raise Ash.Error.Invalid, fn ->
      role!(%{code: "dup_role"})
    end
  end

  test "同一用户不能重复指派同一角色" do
    user = user!()
    role = role!()
    assign!(user, role)

    assert_raise Ash.Error.Invalid, fn ->
      assign!(user, role)
    end
  end

  test "同一角色不能重复授予同一权限码" do
    role = role!()
    grant!(role, "sys.role:read")

    assert_raise Ash.Error.Invalid, fn ->
      grant!(role, "sys.role:read")
    end
  end

  test "新用户默认不是超级管理员" do
    user = user!()
    refute user.super_admin
    refute user.all_companies
  end

  test "set_super_admin 动作" do
    user = user!()

    updated =
      user
      |> Ash.Changeset.for_update(:set_super_admin, %{})
      |> Ash.update!(authorize?: false)

    assert updated.super_admin
  end

  test "资源声明了权限前缀与动作集" do
    assert SynieCore.Authz.Role.permission_prefix() == "sys.role"
    assert SynieCore.Authz.Role.permission_actions() == ~w(create read update delete)
    assert SynieCore.Authz.UserRole.permission_prefix() == "sys.user_role"
    assert SynieCore.Authz.RolePermission.permission_prefix() == "sys.role_permission"
  end
end
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/resources_test.exs
```

预期:编译失败,`SynieCore.Authz.Role is undefined`。

- [ ] **Step 4: 实现三个资源**

创建 `backend/apps/synie_core/lib/synie_core/authz/role.ex`:

```elixir
defmodule SynieCore.Authz.Role do
  @moduledoc "角色,对应 `sys_role` 表。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_role"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_role
  end

  def permission_prefix, do: "sys.role"
  def permission_actions, do: ~w(create read update delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:code, :name, :enabled]
    end

    update :update do
      accept [:name, :enabled]
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
    end

    attribute :enabled, :boolean do
      allow_nil? false
      public? true
      default true
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  identities do
    identity :unique_code, [:code]
  end
end
```

创建 `backend/apps/synie_core/lib/synie_core/authz/user_role.ex`:

```elixir
defmodule SynieCore.Authz.UserRole do
  @moduledoc "用户-角色关联,对应 `sys_user_role` 表。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_user_role"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_user_role
  end

  def permission_prefix, do: "sys.user_role"
  def permission_actions, do: ~w(create read delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:user_id, :role_id]
    end
  end

  attributes do
    uuid_primary_key :id

    create_timestamp :inserted_at
  end

  relationships do
    belongs_to :user, SynieCore.Accounts.User do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end

    belongs_to :role, SynieCore.Authz.Role do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_user_role, [:user_id, :role_id]
  end
end
```

创建 `backend/apps/synie_core/lib/synie_core/authz/role_permission.ex`:

```elixir
defmodule SynieCore.Authz.RolePermission do
  @moduledoc "角色-权限码授权,对应 `sys_role_permission` 表。权限码可为通配(`sales.order:*`、`sales.*`)。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_role_permission"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_role_permission
  end

  def permission_prefix, do: "sys.role_permission"
  def permission_actions, do: ~w(create read delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:role_id, :permission]
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :permission, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
    end

    create_timestamp :inserted_at
  end

  relationships do
    belongs_to :role, SynieCore.Authz.Role do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_role_permission, [:role_id, :permission]
  end
end
```

- [ ] **Step 5: sys_user 加列与动作**

修改 `backend/apps/synie_core/lib/synie_core/accounts/user.ex`:

在 `actions do` 块末尾(`read :by_username` 之后)追加:

```elixir
    update :set_super_admin do
      accept []

      change set_attribute(:super_admin, true)
    end
```

在 `attributes do` 块中 `hashed_password` 之后追加:

```elixir
    attribute :super_admin, :boolean do
      allow_nil? false
      default false
    end

    attribute :all_companies, :boolean do
      allow_nil? false
      default false
    end
```

- [ ] **Step 6: 注册资源到域**

修改 `backend/apps/synie_core/lib/synie_core.ex` 的 `resources` 块:

```elixir
  resources do
    resource SynieCore.Resources.Hello
    resource SynieCore.Accounts.User
    resource SynieCore.Authz.Role
    resource SynieCore.Authz.UserRole
    resource SynieCore.Authz.RolePermission
  end
```

- [ ] **Step 7: 生成并执行迁移**

```bash
cd backend/apps/synie_core && mix ash_postgres.generate_migrations --name add_authz_tables
```

预期:生成一个迁移文件,包含 `sys_role`、`sys_user_role`、`sys_role_permission` 三张表(含唯一索引与外键)以及 `sys_user` 的 `super_admin`、`all_companies` 两列。检查生成内容无误后:

```bash
cd backend/apps/synie_core && mix ecto.migrate && MIX_ENV=test mix ecto.migrate
```

预期:两个环境迁移成功。

- [ ] **Step 8: 运行测试确认通过**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/resources_test.exs
```

预期:7 tests, 0 failures。

- [ ] **Step 9: 更新 seeds,admin 标记为超级管理员**

覆写 `backend/apps/synie_core/priv/repo/seeds.exs`:

```elixir
# 初始化系统用户。
# 运行:cd backend/apps/synie_core && mix run priv/repo/seeds.exs

require Ash.Query

alias SynieCore.Accounts.User

username = "admin"

user =
  User
  |> Ash.Query.filter(username == ^username)
  |> Ash.read_one!(authorize?: false)

user =
  if user do
    IO.puts("用户 #{username} 已存在,跳过创建")
    user
  else
    created =
      User
      |> Ash.Changeset.for_create(:register, %{
        username: username,
        name: "系统管理员",
        password: "admin123"
      })
      |> Ash.create!(authorize?: false)

    IO.puts("已创建用户 #{username}(初始密码 admin123)")
    created
  end

unless user.super_admin do
  user
  |> Ash.Changeset.for_update(:set_super_admin, %{})
  |> Ash.update!(authorize?: false)

  IO.puts("已将 #{username} 标记为超级管理员")
end
```

验证:

```bash
cd backend/apps/synie_core && mix run priv/repo/seeds.exs
```

预期:输出"已存在,跳过创建"与"已标记为超级管理员"(或全新创建的两条输出)。

- [ ] **Step 10: 全量回归后提交**

```bash
cd backend/apps/synie_core && mix test
```

预期:全部通过(既有 accounts/config/hello 测试不受影响)。

```bash
git add backend/apps/synie_core
git commit -m "feat: RBAC 资源(角色/用户角色/角色权限)与超级管理员标记

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 公司资源(sys_company / sys_user_company)

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/org/company.ex`
- Create: `backend/apps/synie_core/lib/synie_core/authz/user_company.ex`
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(注册资源)
- Modify: `backend/apps/synie_core/test/support/authz_fixtures.ex`(增加 company!/grant_company!)
- Test: `backend/apps/synie_core/test/synie_core/org/company_test.exs`
- 迁移文件自动生成

**Interfaces:**
- Consumes: Task 2 的夹具模块
- Produces:
  - 资源 `SynieCore.Org.Company`(attrs: `id, code, name, parent_id`;actions: `:create`(accept code/name/parent_id)、`:read`、`:update`(accept name/parent_id)、`:destroy`;identity `unique_code`;`permission_prefix/0` 返回 `"org.company"`)
  - 资源 `SynieCore.Authz.UserCompany`(attrs: `id, user_id, company_id`;actions: `:create`(accept user_id/company_id)、`:read`、`:destroy`;identity `[user_id, company_id]`;`permission_prefix/0` 返回 `"sys.user_company"`)
  - 夹具新增:`company!(attrs \\ %{})`、`grant_company!(user, company)`

- [ ] **Step 1: 写失败测试**

创建 `backend/apps/synie_core/test/synie_core/org/company_test.exs`:

```elixir
defmodule SynieCore.Org.CompanyTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "创建公司树" do
    group = company!(%{code: "group", name: "集团"})
    sub = company!(%{code: "sub_a", name: "子公司A", parent_id: group.id})

    assert sub.parent_id == group.id
    assert is_nil(group.parent_id)
  end

  test "公司 code 唯一" do
    company!(%{code: "dup_co"})

    assert_raise Ash.Error.Invalid, fn ->
      company!(%{code: "dup_co"})
    end
  end

  test "用户授权公司,不能重复授权" do
    user = user!()
    company = company!()
    grant_company!(user, company)

    assert_raise Ash.Error.Invalid, fn ->
      grant_company!(user, company)
    end
  end

  test "资源声明了权限前缀" do
    assert SynieCore.Org.Company.permission_prefix() == "org.company"
    assert SynieCore.Authz.UserCompany.permission_prefix() == "sys.user_company"
  end
end
```

在 `backend/apps/synie_core/test/support/authz_fixtures.ex` 中追加两个函数(`assign!/2` 之后),并把 alias 行改为包含新资源:

```elixir
  alias SynieCore.Authz.{Role, RolePermission, UserCompany, UserRole}
  alias SynieCore.Org.Company
```

```elixir
  def company!(attrs \\ %{}) do
    attrs =
      Map.merge(
        %{code: "co_#{System.unique_integer([:positive])}", name: "测试公司"},
        attrs
      )

    Company
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  def grant_company!(user, company) do
    UserCompany
    |> Ash.Changeset.for_create(:create, %{user_id: user.id, company_id: company.id})
    |> Ash.create!(authorize?: false)
  end
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend/apps/synie_core && mix test test/synie_core/org/company_test.exs
```

预期:编译失败,`SynieCore.Org.Company is undefined`。

- [ ] **Step 3: 实现资源**

创建 `backend/apps/synie_core/lib/synie_core/org/company.ex`:

```elixir
defmodule SynieCore.Org.Company do
  @moduledoc "公司(ERPNext 式多公司,单库),对应 `sys_company` 表,树形结构支持集团/合并视角。"

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_company"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_company
  end

  def permission_prefix, do: "org.company"
  def permission_actions, do: ~w(create read update delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:code, :name, :parent_id]
    end

    update :update do
      accept [:name, :parent_id]
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  relationships do
    belongs_to :parent, __MODULE__ do
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_code, [:code]
  end
end
```

创建 `backend/apps/synie_core/lib/synie_core/authz/user_company.ex`:

```elixir
defmodule SynieCore.Authz.UserCompany do
  @moduledoc """
  用户-公司数据权限授权,对应 `sys_user_company` 表。

  语义为显式授权(fail-closed):用户仅能看到被授权公司的数据;
  跨公司人员用 `sys_user.all_companies` 覆盖。授权挂用户不挂角色。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource]

  postgres do
    table "sys_user_company"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_user_company
  end

  def permission_prefix, do: "sys.user_company"
  def permission_actions, do: ~w(create read delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:user_id, :company_id]
    end
  end

  attributes do
    uuid_primary_key :id

    create_timestamp :inserted_at
  end

  relationships do
    belongs_to :user, SynieCore.Accounts.User do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end

    belongs_to :company, SynieCore.Org.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
    end
  end

  identities do
    identity :unique_user_company, [:user_id, :company_id]
  end
end
```

修改 `backend/apps/synie_core/lib/synie_core.ex` 的 `resources` 块为:

```elixir
  resources do
    resource SynieCore.Resources.Hello
    resource SynieCore.Accounts.User
    resource SynieCore.Authz.Role
    resource SynieCore.Authz.UserRole
    resource SynieCore.Authz.RolePermission
    resource SynieCore.Authz.UserCompany
    resource SynieCore.Org.Company
  end
```

- [ ] **Step 4: 生成并执行迁移**

```bash
cd backend/apps/synie_core && mix ash_postgres.generate_migrations --name add_org_company
```

检查生成的迁移含 `sys_company`(自引用外键 parent_id)与 `sys_user_company`,然后:

```bash
cd backend/apps/synie_core && mix ecto.migrate && MIX_ENV=test mix ecto.migrate
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd backend/apps/synie_core && mix test test/synie_core/org/company_test.exs
```

预期:4 tests, 0 failures。

- [ ] **Step 6: 提交**

```bash
git add backend/apps/synie_core
git commit -m "feat: 公司与用户公司授权资源(多公司数据权限基础)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Actor 构建(请求期权限主体)

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/authz/actor.ex`
- Create: `backend/apps/synie_core/lib/synie_core/authz.ex`
- Test: `backend/apps/synie_core/test/synie_core/authz_test.exs`

**Interfaces:**
- Consumes: Task 2/3 的资源与夹具
- Produces:
  - `SynieCore.Authz.Actor` 结构体:`%Actor{user_id, username, super_admin: false, all_companies: false, permissions: MapSet.new(), company_ids: []}`
  - `SynieCore.Authz.build_actor(user :: User.t()) :: Actor.t()`
  - `SynieCore.Authz.has_permission?(Actor.t() | nil, String.t()) :: boolean()`

- [ ] **Step 1: 写失败测试**

创建 `backend/apps/synie_core/test/synie_core/authz_test.exs`:

```elixir
defmodule SynieCore.AuthzTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Authz.Actor

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  test "build_actor 汇总多角色权限并去重" do
    user = user!()
    role_a = role!()
    role_b = role!()
    grant!(role_a, "sales.order:read")
    grant!(role_a, "sales.order:create")
    grant!(role_b, "sales.order:read")
    assign!(user, role_a)
    assign!(user, role_b)

    actor = Authz.build_actor(user)

    assert actor.permissions == MapSet.new(["sales.order:read", "sales.order:create"])
    assert actor.user_id == user.id
    refute actor.super_admin
  end

  test "禁用角色的权限不生效" do
    user = user!()
    role = role!(%{enabled: false})
    grant!(role, "sales.order:read")
    assign!(user, role)

    actor = Authz.build_actor(user)

    assert MapSet.size(actor.permissions) == 0
  end

  test "无角色用户得到空权限集" do
    actor = Authz.build_actor(user!())

    assert MapSet.size(actor.permissions) == 0
    assert actor.company_ids == []
  end

  test "build_actor 加载授权公司" do
    user = user!()
    co_a = company!()
    co_b = company!()
    grant_company!(user, co_a)
    grant_company!(user, co_b)

    actor = Authz.build_actor(user)

    assert Enum.sort(actor.company_ids) == Enum.sort([co_a.id, co_b.id])
  end

  test "has_permission? 支持通配与超级管理员" do
    assert Authz.has_permission?(%Actor{user_id: "x", super_admin: true}, "anything.at:all")

    actor = %Actor{user_id: "x", permissions: MapSet.new(["sales.*"])}
    assert Authz.has_permission?(actor, "sales.order:audit")
    refute Authz.has_permission?(actor, "fi.voucher:read")

    refute Authz.has_permission?(nil, "sales.order:read")
  end
end
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz_test.exs
```

预期:编译失败,`SynieCore.Authz is undefined`。

- [ ] **Step 3: 实现**

创建 `backend/apps/synie_core/lib/synie_core/authz/actor.ex`:

```elixir
defmodule SynieCore.Authz.Actor do
  @moduledoc """
  请求期权限主体,作为 Ash actor 使用。

  在登录解析后由 `SynieCore.Authz.build_actor/1` 构建,
  携带用户的权限码集合(含通配)与授权公司范围。
  """

  @enforce_keys [:user_id]
  defstruct [
    :user_id,
    :username,
    super_admin: false,
    all_companies: false,
    permissions: MapSet.new(),
    company_ids: []
  ]

  @type t :: %__MODULE__{
          user_id: String.t(),
          username: String.t() | nil,
          super_admin: boolean(),
          all_companies: boolean(),
          permissions: MapSet.t(String.t()),
          company_ids: [String.t()]
        }
end
```

创建 `backend/apps/synie_core/lib/synie_core/authz.ex`:

```elixir
defmodule SynieCore.Authz do
  @moduledoc "权限领域服务:actor 构建与权限判定。"

  require Ash.Query

  alias SynieCore.Authz.{Actor, Permission, Role, RolePermission, UserCompany, UserRole}

  @doc """
  为用户构建请求期 actor,加载权限集(仅启用角色)与授权公司。

  内部读取使用 `authorize?: false`:此时 actor 尚未建立,
  且这些系统表本身受权限保护,属于受信内部路径。
  """
  @spec build_actor(SynieCore.Accounts.User.t()) :: Actor.t()
  def build_actor(user) do
    %Actor{
      user_id: user.id,
      username: to_string(user.username),
      super_admin: user.super_admin,
      all_companies: user.all_companies,
      permissions: load_permissions(user.id),
      company_ids: load_company_ids(user.id)
    }
  end

  @doc "判断 actor 是否拥有权限码(超级管理员恒真;nil actor 恒假)。"
  @spec has_permission?(Actor.t() | nil, String.t()) :: boolean()
  def has_permission?(%Actor{super_admin: true}, _code), do: true
  def has_permission?(%Actor{permissions: perms}, code), do: Permission.matches?(perms, code)
  def has_permission?(nil, _code), do: false

  defp load_permissions(user_id) do
    role_ids =
      UserRole
      |> Ash.Query.filter(user_id == ^user_id)
      |> Ash.read!(authorize?: false)
      |> Enum.map(& &1.role_id)

    enabled_ids =
      Role
      |> Ash.Query.filter(id in ^role_ids and enabled == true)
      |> Ash.read!(authorize?: false)
      |> Enum.map(& &1.id)

    RolePermission
    |> Ash.Query.filter(role_id in ^enabled_ids)
    |> Ash.read!(authorize?: false)
    |> MapSet.new(& &1.permission)
  end

  defp load_company_ids(user_id) do
    UserCompany
    |> Ash.Query.filter(user_id == ^user_id)
    |> Ash.read!(authorize?: false)
    |> Enum.map(& &1.company_id)
  end
end
```

> ponytail: 每请求 4 条索引查询构建 actor,量大后换 ETS 缓存(key: user_id + 版本号)。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz_test.exs
```

预期:5 tests, 0 failures。

- [ ] **Step 5: 提交**

```bash
git add backend/apps/synie_core
git commit -m "feat: 请求期 Actor 构建与权限判定服务

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: HasPermission check 并给系统资源接上 policies

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/authz/checks/has_permission.ex`
- Modify: `backend/apps/synie_core/lib/synie_core/authz/role.ex`(authorizer + policies)
- Modify: `backend/apps/synie_core/lib/synie_core/authz/user_role.ex`(同上)
- Modify: `backend/apps/synie_core/lib/synie_core/authz/role_permission.ex`(同上)
- Modify: `backend/apps/synie_core/lib/synie_core/authz/user_company.ex`(同上)
- Modify: `backend/apps/synie_core/lib/synie_core/org/company.ex`(同上)
- Test: `backend/apps/synie_core/test/synie_core/authz/policies_test.exs`

**Interfaces:**
- Consumes: `SynieCore.Authz.has_permission?/2`(Task 4)、资源的 `permission_prefix/0`(Task 2/3)
- Produces: `SynieCore.Authz.Checks.HasPermission`(`Ash.Policy.SimpleCheck`,可挂到任何声明了 `permission_prefix/0` 的资源)

- [ ] **Step 1: 写失败测试**

创建 `backend/apps/synie_core/test/synie_core/authz/policies_test.exs`:

```elixir
defmodule SynieCore.Authz.PoliciesTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Authz.Role

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp actor_with(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  test "无 actor 读取被拒绝" do
    assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Role, actor: nil)
  end

  test "无对应权限的 actor 被拒绝" do
    actor = actor_with(["org.company:read"])

    assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Role, actor: actor)
  end

  test "拥有 sys.role:read 可读取角色" do
    actor = actor_with(["sys.role:read"])

    assert {:ok, _roles} = Ash.read(Role, actor: actor)
  end

  test "域通配 sys.* 覆盖角色读取" do
    actor = actor_with(["sys.*"])

    assert {:ok, _roles} = Ash.read(Role, actor: actor)
  end

  test "拥有 sys.role:create 可建角色,无权限不可" do
    can = actor_with(["sys.role:create"])
    cannot = actor_with(["sys.role:read"])

    assert {:ok, _} =
             Role
             |> Ash.Changeset.for_create(:create, %{code: "r_#{System.unique_integer([:positive])}", name: "新角色"}, actor: can)
             |> Ash.create()

    assert {:error, %Ash.Error.Forbidden{}} =
             Role
             |> Ash.Changeset.for_create(:create, %{code: "r_#{System.unique_integer([:positive])}", name: "新角色"}, actor: cannot)
             |> Ash.create()
  end

  test "destroy 动作映射为 delete 权限码" do
    actor = actor_with(["sys.role:read", "sys.role:delete"])
    role = role!()

    assert :ok = role |> Ash.Changeset.for_destroy(:destroy, %{}, actor: actor) |> Ash.destroy()
  end

  test "超级管理员绕过全部策略" do
    user = user!()

    super_admin =
      user
      |> Ash.Changeset.for_update(:set_super_admin, %{})
      |> Ash.update!(authorize?: false)
      |> Authz.build_actor()

    assert {:ok, _} = Ash.read(Role, actor: super_admin)
  end
end
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/policies_test.exs
```

预期:失败——资源尚无 authorizer,`Ash.read(Role, actor: nil)` 返回 `{:ok, _}` 而非 Forbidden。

- [ ] **Step 3: 实现 check**

创建 `backend/apps/synie_core/lib/synie_core/authz/checks/has_permission.ex`:

```elixir
defmodule SynieCore.Authz.Checks.HasPermission do
  @moduledoc """
  通用功能权限 check:由资源的 `permission_prefix/0` 与动作名派生权限码,
  与 actor 权限集(含通配)匹配。

  动作码映射:`:destroy` → `"delete"`;其余动作码即动作名
  (`:read` → `"read"`、`:batch_delete` → `"batch_delete"`、`:audit` → `"audit"`)。
  资源未声明 `permission_prefix/0` 时恒拒绝(fail-closed)。
  """

  use Ash.Policy.SimpleCheck

  alias SynieCore.Authz

  @impl true
  def describe(_opts), do: "actor 拥有当前资源动作的权限码"

  @impl true
  def match?(actor, %{resource: resource, action: action}, _opts) do
    Code.ensure_loaded?(resource) and
      function_exported?(resource, :permission_prefix, 0) and
      Authz.has_permission?(actor, resource.permission_prefix() <> ":" <> action_code(action))
  end

  defp action_code(%{name: :destroy}), do: "delete"
  defp action_code(%{name: name}), do: to_string(name)
end
```

- [ ] **Step 4: 给五个系统资源接上 policies**

对 `Role`、`UserRole`、`RolePermission`、`UserCompany`、`Company` 五个资源做同样的两处修改。

其一,`use Ash.Resource` 增加 authorizer(以 Role 为例,其余四个相同):

```elixir
  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer]
```

其二,在 `postgres do ... end` 块之后增加 policies 块(五个资源逐字相同):

```elixir
  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end
```

- [ ] **Step 5: 运行测试确认通过,并全量回归**

```bash
cd backend/apps/synie_core && mix test
```

预期:全部通过。夹具与 `Authz.build_actor/1` 内部读取均已使用 `authorize?: false`,不受新 policies 影响;若有测试因缺 actor 失败,修正该测试为经夹具(`authorize?: false`)操作,而非放宽策略。

- [ ] **Step 6: 提交**

```bash
git add backend/apps/synie_core
git commit -m "feat: HasPermission 策略检查并保护权限系统资源

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 公司维度数据权限(CompanyScope filter check + 写入校验)

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/authz/checks/company_scope.ex`
- Create: `backend/apps/synie_core/lib/synie_core/authz/validations/company_accessible.ex`
- Create: `backend/apps/synie_core/test/support/test_domain.ex`(ETS 测试域 + 公司范围测试资源)
- Test: `backend/apps/synie_core/test/synie_core/authz/company_scope_test.exs`

**Interfaces:**
- Consumes: `SynieCore.Authz.Actor`(Task 4)、`HasPermission`(Task 5)
- Produces:
  - `SynieCore.Authz.Checks.CompanyScope`(`Ash.Policy.FilterCheck`,要求资源有 `company_id` 属性)
  - `SynieCore.Authz.Validations.CompanyAccessible`(`Ash.Resource.Validation`,挂在 create/update 动作)
  - 业务资源接入公司维度的标准写法(见 Step 3 的 `SynieCore.Test.Doc`,即参考样板)

- [ ] **Step 1: 写测试资源与失败测试**

创建 `backend/apps/synie_core/test/support/test_domain.ex`:

```elixir
defmodule SynieCore.Test.Domain do
  @moduledoc "测试专用 Ash 域(ETS 数据层),用于验证策略组件而不依赖真实业务表。"

  use Ash.Domain, validate_config_inclusion?: false

  resources do
    resource SynieCore.Test.Doc
  end
end

defmodule SynieCore.Test.Doc do
  @moduledoc """
  公司范围资源的参考样板:业务资源接入权限的标准写法照抄此处——
  声明 permission_prefix/permission_actions、三段 policies、写入动作挂 CompanyAccessible。
  """

  use Ash.Resource,
    domain: SynieCore.Test.Domain,
    data_layer: Ash.DataLayer.Ets,
    authorizers: [Ash.Policy.Authorizer]

  ets do
    private? true
  end

  def permission_prefix, do: "test.doc"
  def permission_actions, do: ~w(create read delete)

  actions do
    defaults [:read, :destroy]

    create :create do
      accept [:title, :company_id]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :title, :string, public?: true

    attribute :company_id, :uuid do
      allow_nil? false
      public? true
    end
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end
end
```

创建 `backend/apps/synie_core/test/synie_core/authz/company_scope_test.exs`:

```elixir
defmodule SynieCore.Authz.CompanyScopeTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.Actor
  alias SynieCore.Test.Doc

  @co_a Ash.UUID.generate()
  @co_b Ash.UUID.generate()

  defp seed_docs! do
    for {title, co} <- [{"A1", @co_a}, {"A2", @co_a}, {"B1", @co_b}] do
      Doc
      |> Ash.Changeset.for_create(:create, %{title: title, company_id: co})
      |> Ash.create!(authorize?: false)
    end
  end

  defp actor(overrides \\ %{}) do
    struct!(
      %Actor{user_id: Ash.UUID.generate(), permissions: MapSet.new(["test.doc:*"])},
      overrides
    )
  end

  test "读取仅返回授权公司的行" do
    seed_docs!()

    docs = Ash.read!(Doc, actor: actor(%{company_ids: [@co_a]}))

    assert Enum.map(docs, & &1.title) |> Enum.sort() == ["A1", "A2"]
  end

  test "fail-closed:无授权公司则看不到任何行" do
    seed_docs!()

    assert Ash.read!(Doc, actor: actor()) == []
  end

  test "all_companies 看到全部行" do
    seed_docs!()

    docs = Ash.read!(Doc, actor: actor(%{all_companies: true}))

    assert length(docs) == 3
  end

  test "super_admin 看到全部行" do
    seed_docs!()

    docs = Ash.read!(Doc, actor: actor(%{super_admin: true, permissions: MapSet.new()}))

    assert length(docs) == 3
  end

  test "写入:只能在授权公司下创建" do
    a_user = actor(%{company_ids: [@co_a]})

    assert {:ok, _} =
             Doc
             |> Ash.Changeset.for_create(:create, %{title: "ok", company_id: @co_a}, actor: a_user)
             |> Ash.create()

    assert {:error, %Ash.Error.Invalid{}} =
             Doc
             |> Ash.Changeset.for_create(:create, %{title: "bad", company_id: @co_b}, actor: a_user)
             |> Ash.create()
  end

  test "写入:all_companies 可在任意公司创建" do
    assert {:ok, _} =
             Doc
             |> Ash.Changeset.for_create(:create, %{title: "any", company_id: @co_b}, actor: actor(%{all_companies: true}))
             |> Ash.create()
  end

  test "功能权限仍然生效:无 test.doc 权限即使公司匹配也被拒" do
    no_perm = actor(%{permissions: MapSet.new(), company_ids: [@co_a]})

    assert {:error, %Ash.Error.Forbidden{}} = Ash.read(Doc, actor: no_perm)
  end
end
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/company_scope_test.exs
```

预期:编译失败,`SynieCore.Authz.Checks.CompanyScope is undefined`。

- [ ] **Step 3: 实现 filter check 与 validation**

创建 `backend/apps/synie_core/lib/synie_core/authz/checks/company_scope.ex`:

```elixir
defmodule SynieCore.Authz.Checks.CompanyScope do
  @moduledoc """
  公司维度数据权限(filter check):读取/更新/删除自动限制在
  actor 授权公司范围内。fail-closed:无 actor 或无授权 → 空集。

  仅适用于带 `company_id` 属性的资源;`super_admin` 与 `all_companies` 不受限。
  后续新增数据维度(如部门)时,新写一个同形态的 check,不改本模块。
  """

  use Ash.Policy.FilterCheck

  import Ash.Expr

  alias SynieCore.Authz.Actor

  @impl true
  def describe(_opts), do: "限制在 actor 授权公司范围内"

  @impl true
  def filter(%Actor{super_admin: true}, _authorizer, _opts), do: expr(true)
  def filter(%Actor{all_companies: true}, _authorizer, _opts), do: expr(true)
  def filter(%Actor{company_ids: ids}, _authorizer, _opts), do: expr(company_id in ^ids)
  def filter(_actor, _authorizer, _opts), do: expr(false)
end
```

创建 `backend/apps/synie_core/lib/synie_core/authz/validations/company_accessible.ex`:

```elixir
defmodule SynieCore.Authz.Validations.CompanyAccessible do
  @moduledoc """
  写入侧公司校验:changeset 的 `company_id` 必须在 actor 授权范围内。

  actor 为 nil 时放行:外部请求先经策略层拦截,能以 nil actor 到达此处的
  只有 `authorize?: false` 的受信内部调用(seeds、后台任务、测试夹具)。
  """

  use Ash.Resource.Validation

  alias SynieCore.Authz.Actor

  @impl true
  def validate(changeset, _opts, %{actor: actor}) do
    case actor do
      nil -> :ok
      %Actor{super_admin: true} -> :ok
      %Actor{all_companies: true} -> :ok
      %Actor{company_ids: ids} -> check_company(changeset, ids)
    end
  end

  defp check_company(changeset, ids) do
    company_id = Ash.Changeset.get_attribute(changeset, :company_id)

    if company_id in ids do
      :ok
    else
      {:error, field: :company_id, message: "无权在该公司下操作数据"}
    end
  end
end
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/company_scope_test.exs
```

预期:7 tests, 0 failures。若 `expr(true)` / `expr(false)` 因 Ash 版本差异报错,改用等价写法 `expr(1 == 1)` / `expr(1 == 0)`。

- [ ] **Step 5: 提交**

```bash
git add backend/apps/synie_core
git commit -m "feat: 公司维度数据权限(读取过滤 + 写入校验)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 权限点目录(Registry)

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/authz/registry.ex`
- Test: `backend/apps/synie_core/test/synie_core/authz/registry_test.exs`

**Interfaces:**
- Consumes: 域内资源的 `permission_prefix/0`、`permission_actions/0`;`SynieCore.Authz.Permission.matches?/2`
- Produces:
  - `SynieCore.Authz.Registry.catalog() :: [%{prefix: String.t(), actions: [String.t()]}]`
  - `SynieCore.Authz.Registry.all_codes() :: [String.t()]`
  - `SynieCore.Authz.Registry.granted_codes(Actor.t()) :: [String.t()]`(通配已展开为具体码;super_admin 得到全部)

- [ ] **Step 1: 写失败测试**

创建 `backend/apps/synie_core/test/synie_core/authz/registry_test.exs`:

```elixir
defmodule SynieCore.Authz.RegistryTest do
  use ExUnit.Case, async: true

  alias SynieCore.Authz.{Actor, Registry}

  test "catalog 包含全部声明了权限前缀的资源" do
    prefixes = Registry.catalog() |> Enum.map(& &1.prefix) |> Enum.sort()

    assert prefixes ==
             Enum.sort(~w(sys.role sys.user_role sys.role_permission sys.user_company org.company))
  end

  test "all_codes 展开为 前缀:动作" do
    codes = Registry.all_codes()

    assert "sys.role:create" in codes
    assert "sys.role:delete" in codes
    assert "org.company:update" in codes
    refute "sys.role:print" in codes
  end

  test "granted_codes 将通配展开为具体码" do
    actor = %Actor{user_id: "x", permissions: MapSet.new(["sys.role:*"])}

    assert Enum.sort(Registry.granted_codes(actor)) ==
             Enum.sort(~w(sys.role:create sys.role:read sys.role:update sys.role:delete))
  end

  test "granted_codes 域通配展开" do
    actor = %Actor{user_id: "x", permissions: MapSet.new(["org.*"])}

    assert Enum.sort(Registry.granted_codes(actor)) ==
             Enum.sort(~w(org.company:create org.company:read org.company:update org.company:delete))
  end

  test "super_admin 得到全部权限码" do
    actor = %Actor{user_id: "x", super_admin: true}

    assert Registry.granted_codes(actor) == Registry.all_codes()
  end
end
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/registry_test.exs
```

预期:编译失败,`SynieCore.Authz.Registry is undefined`。

- [ ] **Step 3: 实现**

创建 `backend/apps/synie_core/lib/synie_core/authz/registry.ex`:

```elixir
defmodule SynieCore.Authz.Registry do
  @moduledoc """
  权限点目录:从代码派生(遍历域内声明了 `permission_prefix/0` 的资源),
  不入库。供角色配置界面渲染权限树,以及把通配授权展开为具体码下发前端。
  """

  alias SynieCore.Authz.{Actor, Permission}

  # ponytail: 目前只有一个域;拆多域时把这里改成遍历域列表即可。
  @domains [SynieCore]

  @doc "权限组列表:[%{prefix, actions}]。"
  @spec catalog() :: [%{prefix: String.t(), actions: [String.t()]}]
  def catalog do
    @domains
    |> Enum.flat_map(&Ash.Domain.Info.resources/1)
    |> Enum.filter(&permission_source?/1)
    |> Enum.map(&%{prefix: &1.permission_prefix(), actions: &1.permission_actions()})
  end

  @doc "全部具体权限码。"
  @spec all_codes() :: [String.t()]
  def all_codes do
    for %{prefix: prefix, actions: actions} <- catalog(), action <- actions do
      prefix <> ":" <> action
    end
  end

  @doc "actor 实际生效的具体权限码(通配已展开;super_admin 得到全部)。"
  @spec granted_codes(Actor.t()) :: [String.t()]
  def granted_codes(%Actor{super_admin: true}), do: all_codes()

  def granted_codes(%Actor{permissions: perms}) do
    Enum.filter(all_codes(), &Permission.matches?(perms, &1))
  end

  defp permission_source?(module) do
    Code.ensure_loaded?(module) and function_exported?(module, :permission_prefix, 0)
  end
end
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend/apps/synie_core && mix test test/synie_core/authz/registry_test.exs
```

预期:5 tests, 0 failures。

- [ ] **Step 5: 提交**

```bash
git add backend/apps/synie_core
git commit -m "feat: 代码派生的权限点目录

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: GraphQL 接入(actor 植入、权限查询、系统资源管理 API)

**Files:**
- Modify: `backend/apps/synie_web/lib/synie_web/plugs/graphql_context.ex`(构建并植入 actor)
- Modify: `backend/apps/synie_web/lib/synie_web/schema.ex`(my_permissions、permission_catalog)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(域级 graphql queries/mutations)
- Modify: `backend/apps/synie_web/test/test_helper.exs`(SQL Sandbox manual 模式)
- Test: `backend/apps/synie_web/test/synie_web/schema_authz_test.exs`

**Interfaces:**
- Consumes: `SynieCore.Authz.build_actor/1`、`SynieCore.Authz.Registry.{catalog,granted_codes}/0,1`、五个系统资源
- Produces:
  - Absinthe context 携带 `:actor`(`SynieCore.Authz.Actor`),AshGraphql 自动用于策略判定
  - GraphQL 字段:`myPermissions: [String!]!`、`permissionCatalog: [PermissionGroup!]!`(`PermissionGroup{prefix, actions}`)
  - GraphQL CRUD:`sysRoles/sysCompanies/...` 查询与 `createSysRole/...` 变更(全部受策略保护)

- [ ] **Step 1: 写失败测试**

修改 `backend/apps/synie_web/test/test_helper.exs` 为:

```elixir
ExUnit.start()
Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, :manual)
```

创建 `backend/apps/synie_web/test/synie_web/schema_authz_test.exs`:

```elixir
defmodule SynieWeb.SchemaAuthzTest do
  use ExUnit.Case, async: true

  alias SynieCore.Accounts.User
  alias SynieCore.Authz
  alias SynieCore.Authz.{Role, RolePermission, UserRole}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  # synie_core 的 test/support 不跨应用共享,这里内联最小夹具
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
      |> Ash.Changeset.for_create(:create, %{code: "r_#{System.unique_integer([:positive])}", name: "角色"})
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

  defp run!(doc, actor) do
    {:ok, result} = Absinthe.run(doc, SynieWeb.Schema, context: %{actor: actor})
    result
  end

  test "无 sys.role:read 权限查询 sysRoles 报错" do
    actor = Authz.build_actor(user_with!([]))

    result = run!("query { sysRoles { id } }", actor)

    assert result[:errors] != nil and result[:errors] != []
  end

  test "拥有 sys.role:read 可查询 sysRoles" do
    actor = Authz.build_actor(user_with!(["sys.role:read"]))

    result = run!("query { sysRoles { id code } }", actor)

    assert %{data: %{"sysRoles" => roles}} = result
    assert is_list(roles) and roles != []
  end

  test "拥有 sys.role:create 可通过 mutation 建角色" do
    actor = Authz.build_actor(user_with!(["sys.role:create"]))

    result =
      run!(
        ~s|mutation { createSysRole(input: {code: "gql_role", name: "GQL角色"}) { result { id code } errors { message } } }|,
        actor
      )

    assert %{data: %{"createSysRole" => %{"result" => %{"code" => "gql_role"}}}} = result
  end

  test "myPermissions 返回展开后的具体权限码" do
    actor = Authz.build_actor(user_with!(["sys.role:*"]))

    result = run!("query { myPermissions }", actor)

    assert %{data: %{"myPermissions" => codes}} = result
    assert "sys.role:read" in codes
    assert "sys.role:delete" in codes
    refute "org.company:read" in codes
  end

  test "未登录 myPermissions 返回空列表" do
    result = run!("query { myPermissions }", nil)

    assert %{data: %{"myPermissions" => []}} = result
  end

  test "permissionCatalog 返回权限组" do
    actor = Authz.build_actor(user_with!([]))

    result = run!("query { permissionCatalog { prefix actions } }", actor)

    assert %{data: %{"permissionCatalog" => groups}} = result
    assert Enum.any?(groups, &(&1["prefix"] == "sys.role"))
  end
end
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend/apps/synie_web && mix test test/synie_web/schema_authz_test.exs
```

预期:失败,`sysRoles`/`myPermissions` 等字段不存在(schema 未定义)。

- [ ] **Step 3: 域级暴露 GraphQL CRUD**

修改 `backend/apps/synie_core/lib/synie_core.ex` 的 `graphql do end` 块为:

```elixir
  graphql do
    queries do
      list SynieCore.Authz.Role, :sys_roles, :read
      list SynieCore.Authz.UserRole, :sys_user_roles, :read
      list SynieCore.Authz.RolePermission, :sys_role_permissions, :read
      list SynieCore.Authz.UserCompany, :sys_user_companies, :read
      list SynieCore.Org.Company, :sys_companies, :read
    end

    mutations do
      create SynieCore.Authz.Role, :create_sys_role, :create
      update SynieCore.Authz.Role, :update_sys_role, :update
      destroy SynieCore.Authz.Role, :destroy_sys_role, :destroy

      create SynieCore.Authz.UserRole, :create_sys_user_role, :create
      destroy SynieCore.Authz.UserRole, :destroy_sys_user_role, :destroy

      create SynieCore.Authz.RolePermission, :create_sys_role_permission, :create
      destroy SynieCore.Authz.RolePermission, :destroy_sys_role_permission, :destroy

      create SynieCore.Org.Company, :create_sys_company, :create
      update SynieCore.Org.Company, :update_sys_company, :update
      destroy SynieCore.Org.Company, :destroy_sys_company, :destroy

      create SynieCore.Authz.UserCompany, :create_sys_user_company, :create
      destroy SynieCore.Authz.UserCompany, :destroy_sys_user_company, :destroy
    end
  end
```

- [ ] **Step 4: context plug 构建 actor**

修改 `backend/apps/synie_web/lib/synie_web/plugs/graphql_context.ex`:

```elixir
defmodule SynieWeb.Plugs.GraphqlContext do
  @moduledoc """
  从 `Authorization: Bearer <token>` 解析当前用户,构建权限 actor,
  写入 Absinthe context(`current_user`、`actor`)并设置 Ash actor。
  """

  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case current_user(conn) do
      nil ->
        conn

      user ->
        actor = SynieCore.Authz.build_actor(user)

        conn
        |> Ash.PlugHelpers.set_actor(actor)
        |> Absinthe.Plug.put_options(context: %{current_user: user, actor: actor})
    end
  end

  defp current_user(conn) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         {:ok, user_id} <- SynieWeb.Auth.verify_token(token) do
      SynieCore.Accounts.get_user(user_id)
    else
      _ -> nil
    end
  end
end
```

- [ ] **Step 5: schema 增加权限查询字段**

修改 `backend/apps/synie_web/lib/synie_web/schema.ex`,在 `object :login_result` 之后增加:

```elixir
  object :permission_group do
    field :prefix, non_null(:string)
    field :actions, non_null(list_of(non_null(:string)))
  end
```

在 `query do` 块内 `me` 字段之后增加:

```elixir
    field :my_permissions, non_null(list_of(non_null(:string))) do
      resolve(fn _args, %{context: context} ->
        case context[:actor] do
          nil -> {:ok, []}
          actor -> {:ok, SynieCore.Authz.Registry.granted_codes(actor)}
        end
      end)
    end

    field :permission_catalog, non_null(list_of(non_null(:permission_group))) do
      resolve(fn _args, _resolution ->
        {:ok, SynieCore.Authz.Registry.catalog()}
      end)
    end
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd backend/apps/synie_web && mix test test/synie_web/schema_authz_test.exs
```

预期:6 tests, 0 failures。

排障提示:若 `createSysRole` 的 result 包装结构与断言不符(AshGraphql 版本差异,可能直接返回对象而非 `{result, errors}`),先运行查询打印 `result` 实际结构,再按实际结构调整断言与 mutation 文档;若 AshGraphql 未从 context 读到 actor 导致"有权限仍被拒",确认 context key 为 `:actor` 且值非 nil。

- [ ] **Step 7: 全量回归与提交**

```bash
cd backend && mix test
```

预期:两个应用全部测试通过。

```bash
git add backend
git commit -m "feat: GraphQL 权限接入(actor 植入、权限查询与系统资源管理 API)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 完成标准

- `cd backend && mix test` 全绿。
- 手工冒烟(可选):`mix run priv/repo/seeds.exs` 后启动服务,用 admin 登录调 `myPermissions`,应返回全部权限码(super_admin)。
- spec 各项均有对应实现:权限码与通配(T1)、RBAC 三表(T2)、公司两表(T3)、actor(T4)、功能权限策略(T5)、公司数据权限 fail-closed(T6)、权限目录(T7)、GraphQL 下发与管理 API(T8)。
