# 存储接入与文件管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 存储配置入库(`sys_storage`)+ S3 兼容 adapter + 系统管理两页(存储接入 `/system/storages`、文件管理 `/system/files`)。

**Architecture:** 新 Ash 资源 `SynieCore.Files.StorageEndpoint` 承载接入点配置(local seed 幂等 upsert、内置不可删、全局默认唯一可切换);`SynieCore.Storage` 门面从 config 改读数据库;新增 `SynieCore.Storage.S3` adapter(ex_aws_s3,s3/oss 共用);前端两页走 SynieDataGrid + SynieRecordDrawer 标准范式。

**Tech Stack:** Elixir umbrella + Ash 3 + AshPostgres/AshGraphql;ex_aws + ex_aws_s3 + hackney + sweet_xml;React 19 + TanStack Start + SynieDataGrid/SynieRecordDrawer。

**Spec:** `docs/superpowers/specs/2026-07-14-storage-endpoints-design.md`

## Global Constraints

- 中文第一语言:报错、描述、注释、commit 一律中文。
- mix 不在非交互 shell PATH:`export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"`(以 ~/.elixir-install 实际目录为准)。
- Postgres 在 5440(synie-pg 容器),dev/test config 已指向,无需传 PGPORT。
- 迁移:`mix ash_postgres.generate_migrations <name>` 生成,**两库**执行 `mix ecto.migrate` 与 `MIX_ENV=test mix ecto.migrate`;`mix ash.migrate` 本机失效勿用。
- 后端命令均在 `backend/` 下执行;资源级命令在 `backend/apps/synie_core/`。
- 敏感字段必须 `sensitive? true`;受审计资源 update/destroy 全部 `require_atomic? false`。
- 新权限点必须同步前端两处中文标签(permission-labels.ts、logs.tsx)。
- 提交信息结尾:`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: StorageKind 枚举 + StorageEndpoint 资源 + 注册 + 迁移 + 资源测试

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/files/storage_kind.ex`
- Create: `backend/apps/synie_core/lib/synie_core/files/storage_endpoint.ex`
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(queries/mutations/resources 三处)
- Modify: `backend/apps/synie_web/lib/synie_web/grid_meta.ex`(@resources)
- Test: `backend/apps/synie_core/test/synie_core/files/storage_endpoint_test.exs`

**Interfaces:**
- Produces: `SynieCore.Files.StorageEndpoint`(表 `sys_storage`,graphql `:sys_storage`;字段 name/label/kind/root/endpoint/region/bucket/prefix/access_key_id/secret_access_key/builtin/is_default);动作 `:create/:update/:set_default/:unset_default/:destroy`;GraphQL `sysStorages` 查询 + `createSysStorage/updateSysStorage/setDefaultSysStorage/destroySysStorage`;权限码 `sys.storage:*`。

- [ ] **Step 1: 写失败测试**

`backend/apps/synie_core/test/synie_core/files/storage_endpoint_test.exs`:

```elixir
defmodule SynieCore.Files.StorageEndpointTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Authz
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Files.StorageEndpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
    :ok
  end

  defp actor_with!(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  defp endpoint!(attrs, opts \\ []) do
    attrs =
      Map.merge(
        %{name: "ep#{System.unique_integer([:positive])}", label: "测试接入", kind: :local, root: "uploads"},
        attrs
      )

    changeset =
      StorageEndpoint
      |> Ash.Changeset.for_create(:create, attrs)

    changeset =
      Enum.reduce(Keyword.take(opts, [:builtin, :is_default]), changeset, fn {k, v}, cs ->
        Ash.Changeset.force_change_attribute(cs, k, v)
      end)

    Ash.create!(changeset, authorize?: false)
  end

  describe "权限" do
    test "无权限用户不可建,授权 sys.storage:create 后可建" do
      denied = actor_with!([])

      assert {:error, %Ash.Error.Forbidden{}} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{name: "a1", label: "本地", kind: :local, root: "up"})
               |> Ash.create(actor: denied)

      allowed = actor_with!(["sys.storage:create", "sys.storage:read"])

      assert %StorageEndpoint{name: "a1"} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{name: "a1", label: "本地", kind: :local, root: "up"})
               |> Ash.create!(actor: allowed)
    end
  end

  describe "create/update 校验" do
    test "name 格式:大写/空格/中文拒绝" do
      for bad <- ["OSS", "a b", "存储", "-a"] do
        assert {:error, %Ash.Error.Invalid{}} =
                 StorageEndpoint
                 |> Ash.Changeset.for_create(:create, %{name: bad, label: "x", kind: :local, root: "up"})
                 |> Ash.create(authorize?: false)
      end
    end

    test "name 重复报中文错" do
      endpoint!(%{name: "dup1"})

      assert {:error, err} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{name: "dup1", label: "x", kind: :local, root: "up"})
               |> Ash.create(authorize?: false)

      assert Exception.message(err) =~ "接入名已存在"
    end

    test "kind 条件必填:local 缺 root、s3 缺 endpoint/bucket/密钥 都拒绝" do
      assert {:error, _} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{name: "l1", label: "x", kind: :local})
               |> Ash.create(authorize?: false)

      assert {:error, _} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{name: "s1", label: "x", kind: :s3, endpoint: "http://e"})
               |> Ash.create(authorize?: false)

      assert %StorageEndpoint{} =
               StorageEndpoint
               |> Ash.Changeset.for_create(:create, %{
                 name: "s2",
                 label: "x",
                 kind: :s3,
                 endpoint: "http://minio:9000",
                 bucket: "b",
                 access_key_id: "ak",
                 secret_access_key: "sk"
               })
               |> Ash.create!(authorize?: false)
    end

    test "update 不接受 name/kind" do
      ep = endpoint!(%{name: "imm1"})

      updated =
        ep
        |> Ash.Changeset.for_update(:update, %{label: "改名", root: "elsewhere"})
        |> Ash.update!(authorize?: false)

      assert updated.label == "改名"

      assert {:error, %Ash.Error.Invalid{}} =
               ep
               |> Ash.Changeset.for_update(:update, %{name: "renamed"})
               |> Ash.update(authorize?: false)
    end
  end

  describe "set_default" do
    test "切换默认:旧默认自动清掉,全表恒只有一行默认" do
      a = endpoint!(%{name: "d1"}, is_default: true)
      b = endpoint!(%{name: "d2"})

      actor = actor_with!(["sys.storage:update", "sys.storage:read"])

      b |> Ash.Changeset.for_update(:set_default, %{}) |> Ash.update!(actor: actor)

      assert Ash.get!(StorageEndpoint, a.id, authorize?: false).is_default == false
      assert Ash.get!(StorageEndpoint, b.id, authorize?: false).is_default == true
    end

    test "set_default 复用 update 权限码,无权拒绝" do
      ep = endpoint!(%{name: "d3"})
      denied = actor_with!(["sys.storage:read"])

      assert {:error, %Ash.Error.Forbidden{}} =
               ep |> Ash.Changeset.for_update(:set_default, %{}) |> Ash.update(actor: denied)
    end
  end

  describe "destroy 保护" do
    test "内置行不可删" do
      ep = endpoint!(%{name: "b1"}, builtin: true)
      assert {:error, err} = Ash.destroy(ep, authorize?: false)
      assert Exception.message(err) =~ "内置存储接入不可删除"
    end

    test "默认行不可删" do
      ep = endpoint!(%{name: "df1"}, is_default: true)
      assert {:error, err} = Ash.destroy(ep, authorize?: false)
      assert Exception.message(err) =~ "默认存储接入不可删除"
    end

    test "仍有文件引用不可删" do
      ep = endpoint!(%{name: "used1"})

      StoredFile
      |> Ash.Changeset.for_create(:create, %{storage: "used1", key: "k.bin", filename: "k.bin"})
      |> Ash.create!(authorize?: false)

      assert {:error, err} = Ash.destroy(ep, authorize?: false)
      assert Exception.message(err) =~ "仍有文件存于该接入点"
    end

    test "普通行可删" do
      ep = endpoint!(%{name: "free1"})
      assert :ok = Ash.destroy(ep, authorize?: false)
    end
  end
end
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && mix test apps/synie_core/test/synie_core/files/storage_endpoint_test.exs
```
预期:编译失败(StorageEndpoint 未定义)。

- [ ] **Step 3: 写枚举与资源**

`backend/apps/synie_core/lib/synie_core/files/storage_kind.ex`:

```elixir
defmodule SynieCore.Files.StorageKind do
  @moduledoc "存储接入类型。oss 走 S3 兼容 API,与 s3 共用 adapter,仅寻址风格不同。"

  use Ash.Type.Enum, values: [local: "本地磁盘", s3: "S3 兼容", oss: "阿里云 OSS"]

  def graphql_type(_), do: :sys_storage_kind
end
```

`backend/apps/synie_core/lib/synie_core/files/storage_endpoint.ex`(三个内联校验/变更模块 + 资源本体):

```elixir
defmodule SynieCore.Files.StorageEndpoint.KindFields do
  @moduledoc "按 kind 校验配置必填:local 要 root;s3/oss 要 endpoint/bucket/access_key_id/secret_access_key。"

  use Ash.Resource.Validation

  @labels %{
    root: "根目录",
    endpoint: "服务地址",
    bucket: "Bucket",
    access_key_id: "Access Key ID",
    secret_access_key: "Secret Access Key"
  }

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :kind) do
      :local -> require_fields(changeset, [:root])
      kind when kind in [:s3, :oss] -> require_fields(changeset, [:endpoint, :bucket, :access_key_id, :secret_access_key])
      _ -> :ok
    end
  end

  defp require_fields(changeset, fields) do
    case Enum.find(fields, &blank?(Ash.Changeset.get_attribute(changeset, &1))) do
      nil -> :ok
      field -> {:error, field: field, message: "该存储类型下「#{@labels[field]}」必填"}
    end
  end

  defp blank?(nil), do: true
  defp blank?(v) when is_binary(v), do: String.trim(v) == ""
end

defmodule SynieCore.Files.StorageEndpoint.SetDefault do
  @moduledoc "设为全局默认:先清其他行 is_default 再置本行(顺序保证 partial unique index 不瞬时冲突)。"

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset
    |> Ash.Changeset.before_action(fn changeset ->
      SynieCore.Files.StorageEndpoint
      |> Ash.Query.filter(is_default == true and id != ^changeset.data.id)
      |> Ash.bulk_update!(:unset_default, %{}, authorize?: false, strategy: :stream)

      changeset
    end)
    |> Ash.Changeset.force_change_attribute(:is_default, true)
  end
end

defmodule SynieCore.Files.StorageEndpoint.DestroyGuard do
  @moduledoc "删除守卫:内置/默认/仍有文件引用的接入点不可删。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    data = changeset.data

    cond do
      data.builtin -> {:error, message: "内置存储接入不可删除"}
      data.is_default -> {:error, message: "默认存储接入不可删除,请先将其他接入点设为默认"}
      has_files?(data.name) -> {:error, message: "仍有文件存于该接入点,不可删除"}
      true -> :ok
    end
  end

  defp has_files?(name) do
    SynieCore.Files.File
    |> Ash.Query.filter(storage == ^name)
    |> Ash.exists?(authorize?: false)
  end
end

defmodule SynieCore.Files.StorageEndpoint do
  @moduledoc """
  存储接入点,对应 `sys_storage` 表。`name` 即 `sys_file.storage` 的配置名,建后不可改;
  `kind` 决定 adapter(local/s3/oss)。全局默认唯一(partial unique index),新上传落到默认
  接入点;内置 local 行由 seeds 创建,不可删除。密钥仅 `sys.storage` 权限(管理员)可读。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_storage"
    repo SynieCore.Repo

    custom_indexes do
      index [:is_default], unique: true, where: "is_default", name: "sys_storage_single_default_index"
    end
  end

  graphql do
    type :sys_storage
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 设默认是管理动作,复用 update 码不新设权限点;unset_default 仅 SetDefault 内部路径调用
    policy action([:set_default, :unset_default]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end
  end

  def permission_prefix, do: "sys.storage"
  def permission_actions, do: ~w(create read update delete)

  def display_field, do: :label

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    create :create do
      accept [
        :name,
        :label,
        :kind,
        :root,
        :endpoint,
        :region,
        :bucket,
        :prefix,
        :access_key_id,
        :secret_access_key
      ]

      validate match(:name, ~r/^[a-z0-9][a-z0-9_-]*$/),
        message: "接入名只能用小写字母、数字、中划线、下划线,且以字母或数字开头"

      validate {SynieCore.Files.StorageEndpoint.KindFields, []}
    end

    update :update do
      # name(已入库文件引用)与 kind(决定 adapter/配置形态)建后不可改
      accept [:label, :root, :endpoint, :region, :bucket, :prefix, :access_key_id, :secret_access_key]

      require_atomic? false

      validate {SynieCore.Files.StorageEndpoint.KindFields, []}
    end

    update :set_default do
      accept []
      require_atomic? false
      change SynieCore.Files.StorageEndpoint.SetDefault
    end

    # 仅供 SetDefault 清旧默认,不注册 GraphQL
    update :unset_default do
      accept []
      require_atomic? false
      change set_attribute(:is_default, false)
    end

    destroy :destroy do
      primary? true
      require_atomic? false
      validate {SynieCore.Files.StorageEndpoint.DestroyGuard, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "接入名(写入 sys_file.storage,建后不可改)"
    end

    attribute :label, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "显示名"
    end

    attribute :kind, SynieCore.Files.StorageKind do
      allow_nil? false
      public? true
      description "存储类型"
    end

    attribute :root, :string do
      public? true
      constraints max_length: 255
      description "根目录(local;相对路径按后端工作目录展开)"
    end

    attribute :endpoint, :string do
      public? true
      constraints max_length: 255
      description "服务地址(s3/oss,如 https://oss-cn-hangzhou.aliyuncs.com)"
    end

    attribute :region, :string do
      public? true
      constraints max_length: 64
      description "区域(可空,签名兜底 us-east-1)"
    end

    attribute :bucket, :string do
      public? true
      constraints max_length: 128
      description "Bucket"
    end

    attribute :prefix, :string do
      public? true
      constraints max_length: 128
      description "对象键前缀(可空,对象存储的默认路径)"
    end

    attribute :access_key_id, :string do
      public? true
      constraints max_length: 128
      description "Access Key ID"
    end

    attribute :secret_access_key, :string do
      public? true
      sensitive? true
      constraints max_length: 128
      description "Secret Access Key"
    end

    attribute :builtin, :boolean do
      allow_nil? false
      public? true
      default false
      writable? false
      description "内置"
    end

    attribute :is_default, :boolean do
      allow_nil? false
      public? true
      default false
      writable? false
      description "全局默认"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_name, [:name], message: "接入名已存在"
  end
end
```

- [ ] **Step 4: 域注册 + GridMeta 注册**

`backend/apps/synie_core/lib/synie_core.ex`:
- queries 块(挨着 sys_files 那行):`list SynieCore.Files.StorageEndpoint, :sys_storages, :read, paginate_with: :offset`
- mutations 块(挨着 destroy_sys_file):

```elixir
create SynieCore.Files.StorageEndpoint, :create_sys_storage, :create
update SynieCore.Files.StorageEndpoint, :update_sys_storage, :update
update SynieCore.Files.StorageEndpoint, :set_default_sys_storage, :set_default
destroy SynieCore.Files.StorageEndpoint, :destroy_sys_storage, :destroy
```
- resources 块:`resource SynieCore.Files.StorageEndpoint`(挨着 Files.File)

`backend/apps/synie_web/lib/synie_web/grid_meta.ex` @resources 加:`"sysStorages" => SynieCore.Files.StorageEndpoint`。

- [ ] **Step 5: 生成迁移并两库执行**

```bash
cd backend/apps/synie_core
mix ash_postgres.generate_migrations add_sys_storage
mix ecto.migrate && MIX_ENV=test mix ecto.migrate
```
检查生成的迁移含 unique_index(name) 与 partial index `sys_storage_single_default_index`。

- [ ] **Step 6: 跑测试至绿**

```bash
cd backend && mix test apps/synie_core/test/synie_core/files/storage_endpoint_test.exs
```
预期全 PASS。若 AshGraphql 编译警告 sensitive 字段可筛,按提示在 graphql 块处理(如 `filterable_fields`),保持密钥不可筛。

- [ ] **Step 7: 提交**

```bash
git add -A backend && git commit -m "sys_storage 存储接入点资源:kind 条件校验/默认唯一切换/删除三重保护"
```

---

### Task 2: sys_file destroy 挂接守卫

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/files/file.ex`
- Test: `backend/apps/synie_core/test/synie_core/files_test.exs`(追加一条)

**Interfaces:**
- Produces: `sys_file` destroy 在仍有 `sys_attachment` 引用时拒绝(中文);附件面板「先删挂接再删文件」流程不受影响。

- [ ] **Step 1: 在 files_test.exs 追加失败测试**(setup 里已有 upload 工具;放到已有 describe 外新开)

```elixir
describe "文件删除挂接守卫" do
  test "仍有挂接时拒删,解挂后可删", %{src: src} do
    actor = actor_with!(["sys.file:create", "sys.file:read", "sys.file:delete"])
    customer = customer!()

    {:ok, %{file: file, attachment: attachment}} =
      Files.upload(actor, upload_params(src, %{owner_type: "sal_customer", owner_id: customer.id}))

    assert {:error, err} = Ash.destroy(file, actor: actor)
    assert Exception.message(err) =~ "仍有业务挂接"

    :ok = Ash.destroy(attachment, actor: actor)
    assert :ok = Ash.destroy(file, actor: actor)
  end
end
```

- [ ] **Step 2: 跑该测试确认失败**(当前 destroy 直接成功,断言 {:error, _} 失败)

```bash
cd backend && mix test apps/synie_core/test/synie_core/files_test.exs
```

- [ ] **Step 3: file.ex 加守卫**

文件顶部(defmodule SynieCore.Files.File 之前)加:

```elixir
defmodule SynieCore.Files.File.AttachmentGuard do
  @moduledoc "删除文件守卫:仍有业务挂接时拒绝(附件面板先删挂接再删文件的流程不受影响)。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    attached? =
      SynieCore.Files.Attachment
      |> Ash.Query.filter(file_id == ^changeset.data.id)
      |> Ash.exists?(authorize?: false)

    if attached? do
      {:error, message: "该文件仍有业务挂接,请先在业务单据中移除附件"}
    else
      :ok
    end
  end
end
```

destroy 动作里 `change SynieCore.Files.DeleteStoredObject` 前加一行:

```elixir
validate {SynieCore.Files.File.AttachmentGuard, []}
```

- [ ] **Step 4: 跑 files_test 全绿后提交**

```bash
cd backend && mix test apps/synie_core/test/synie_core/files_test.exs
git add -A backend && git commit -m "sys_file 删除加挂接守卫:仍被业务引用时拒删"
```

---

### Task 3: Storage 门面改读数据库 + seeds + config 清理

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/storage.ex`(重写 default/conf!)
- Modify: `backend/config/runtime.exs`(删 :storages/:default_storage)
- Modify: `backend/apps/synie_core/priv/repo/seeds.exs`(追加 local upsert)
- Modify: `backend/CLAUDE.md`(文件/附件一节配置说法)
- Test: `backend/apps/synie_core/test/synie_core/storage_test.exs`(重写)、`backend/apps/synie_core/test/synie_core/files_test.exs`(setup 改 DB 行)

**Interfaces:**
- Consumes: Task 1 的 `StorageEndpoint`。
- Produces: `Storage.default/0` 查 `is_default == true` 行返回 name(无行 raise 提示跑 seeds);`Storage.conf!/1`(私有)按 name 查行,kind→adapter:local→`SynieCore.Storage.Local`(config `%{root: ep.root}`),s3/oss→`SynieCore.Storage.S3`(config `%{kind, endpoint, region, bucket, prefix, access_key_id, secret_access_key}`)。put/read/delete/presigned_url 签名不变。

- [ ] **Step 1: 重写 storage_test.exs(失败测试)**

```elixir
defmodule SynieCore.StorageTest do
  use ExUnit.Case, async: true

  require Ash.Query

  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Storage

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base =
      Path.join(System.tmp_dir!(), "synie_storage_test_#{System.unique_integer([:positive])}")

    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "src.bin")
    File.write!(src, "hello 附件")

    on_exit(fn -> File.rm_rf!(base) end)

    %{root: root, src: src}
  end

  defp endpoint!(attrs, opts \\ []) do
    changeset = Ash.Changeset.for_create(StorageEndpoint, :create, attrs)

    changeset =
      Enum.reduce(Keyword.take(opts, [:is_default]), changeset, fn {k, v}, cs ->
        Ash.Changeset.force_change_attribute(cs, k, v)
      end)

    Ash.create!(changeset, authorize?: false)
  end

  describe "Local adapter 经门面(DB 行驱动)" do
    setup %{root: root} do
      endpoint!(%{name: "test_local", label: "测试本地", kind: :local, root: root})
      :ok
    end

    test "put 后 read 取回原内容", %{src: src} do
      assert :ok = Storage.put("test_local", "2026/07/a.bin", src)
      assert {:ok, "hello 附件"} = Storage.read("test_local", "2026/07/a.bin")
    end

    test "delete 幂等,删除后 read 报 :not_found", %{src: src} do
      :ok = Storage.put("test_local", "k.bin", src)
      assert :ok = Storage.delete("test_local", "k.bin")
      assert {:error, :not_found} = Storage.read("test_local", "k.bin")
      assert :ok = Storage.delete("test_local", "k.bin")
    end

    test "key 越出 root 时拒绝", %{src: src, root: root} do
      assert {:error, :invalid_key} = Storage.put("test_local", "../escape.bin", src)
      refute File.exists?(Path.join(Path.dirname(root), "escape.bin"))
    end

    test "本地存储不支持预签名" do
      assert {:error, :unsupported} = Storage.presigned_url("test_local", "k.bin", :get, 300)
    end
  end

  test "未配置的存储名直接抛错", %{src: src} do
    assert_raise ArgumentError, ~r/nope/, fn -> Storage.put("nope", "k.bin", src) end
  end

  describe "default/0" do
    test "返回默认接入名(字符串,可直接入库)", %{root: root} do
      endpoint!(%{name: "def_local", label: "默认", kind: :local, root: root}, is_default: true)
      assert Storage.default() == "def_local"
    end

    test "无默认行时抛错提示跑 seeds" do
      assert_raise RuntimeError, ~r/seeds/, fn -> Storage.default() end
    end
  end
end
```

- [ ] **Step 2: 跑确认失败**(旧实现读 Application env,test env 已无 :storages → conf! raise;default/0 fetch_env! raise 类型不符)

```bash
cd backend && mix test apps/synie_core/test/synie_core/storage_test.exs
```

- [ ] **Step 3: 重写 storage.ex 内部**

```elixir
defmodule SynieCore.Storage do
  @moduledoc """
  文件存储门面:按接入名(`sys_storage.name`)把操作分发给对应 adapter。

  接入点在系统管理→存储接入维护;`sys_file.storage` 存接入名,换 bucket/endpoint 时
  新增一个接入点,旧文件行仍指向旧接入,无需迁移数据。
  """

  require Ash.Query

  alias SynieCore.Files.StorageEndpoint

  @adapters %{
    local: SynieCore.Storage.Local,
    s3: SynieCore.Storage.S3,
    oss: SynieCore.Storage.S3
  }

  @doc "默认存储名(字符串,可直接写入 sys_file.storage)。"
  @spec default() :: String.t()
  def default do
    StorageEndpoint
    |> Ash.Query.filter(is_default == true)
    |> Ash.read_one(authorize?: false)
    |> case do
      {:ok, %StorageEndpoint{name: name}} -> name
      _ -> raise "存储接入未初始化:没有默认接入点,请运行 seeds(priv/repo/seeds.exs)"
    end
  end

  @spec put(String.t(), String.t(), Path.t()) :: :ok | {:error, term()}
  def put(name, key, src_path) do
    {adapter, config} = conf!(name)
    adapter.put(config, key, src_path)
  end

  @spec read(String.t(), String.t()) :: {:ok, binary()} | {:error, term()}
  def read(name, key) do
    {adapter, config} = conf!(name)
    adapter.read(config, key)
  end

  @spec delete(String.t(), String.t()) :: :ok | {:error, term()}
  def delete(name, key) do
    {adapter, config} = conf!(name)
    adapter.delete(config, key)
  end

  @spec presigned_url(String.t(), String.t(), :get | :put, pos_integer()) ::
          {:ok, String.t()} | {:error, :unsupported}
  def presigned_url(name, key, method, ttl_seconds) when method in [:get, :put] do
    {adapter, config} = conf!(name)
    adapter.presigned_url(config, key, method, ttl_seconds)
  end

  defp conf!(name) do
    StorageEndpoint
    |> Ash.Query.filter(name == ^name)
    |> Ash.read_one(authorize?: false)
    |> case do
      {:ok, %StorageEndpoint{} = ep} -> {Map.fetch!(@adapters, ep.kind), config(ep)}
      _ -> raise ArgumentError, "未知的存储接入:#{inspect(name)},请在系统管理→存储接入中配置"
    end
  end

  defp config(%StorageEndpoint{kind: :local} = ep), do: %{root: ep.root}

  defp config(ep) do
    %{
      kind: ep.kind,
      endpoint: ep.endpoint,
      region: ep.region,
      bucket: ep.bucket,
      prefix: ep.prefix,
      access_key_id: ep.access_key_id,
      secret_access_key: ep.secret_access_key
    }
  end
end
```

注意:Task 4 之前 `SynieCore.Storage.S3` 未定义,@adapters 引用模块名不触发编译依赖,可先行。

- [ ] **Step 4: runtime.exs 删存储配置**

删除第 5-12 行(`# 文件存储...` 注释、`:default_storage`、`:storages` 两段 config)。

- [ ] **Step 5: files_test.exs setup 改 DB 行**

setup 里删掉 Application env 存取那两段(old_storages/old_default/put_env/restore),改为(checkout 之后):

```elixir
StorageEndpoint
|> Ash.Changeset.for_create(:create, %{name: "test_local", label: "测试本地", kind: :local, root: root})
|> Ash.Changeset.force_change_attribute(:is_default, true)
|> Ash.create!(authorize?: false)
```

alias 区加 `alias SynieCore.Files.StorageEndpoint`;`use ExUnit.Case, async: false` 可改 `async: true`(不再碰全局 env);文件顶注释同步删。全局 `grep -rn ":storages\|default_storage" backend/` 确认无残留引用(config_test.exs 等)。

- [ ] **Step 6: seeds.exs 追加 local upsert**

文件末尾追加:

```elixir
# 内置存储接入:local(全局默认,不可删除)。已存在则跳过,不覆盖用户改过的 root。
alias SynieCore.Files.StorageEndpoint

local =
  StorageEndpoint
  |> Ash.Query.filter(name == "local")
  |> Ash.read_one!(authorize?: false)

if local do
  IO.puts("存储接入 local 已存在,跳过创建")
else
  root = System.get_env("UPLOADS_ROOT") || "uploads"

  StorageEndpoint
  |> Ash.Changeset.for_create(:create, %{name: "local", label: "本地存储", kind: :local, root: root})
  |> Ash.Changeset.force_change_attribute(:builtin, true)
  |> Ash.Changeset.force_change_attribute(:is_default, true)
  |> Ash.create!(authorize?: false)

  IO.puts("已创建内置存储接入 local(根目录 #{root})")
end
```

跑一次验证幂等:

```bash
cd backend/apps/synie_core && mix run priv/repo/seeds.exs && mix run priv/repo/seeds.exs
```
预期第二次输出「已存在,跳过创建」。

- [ ] **Step 7: backend/CLAUDE.md 更新配置说法**

「文件/附件」一节,原句「存储后端在 runtime.exs `:synie_core, :storages` 配置,新后端实现 `SynieCore.Storage.Adapter`」改为:「存储接入在 `sys_storage`(系统管理→存储接入)维护,内置 local 由 seeds 创建;新后端实现 `SynieCore.Storage.Adapter` 并在 `SynieCore.Storage.@adapters` 登记 kind」。

- [ ] **Step 8: 全后端测试 + 提交**

```bash
cd backend && mix test
git add -A backend && git commit -m "Storage 门面改读 sys_storage:配置退役 runtime.exs,seeds 幂等内置 local"
```

---

### Task 4: S3 兼容 adapter(ex_aws_s3)+ MinIO 集成测试

**Files:**
- Modify: `backend/apps/synie_core/mix.exs`(deps)
- Create: `backend/apps/synie_core/lib/synie_core/storage/s3.ex`
- Test: `backend/apps/synie_core/test/synie_core/storage_s3_test.exs`
- Modify: `backend/apps/synie_core/test/test_helper.exs`(exclude :minio,若无该机制)

**Interfaces:**
- Consumes: Task 3 的 config map `%{kind, endpoint, region, bucket, prefix, access_key_id, secret_access_key}`。
- Produces: `SynieCore.Storage.S3` 实现 `SynieCore.Storage.Adapter` 四 callback;`full_key/2` 公开(prefix 拼接,单测用)。

- [ ] **Step 1: 加依赖**

`backend/apps/synie_core/mix.exs` deps 追加:

```elixir
{:ex_aws, "~> 2.5"},
{:ex_aws_s3, "~> 2.5"},
{:hackney, "~> 1.20"},
{:sweet_xml, "~> 0.7"},
```

```bash
cd backend && mix deps.get && mix compile
```

- [ ] **Step 2: 写单测(失败)**

`backend/apps/synie_core/test/synie_core/storage_s3_test.exs`:

```elixir
defmodule SynieCore.Storage.S3Test do
  use ExUnit.Case, async: true

  alias SynieCore.Storage.S3

  @config %{
    kind: :s3,
    endpoint: "http://127.0.0.1:9000",
    region: nil,
    bucket: "synie",
    prefix: "erp",
    access_key_id: "minioadmin",
    secret_access_key: "minioadmin"
  }

  describe "full_key/2" do
    test "prefix 拼在服务端 key 前,斜杠归一" do
      assert S3.full_key(@config, "2026/07/a.bin") == "erp/2026/07/a.bin"
      assert S3.full_key(%{@config | prefix: "erp/"}, "a.bin") == "erp/a.bin"
      assert S3.full_key(%{@config | prefix: nil}, "a.bin") == "a.bin"
      assert S3.full_key(%{@config | prefix: ""}, "a.bin") == "a.bin"
    end
  end

  describe "presigned_url/4" do
    test "s3(path-style):URL 指向 endpoint 主机,路径含 bucket 与完整 key,带 SigV4 参数" do
      assert {:ok, url} = S3.presigned_url(@config, "2026/07/a.bin", :get, 300)
      uri = URI.parse(url)
      assert uri.host == "127.0.0.1"
      assert uri.port == 9000
      assert uri.path == "/synie/erp/2026/07/a.bin"
      assert url =~ "X-Amz-Signature="
      assert url =~ "X-Amz-Expires=300"
    end

    test "oss(virtual-host):bucket 上主机名,路径不含 bucket" do
      config = %{@config | kind: :oss, endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou"}
      assert {:ok, url} = S3.presigned_url(config, "a.bin", :get, 300)
      uri = URI.parse(url)
      assert uri.host == "synie.oss-cn-hangzhou.aliyuncs.com"
      assert uri.path == "/erp/a.bin"
    end
  end

  describe "MinIO 集成(需本地 MinIO,mix test --include minio)" do
    @describetag :minio

    test "put/read/delete 幂等走通" do
      base = Path.join(System.tmp_dir!(), "synie_s3_test_#{System.unique_integer([:positive])}")
      File.mkdir_p!(base)
      src = Path.join(base, "src.bin")
      File.write!(src, "s3 对象内容")
      on_exit(fn -> File.rm_rf!(base) end)

      key = "t/#{System.unique_integer([:positive])}.bin"

      assert :ok = S3.put(@config, key, src)
      assert {:ok, "s3 对象内容"} = S3.read(@config, key)
      assert :ok = S3.delete(@config, key)
      assert {:error, :not_found} = S3.read(@config, key)
      assert :ok = S3.delete(@config, key)
    end
  end
end
```

`backend/apps/synie_core/test/test_helper.exs` 确认/追加 `ExUnit.start(exclude: [:minio])`(保持已有 exclude 合并)。

- [ ] **Step 3: 实现 adapter**

`backend/apps/synie_core/lib/synie_core/storage/s3.ex`:

```elixir
defmodule SynieCore.Storage.S3 do
  @moduledoc """
  S3 兼容对象存储 adapter:AWS S3、MinIO、阿里云 OSS(S3 兼容 API)共用。
  配置来自 sys_storage 行。寻址:kind=oss 用 virtual-host(OSS 要求),
  其余 path-style(MinIO/AWS 均可)。region 缺省按 us-east-1 签名。
  """

  @behaviour SynieCore.Storage.Adapter

  alias ExAws.S3

  @impl true
  def put(config, key, src_path) do
    case request(S3.put_object(bucket(config), full_key(config, key), File.read!(src_path)), config) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def read(config, key) do
    case request(S3.get_object(bucket(config), full_key(config, key)), config) do
      {:ok, %{body: body}} -> {:ok, body}
      {:error, {:http_error, 404, _}} -> {:error, :not_found}
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def delete(config, key) do
    # S3 DeleteObject 天然幂等:对象不存在同样 204
    case request(S3.delete_object(bucket(config), full_key(config, key)), config) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def presigned_url(config, key, method, ttl_seconds) when method in [:get, :put] do
    ExAws.S3.presigned_url(ex_aws_config(config), method, config.bucket, full_key(config, key),
      expires_in: ttl_seconds,
      virtual_host: virtual_host?(config)
    )
  end

  @doc "prefix 作「默认路径」拼在服务端生成的 key 前;斜杠归一,空 prefix 原样返回 key。"
  def full_key(%{prefix: prefix}, key) when is_binary(prefix) do
    case String.trim(prefix, "/") do
      "" -> key
      trimmed -> trimmed <> "/" <> key
    end
  end

  def full_key(_config, key), do: key

  # virtual-host 下 host 已带 bucket,操作路径不再含 bucket
  defp bucket(config), do: if(virtual_host?(config), do: "", else: config.bucket)

  defp virtual_host?(%{kind: :oss}), do: true
  defp virtual_host?(_config), do: false

  defp request(op, config) do
    ExAws.request(op, Map.to_list(ex_aws_config(config)) |> Keyword.take([:access_key_id, :secret_access_key, :region, :scheme, :host, :port]))
  end

  defp ex_aws_config(config) do
    uri = URI.parse(config.endpoint)
    host = if virtual_host?(config), do: "#{config.bucket}.#{uri.host}", else: uri.host

    ExAws.Config.new(:s3,
      access_key_id: config.access_key_id,
      secret_access_key: config.secret_access_key,
      region: presence(config.region) || "us-east-1",
      scheme: (uri.scheme || "https") <> "://",
      host: host,
      port: uri.port || if(uri.scheme == "http", do: 80, else: 443)
    )
  end

  defp presence(nil), do: nil
  defp presence(v), do: if(String.trim(v) == "", do: nil, else: v)
end
```

实现时对照已装的 ex_aws_s3 源码核对两点,按实际 API 微调(单测立见分晓):① `ExAws.S3.presigned_url` 首参吃 `ExAws.Config.new/2` 结果;② virtual-host 普通请求用 `bucket("")` 拼路径是否得到 `/key`(若得 `//key`,改为把 host 交给 config、op 上 `%{op | bucket: ""}` 或改用 `ExAws.Operation.S3` 的 resource 字段)。

- [ ] **Step 4: 单测跑绿**

```bash
cd backend && mix test apps/synie_core/test/synie_core/storage_s3_test.exs
```
预期非 minio 用例 PASS,minio 用例 excluded。

- [ ] **Step 5: MinIO 容器集成验证**

```bash
docker run -d --name synie-minio -p 9000:9000 minio/minio server /data
docker exec synie-minio mc alias set local http://127.0.0.1:9000 minioadmin minioadmin
docker exec synie-minio mc mb local/synie
cd backend && mix test apps/synie_core/test/synie_core/storage_s3_test.exs --include minio
```
预期含 minio 用例全 PASS。容器留着给 Task 8 端到端;若拉镜像失败,记录后跳过(单测已覆盖签名/寻址),端到端改用 local 验证。

- [ ] **Step 6: 提交**

```bash
git add -A backend && git commit -m "S3 兼容存储 adapter:ex_aws_s3,s3/oss 共用,oss virtual-host 寻址"
```

---

### Task 5: 前端接线(菜单/权限标签/审计标签/抽屉 registry)

**Files:**
- Modify: `web/app/lib/menu.ts`
- Modify: `web/app/components/synie-permission-sheet/permission-labels.ts`
- Modify: `web/app/routes/_app/system/logs.tsx`(RESOURCE_LABELS)
- Modify: `web/app/components/synie-record-drawer/registry.ts`

**Interfaces:**
- Produces: 菜单组「文件存储」(存储接入 `/system/storages`、文件管理 `/system/files`);权限矩阵/审计日志中文标签;`drawerConfig('sysStorages')`。

- [ ] **Step 1: menu.ts** system 模块 groups 里「配置」与「审计」之间插入:

```ts
{
  label: '文件存储',
  items: [
    { label: '存储接入', path: '/system/storages' },
    { label: '文件管理', path: '/system/files' },
  ],
},
```

- [ ] **Step 2: permission-labels.ts** `'sys.file': '附件'` 旁加:

```ts
'sys.storage': '存储接入',
```

- [ ] **Step 3: logs.tsx** RESOURCE_LABELS 加(对齐现有格式,sys_file 已有则只加 sys_storage):

```ts
sys_storage: '存储接入',
```

- [ ] **Step 4: registry.ts** 加(sysFiles 已有,保持):

```ts
sysStorages: { label: '存储接入' },
```

- [ ] **Step 5: 提交**

```bash
git add web && git commit -m "存储接入/文件管理:菜单与中文标签接线"
```

---

### Task 6: /system/storages 存储接入页

**Files:**
- Create: `web/app/routes/_app/system/storages.tsx`

**Interfaces:**
- Consumes: GraphQL `sysStorages` gridMeta/查询、`createSysStorage/updateSysStorage/setDefaultSysStorage`(Task 1);`drawerConfig('sysStorages')`(Task 5)。

- [ ] **Step 1: 写页面**

```tsx
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/storages')({
  component: StoragesPage,
})

const CREATE_STORAGE = `
  mutation ($input: CreateSysStorageInput!) {
    createSysStorage(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_STORAGE = `
  mutation ($id: ID!, $input: UpdateSysStorageInput!) {
    updateSysStorage(id: $id, input: $input) { result { id } errors { message } }
  }
`
const SET_DEFAULT_STORAGE = `
  mutation ($id: ID!) {
    setDefaultSysStorage(id: $id) { result { id } errors { message } }
  }
`

// 连接配置(endpoint/密钥等)不进表格,详情看抽屉;白名单同时把密钥挡在跨列搜索外
const GRID_COLUMNS = ['label', 'name', 'kind', 'isDefault', 'insertedAt']

// s3/oss 共用的对象存储字段
const isObjectStore = (v: Record<string, unknown>) => v.kind === 'S3' || v.kind === 'OSS'

function StoragesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">存储接入</h1>
      <p className="mt-2 text-sm text-ink-500">文件存储接入点:内置 local 不可删除;新上传写入默认接入点,已有文件各自留在原接入点。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="sysStorages"
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={[
            {
              key: 'setDefault',
              label: '设为默认',
              capability: 'update',
              onAction: async (row, ctx) => {
                if (row.isDefault) {
                  toast.warning('该接入点已是默认存储')
                  return
                }
                try {
                  const data = await gqlFetch<{ setDefaultSysStorage: { errors: { message: string }[] | null } }>(
                    SET_DEFAULT_STORAGE,
                    { id: row.id }
                  )
                  const errors = data.setDefaultSysStorage.errors
                  if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
                  toast.success(`已将「${String(row.label)}」设为默认存储`)
                  ctx.refetch()
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : '设为默认失败')
                }
              },
            },
          ]}
        />
      </div>

      <SynieRecordDrawer
        resource="sysStorages"
        label="存储接入"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        fields={{
          name: { order: 1, cols: 6, required: true, edit: 'createOnly', placeholder: '如 oss-hz,建后不可改' },
          label: { order: 2, cols: 6, required: true, placeholder: '如 杭州 OSS' },
          // 切换类型时清空对侧配置,避免残值随表单提交
          kind: {
            order: 3,
            cols: 6,
            required: true,
            edit: 'createOnly',
            effects: () => ({
              root: null,
              endpoint: null,
              region: null,
              bucket: null,
              prefix: null,
              accessKeyId: null,
              secretAccessKey: null,
            }),
          },
          isDefault: { order: 4, cols: 6, edit: 'readOnly' },
          builtin: { visible: () => false },
          root: {
            order: 5,
            required: true,
            visible: (v) => v.kind === 'LOCAL',
            placeholder: '如 uploads(相对后端工作目录)或 /var/synie/uploads',
          },
          endpoint: {
            order: 6,
            required: true,
            visible: isObjectStore,
            placeholder: '如 https://oss-cn-hangzhou.aliyuncs.com 或 http://minio:9000',
          },
          region: { order: 7, cols: 6, visible: isObjectStore, placeholder: '如 cn-hangzhou,可留空' },
          bucket: { order: 8, cols: 6, required: true, visible: isObjectStore },
          prefix: { order: 9, visible: isObjectStore, placeholder: '对象键前缀(默认路径),可留空' },
          accessKeyId: { order: 10, cols: 6, required: true, visible: isObjectStore },
          secretAccessKey: {
            order: 11,
            cols: 6,
            required: true,
            visible: isObjectStore,
            render: () => '••••••••',
          },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createSysStorage: { errors: { message: string }[] | null } }>(
              CREATE_STORAGE,
              { input: values }
            )
            errors = data.createSysStorage.errors
          } else {
            const data = await gqlFetch<{ updateSysStorage: { errors: { message: string }[] | null } }>(
              UPDATE_STORAGE,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateSysStorage.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '存储接入已创建' : '存储接入已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'sysStorages'] })
        }}
      />
    </>
  )
}
```

注意:`setDefaultSysStorage` 的实际签名(有无空 input 参数)以 GraphQL schema 为准,起服务后用 introspection 核对再定 mutation 串;`toast.warning` 若无此 API 按 HeroUI 实际方法名调整。

- [ ] **Step 2: 提交**

```bash
git add web && git commit -m "存储接入页:kind 联动表单+设为默认行动作"
```

---

### Task 7: /system/files 文件管理页

**Files:**
- Create: `web/app/routes/_app/system/files.tsx`

**Interfaces:**
- Consumes: `sysFiles` gridMeta/查询、`destroySysFile`(既有)、`sysAttachments` 查询(既有)、`~/lib/files.ts` 的 `downloadFile`。

- [ ] **Step 1: 写页面**

```tsx
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { downloadFile } from '~/lib/files'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/files')({
  component: FilesPage,
})

const GRID_COLUMNS = ['filename', 'storage', 'key', 'contentType', 'size', 'uploadedById', 'insertedAt']

const ATTACHMENTS_OF_FILE = `
  query ($filter: SysAttachmentFilterInput) {
    sysAttachments(filter: $filter, limit: 50) {
      count
      results { id ownerType ownerId category insertedAt }
    }
  }
`

function formatSize(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// 挂接记录:该文件被哪些业务记录引用(删除前先解除这些挂接)
function FileAttachments({ fileId }: { fileId: string }) {
  const attachments = useQuery({
    queryKey: ['fileAttachments', fileId],
    queryFn: () =>
      gqlFetch<{
        sysAttachments: {
          count: number
          results: { id: string; ownerType: string; ownerId: string; category: string; insertedAt: string }[]
        }
      }>(ATTACHMENTS_OF_FILE, { filter: `{fileId: {eq: ${JSON.stringify(fileId)}}}` }),
  })

  const rows = attachments.data?.sysAttachments.results ?? []

  return (
    <div className="mt-2">
      <h3 className="text-sm font-medium">业务挂接({attachments.data?.sysAttachments.count ?? 0})</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-ink-500">无业务挂接,可直接删除。</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm text-ink-500">
          {rows.map((a) => (
            <li key={a.id}>
              {a.ownerType} · {a.category} · {new Date(a.insertedAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FilesPage() {
  const [drawer, setDrawer] = useState<Row | null>(null)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">文件管理</h1>
      <p className="mt-2 text-sm text-ink-500">系统内所有文件对象:存储接入点、对象键与业务挂接;删除前需先解除业务挂接。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="sysFiles"
          columns={GRID_COLUMNS}
          overrides={{ size: { render: formatSize, align: 'end' } }}
          defaultSort={{ column: 'insertedAt', direction: 'descending' }}
          onView={(row) => setDrawer(row)}
        />
      </div>

      <SynieRecordDrawer
        resource="sysFiles"
        label="文件"
        mode="view"
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.id}
        fields={{ size: { render: formatSize } }}
        extraContent={(_mode, row) => (row?.id ? <FileAttachments fileId={String(row.id)} /> : null)}
        footerActions={(_mode, row) =>
          row?.id ? (
            <Button
              variant="secondary"
              onPress={() => {
                downloadFile(String(row.id), String(row.filename ?? 'file')).catch((e) =>
                  toast.error(e instanceof Error ? e.message : '下载失败')
                )
              }}
            >
              下载
            </Button>
          ) : null
        }
      />
    </>
  )
}
```

注意:`footerActions`/`overrides.align`/`defaultSort` 的确切签名以组件类型为准(SynieRecordDrawerProps / ColumnOverride / SynieDataGridProps),实现时对照类型改写;`sysAttachments` 查询串(filter 形参与 limit/offset 形态)对照既有调用(SynieAttachmentPanel)拷格式。

- [ ] **Step 2: 提交**

```bash
git add web && git commit -m "文件管理页:全量文件列表+挂接记录+下载"
```

---

### Task 8: 端到端验证 + 收尾

**Files:** 无新文件(修补在各自文件)。

- [ ] **Step 1: 后端全测 + mix format**

```bash
cd backend && mix format && mix test
git diff --stat  # format 若动了别的文件,只提交本次相关
```

- [ ] **Step 2: 起服务**

worktree 前端准备(既有坑):软链主检出 node_modules + 复制 gitignored 的 routeTree.gen.ts:

```bash
ln -s /home/zyan/code/synie/web/node_modules web/node_modules
cp /home/zyan/code/synie/web/app/routeTree.gen.ts web/app/  # dev 起来后插件会自动重生成
```

```bash
cd backend && PORT=4100 mix phx.server  # 后台
cd web && BACKEND_PORT=4100 bun run dev --host --port 3100  # 后台;命令以 package.json 为准
```

注意:umbrella 下 Phoenix code_reloader 不重编 synie_core,改后端 core 代码后须重启 phx.server。

- [ ] **Step 3: Playwright 过主流程**(admin/admin123)

1. `/system/storages`:见内置 local(默认);新建 s3 接入(指向 MinIO http://127.0.0.1:9000 / bucket synie);设为默认;尝试删 local(报「默认/内置不可删」)。
2. 业务页(如银行账户)抽屉上传附件 → MinIO 里 `mc ls` 看到对象 → 下载回内容一致(302 预签名)。
3. `/system/files`:看到该文件(storage=新接入名、key、大小);查看抽屉有挂接记录与下载;直接删该文件被拒(仍有挂接);到业务侧删附件后文件可删。
4. 把默认切回 local,删掉 s3 接入(此时无文件引用则成功;有则先清)。
5. 无 MinIO 时:以上流程用 local 走,S3 侧凭单测。

- [ ] **Step 4: 前端检查**

```bash
cd web && bun run typecheck 2>/dev/null || bunx tsc --noEmit  # 以 package.json scripts 为准
```

- [ ] **Step 5: 修补提交**

```bash
git add -A && git commit -m "存储接入/文件管理:端到端修补"
```

---

### Task 9: 开 draft PR

- [ ] **Step 1: 推分支开 PR**

```bash
git push -u origin worktree-storage-endpoints
gh pr create --draft --title "存储接入与文件管理:sys_storage 入库+S3 兼容 adapter+系统管理两页" --body "..."
```
PR body:概述(spec 链接)、后端(资源/门面/adapter/seeds)、前端(两页)、测试与验证结果、跟进项(测试连接按钮、密钥加密、OSS 真机验证)。结尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。**PR 文案脱敏:不出现内网 IP/token。**
