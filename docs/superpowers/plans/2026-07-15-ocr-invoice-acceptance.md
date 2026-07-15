# 票据 OCR(增值税发票 + 承兑汇票)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发票/承兑接收创建动线中上传票据图片 → 阿里云 OCR 识别 → 预填表单,保存后原图自动挂为附件;凭证存 `acc_setting` 财务设置表(系统管理页可配)。

**Architecture:** 后端新增 `SynieCore.Ocr`(签名器 + Req HTTP 客户端 + 字段映射器 + 门面),以 generic action 挂在 `VatInvoice`/`BillTransaction` 上暴露为 GraphQL mutation(权限复用 create);新增单行资源 `acc_setting` 存凭证;`SynieCore.Files.attach` + REST 端点补"给已有文件挂附件"能力。前端一个共享 `SynieOcrButton` 组件接入两条创建动线。

**Tech Stack:** Elixir umbrella(Ash 3 + AshGraphql + Phoenix)、Req(新增)、React(Tanstack Start + HeroUI v3)、TanStack Query。

**设计文档:** `docs/superpowers/specs/2026-07-15-ocr-invoice-acceptance-design.md`

## Global Constraints

- 项目第一语言中文:注释、错误信息、UI 文案、commit message 均中文。
- 跑 mix 前必须 `export PATH="/home/zyan/.elixir-install/installs/elixir/1.20.2-otp-28/bin:/home/zyan/.elixir-install/installs/otp/28.4/bin:$PATH"`;后端命令都在 `backend/` 下执行。Postgres 在 5440(synie-pg 容器),dev/test config 默认已指向,无需传参。
- 前端 worktree 无 node_modules,先软链主仓:`ln -sfn /home/zyan/code/synie/web/node_modules <worktree>/web/node_modules`;前端命令在 `web/` 下用 `bun` 执行。
- 后端约定(backend/CLAUDE.md):新资源接审计 fragment;受审计资源 update/destroy 加 `require_atomic? false`;敏感字段标 `sensitive? true`;衍生动作用 `{HasPermission, as: "create"}` 复用权限码;新资源/动作同步补 `web/app/components/synie-permission-sheet/permission-labels.ts` 与 `web/app/routes/_app/system/logs.tsx` 中文标签。
- 前端约定(web/CLAUDE.md):非幂等请求必有 toast 反馈;文件上传下载只走 `~/lib/files.ts`;优先 HeroUI 现成组件。
- 迁移:用 `mix ash.codegen <name>` 生成、`mix ecto.migrate` 执行(`ash.migrate` 在本项目曾失效,不要用)。
- 生成的迁移文件可以手工编辑(本计划要求给 acc_setting 补 seed INSERT)。
- 每个任务完成即 commit,message 末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 阿里云 V3 签名器 AliyunSigner(含 Req 依赖引入)

**Files:**
- Modify: `backend/apps/synie_core/mix.exs`(deps 列表)
- Create: `backend/apps/synie_core/lib/synie_core/ocr/aliyun_signer.ex`
- Test: `backend/apps/synie_core/test/synie_core/ocr/aliyun_signer_test.exs`

**Interfaces:**
- Consumes: 无(纯函数模块)
- Produces: `AliyunSigner.headers(host, action, version, body, creds, opts \\ [])` → `[{String.t(), String.t()}]`(含 `authorization`);`creds` 是 `%{access_key_id: String.t(), access_key_secret: String.t()}`;`opts` 支持 `:date`(`"2026-07-15T00:00:00Z"` 格式)与 `:nonce` 注入。`AliyunSigner.canonical_request/5` 公开(便于对拍测试)。

- [ ] **Step 1: 加 Req 依赖**

在 `backend/apps/synie_core/mix.exs` 的 `defp deps` 列表中(`{:ex_aws, "~> 2.5"},` 之前)加:

```elixir
      # 阿里云 OCR HTTP 客户端(Req.Test 可注入 plug,测试不出网)
      {:req, "~> 0.5"},
```

然后 `cd backend && mix deps.get`,确认 lock 里出现 req/finch。

- [ ] **Step 2: 写失败测试**

`backend/apps/synie_core/test/synie_core/ocr/aliyun_signer_test.exs`:

```elixir
defmodule SynieCore.Ocr.AliyunSignerTest do
  use ExUnit.Case, async: true

  alias SynieCore.Ocr.AliyunSigner

  @creds %{access_key_id: "testAccessKeyId", access_key_secret: "testSecret"}
  @date "2026-07-15T00:00:00Z"
  @nonce "fixednonce123"
  # sha256("abc") 的十六进制
  @abc_sha256 "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

  test "canonical_request 按 V3 规范拼装(头部升序、尾随换行、空查询串)" do
    headers = [
      {"content-type", "application/octet-stream"},
      {"host", "ocr-api.cn-hangzhou.aliyuncs.com"},
      {"x-acs-action", "RecognizeInvoice"},
      {"x-acs-content-sha256", @abc_sha256},
      {"x-acs-date", @date},
      {"x-acs-signature-nonce", @nonce},
      {"x-acs-version", "2021-07-07"}
    ]

    expected =
      Enum.join(
        [
          "POST",
          "/",
          "",
          "content-type:application/octet-stream\n" <>
            "host:ocr-api.cn-hangzhou.aliyuncs.com\n" <>
            "x-acs-action:RecognizeInvoice\n" <>
            "x-acs-content-sha256:#{@abc_sha256}\n" <>
            "x-acs-date:#{@date}\n" <>
            "x-acs-signature-nonce:#{@nonce}\n" <>
            "x-acs-version:2021-07-07\n",
          "content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
          @abc_sha256
        ],
        "\n"
      )

    assert AliyunSigner.canonical_request("POST", "/", "", headers, @abc_sha256) == expected
  end

  test "headers/6 产出全套请求头与正确签名" do
    headers = AliyunSigner.headers("ocr-api.cn-hangzhou.aliyuncs.com", "RecognizeInvoice", "2021-07-07", "abc", @creds, date: @date, nonce: @nonce)
    map = Map.new(headers)

    assert map["x-acs-content-sha256"] == @abc_sha256
    assert map["x-acs-date"] == @date
    assert map["x-acs-signature-nonce"] == @nonce
    assert map["host"] == "ocr-api.cn-hangzhou.aliyuncs.com"
    assert map["content-type"] == "application/octet-stream"

    # 用文档公式独立复算签名对拍(HMAC-SHA256 → 小写 hex)
    signed_names = "content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version"

    canonical =
      AliyunSigner.canonical_request(
        "POST",
        "/",
        "",
        headers |> Enum.reject(fn {k, _} -> k == "authorization" end),
        @abc_sha256
      )

    string_to_sign =
      "ACS3-HMAC-SHA256\n" <> (:crypto.hash(:sha256, canonical) |> Base.encode16(case: :lower))

    signature =
      :crypto.mac(:hmac, :sha256, @creds.access_key_secret, string_to_sign)
      |> Base.encode16(case: :lower)

    assert map["authorization"] ==
             "ACS3-HMAC-SHA256 Credential=testAccessKeyId,SignedHeaders=#{signed_names},Signature=#{signature}"
  end

  test "缺省 date/nonce 自动生成且格式合法" do
    headers = AliyunSigner.headers("h", "A", "V", "", @creds)
    map = Map.new(headers)
    assert map["x-acs-date"] =~ ~r/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    assert map["x-acs-signature-nonce"] =~ ~r/^[0-9a-f]{32}$/
  end
end
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/ocr/aliyun_signer_test.exs`
Expected: FAIL(module SynieCore.Ocr.AliyunSigner is not available)

- [ ] **Step 4: 实现签名器**

`backend/apps/synie_core/lib/synie_core/ocr/aliyun_signer.ex`:

```elixir
defmodule SynieCore.Ocr.AliyunSigner do
  @moduledoc """
  阿里云 OpenAPI V3 签名(ACS3-HMAC-SHA256),用于 ocr-api 等 RPC 风格接口的
  POST + 二进制 body 调用(CanonicalURI 恒为 "/",无查询参数)。
  时间与 nonce 可由调用方经 opts 注入,便于测试对拍。
  """

  @algorithm "ACS3-HMAC-SHA256"

  @doc """
  构造带签名的请求头。返回 `[{name, value}]`,含 `authorization`;
  头名全小写、按 ASCII 升序(参与签名的顺序即发送顺序)。
  """
  @spec headers(String.t(), String.t(), String.t(), binary(), map(), keyword()) ::
          [{String.t(), String.t()}]
  def headers(host, action, version, body, creds, opts \\ []) do
    date = Keyword.get_lazy(opts, :date, &utc_now/0)
    nonce = Keyword.get_lazy(opts, :nonce, &random_nonce/0)
    payload_hash = hex_sha256(body)

    signed = [
      {"content-type", "application/octet-stream"},
      {"host", host},
      {"x-acs-action", action},
      {"x-acs-content-sha256", payload_hash},
      {"x-acs-date", date},
      {"x-acs-signature-nonce", nonce},
      {"x-acs-version", version}
    ]

    canonical = canonical_request("POST", "/", "", signed, payload_hash)
    string_to_sign = @algorithm <> "\n" <> hex_sha256(canonical)

    signature =
      :crypto.mac(:hmac, :sha256, creds.access_key_secret, string_to_sign)
      |> Base.encode16(case: :lower)

    authorization =
      "#{@algorithm} Credential=#{creds.access_key_id}," <>
        "SignedHeaders=#{signed_names(signed)},Signature=#{signature}"

    signed ++ [{"authorization", authorization}]
  end

  @doc """
  V3 CanonicalRequest。CanonicalHeaders 每行以 \\n 结尾(与 SignedHeaders 之间
  因此隔一个空行),整体各段再以 \\n 连接——与 AWS SigV4 同构,勿"修掉"空行。
  """
  @spec canonical_request(String.t(), String.t(), String.t(), [{String.t(), String.t()}], String.t()) ::
          String.t()
  def canonical_request(method, uri, query, headers, payload_hash) do
    canonical_headers = Enum.map_join(headers, fn {k, v} -> "#{k}:#{v}\n" end)
    Enum.join([method, uri, query, canonical_headers, signed_names(headers), payload_hash], "\n")
  end

  defp signed_names(headers), do: Enum.map_join(headers, ";", &elem(&1, 0))

  defp hex_sha256(data), do: :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)

  defp utc_now do
    DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  end

  defp random_nonce, do: :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower)
end
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && mix test apps/synie_core/test/synie_core/ocr/aliyun_signer_test.exs`
Expected: 3 tests, 0 failures

- [ ] **Step 6: Commit**

```bash
git add backend/apps/synie_core/mix.exs backend/mix.lock backend/apps/synie_core/lib/synie_core/ocr/aliyun_signer.ex backend/apps/synie_core/test/synie_core/ocr/aliyun_signer_test.exs
git commit -m "feat(ocr): 阿里云 OpenAPI V3 签名器 + req 依赖"
```

---

### Task 2: 财务设置资源 acc_setting(单行表 + seed + GraphQL)

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/acc/setting.ex`
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(queries/mutations/resources 三处)
- Create: 迁移(由 `mix ash.codegen add_acc_setting` 生成后手工补 seed)
- Modify: `backend/CLAUDE.md`(权限一节后补一行财务全局配置约定)
- Test: `backend/apps/synie_core/test/synie_core/acc/setting_test.exs`

**Interfaces:**
- Consumes: `SynieCore.Audit.Fragment`、`SynieCore.Authz.Checks.HasPermission`(既有)
- Produces: 资源 `SynieCore.Acc.Setting`(表 `acc_setting`,单行,迁移 seed 保证恒存在);`Setting.get/0` → `%Setting{} | nil`(内部读,`authorize?: false`);GraphQL:query `accSetting`(read_one)、query `accOcrConfigured`(boolean,登录即可)、mutation `updateAccSetting`;权限码 `acc.setting:read` / `acc.setting:update`

- [ ] **Step 1: 写失败测试**

`backend/apps/synie_core/test/synie_core/acc/setting_test.exs`(actor 夹具照 `files_test.exs` 的 `actor_with!` 写法):

```elixir
defmodule SynieCore.Acc.SettingTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.Setting
  alias SynieCore.Authz

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

  test "迁移 seed 保证单行存在,get/0 可取" do
    assert %Setting{} = Setting.get()
  end

  test "有 acc.setting:update 权限可更新凭证" do
    actor = actor_with!(["acc.setting:update", "acc.setting:read"])

    setting =
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{ocr_access_key_id: "ak", ocr_access_key_secret: "sk"})
      |> Ash.update!(actor: actor)

    assert setting.ocr_access_key_id == "ak"
  end

  test "无权限者读到空(read 策略过滤不报错)、写被拒绝" do
    actor = actor_with!([])

    assert {:ok, []} = Ash.read(Setting, actor: actor)

    assert_raise Ash.Error.Forbidden, fn ->
      Setting.get()
      |> Ash.Changeset.for_update(:update, %{ocr_access_key_id: "x"})
      |> Ash.update!(actor: actor)
    end
  end

  test "ocr_configured:登录即可查,双凭证齐才为 true" do
    actor = actor_with!([])

    configured? = fn ->
      Setting
      |> Ash.ActionInput.for_action(:ocr_configured, %{})
      |> Ash.run_action!(actor: actor)
    end

    refute configured?.()

    Setting.get()
    |> Ash.Changeset.for_update(:update, %{ocr_access_key_id: "ak", ocr_access_key_secret: "sk"})
    |> Ash.update!(authorize?: false)

    assert configured?.()
  end
end
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/acc/setting_test.exs`
Expected: FAIL(SynieCore.Acc.Setting is not available)

- [ ] **Step 3: 实现资源**

`backend/apps/synie_core/lib/synie_core/acc/setting.ex`:

```elixir
defmodule SynieCore.Acc.Setting do
  @moduledoc """
  财务设置,对应 `acc_setting` 单行表:财务域全局配置(非公司维度)统一加字段进这张表,
  不另建配置表。行由迁移 seed、恒存在——不开放 create/destroy,只有 update。
  当前字段:阿里云 OCR 凭证(发票/承兑识别用,见 `SynieCore.Ocr`)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "acc_setting"
    repo SynieCore.Repo
  end

  graphql do
    type :acc_setting
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :update]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 配置态布尔只用于前端 OCR 按钮防呆,不含凭证内容,登录即可读
    policy action(:ocr_configured) do
      authorize_if actor_present()
    end
  end

  def permission_prefix, do: "acc.setting"
  def permission_actions, do: ~w(read update)

  actions do
    read :read do
      primary? true
    end

    update :update do
      accept [:ocr_access_key_id, :ocr_access_key_secret]
      require_atomic? false
    end

    action :ocr_configured, :boolean do
      description "阿里云 OCR 凭证是否已配置(供前端 OCR 按钮防呆)"

      run fn _input, _context ->
        # DSL run 闭包内 alias 不生效(同 bank_reconciliation :remaining 先例),全限定
        configured =
          case SynieCore.Acc.Setting.get() do
            %{ocr_access_key_id: ak, ocr_access_key_secret: sk} ->
              is_binary(ak) and String.trim(ak) != "" and
                is_binary(sk) and String.trim(sk) != ""

            nil ->
              false
          end

        {:ok, configured}
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :ocr_access_key_id, :string do
      public? true
      constraints max_length: 128
      description "阿里云 OCR AccessKey ID"
    end

    attribute :ocr_access_key_secret, :string do
      public? true
      sensitive? true
      constraints max_length: 128
      description "阿里云 OCR AccessKey Secret"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  @doc "取单行配置(受信内部读;迁移 seed 保证存在,nil 仅见于异常环境)。"
  @spec get() :: %__MODULE__{} | nil
  def get do
    __MODULE__ |> Ash.read!(authorize?: false) |> List.first()
  end
end
```

- [ ] **Step 4: 域注册**

`backend/apps/synie_core/lib/synie_core.ex` 三处:

queries 块末尾(`list SynieCore.Files.StorageEndpoint, ...` 之后)加:

```elixir
      # 财务设置是单行表,read_one 免分页;配置态布尔登录即可查(OCR 按钮防呆)
      read_one SynieCore.Acc.Setting, :acc_setting, :read
      action SynieCore.Acc.Setting, :acc_ocr_configured, :ocr_configured
```

mutations 块末尾(`destroy SynieCore.Acc.BankReconciliation, ...` 之后)加:

```elixir
      update SynieCore.Acc.Setting, :update_acc_setting, :update
```

resources 块 `resource SynieCore.Acc.BankReconciliation` 之后加:

```elixir
    resource SynieCore.Acc.Setting
```

- [ ] **Step 5: 生成迁移并补 seed**

```bash
cd backend && mix ash.codegen add_acc_setting
```

打开生成的迁移文件(`backend/apps/synie_core/priv/repo/migrations/*_add_acc_setting.exs`),在 `create table(:acc_setting, ...)` 块之后补 seed(单行恒存在是 `Setting.get/0` 与 read_one 的前提):

```elixir
    # 单行 seed:资源不开放 create,行在此一次性创建
    execute(
      "INSERT INTO acc_setting (id, inserted_at, updated_at) VALUES (gen_random_uuid(), now(), now())",
      "DELETE FROM acc_setting"
    )
```

然后:

```bash
mix ecto.migrate
MIX_ENV=test mix ecto.migrate
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd backend && mix test apps/synie_core/test/synie_core/acc/setting_test.exs`
Expected: 4 tests, 0 failures

Run: `mix test`(全量,确认注册未破坏 schema 编译)
Expected: 0 failures

- [ ] **Step 7: 补规范一行**

`backend/CLAUDE.md`「权限」一节末尾加一行:

```markdown
- 财务域全局配置(非公司维度)加字段进 `acc_setting` 单行资源(系统管理→财务设置),不另建配置表。
```

- [ ] **Step 8: Commit**

```bash
git add -A backend
git commit -m "feat(acc): 财务设置单行表 acc_setting(阿里云 OCR 凭证)+ GraphQL 注册"
```

---

### Task 3: 阿里云 OCR HTTP 客户端 AliyunClient(Req + Req.Test)

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/ocr/aliyun_client.ex`
- Modify: `backend/config/test.exs`(注入 Req.Test plug;若该文件在别处,以 `grep -r "import Config" backend/config` 找到 test 配置文件)
- Test: `backend/apps/synie_core/test/synie_core/ocr/aliyun_client_test.exs`

**Interfaces:**
- Consumes: `AliyunSigner.headers/6`(Task 1)
- Produces: `AliyunClient.recognize(action, image_binary, creds)` → `{:ok, data_map} | {:error, String.t()}`;`action` 是 `"RecognizeInvoice"` / `"RecognizeBankAcceptance"`;`data_map` 是阿里云 `Data` 字段 JSON 串解码后的 map;测试经 `config :synie_core, :ocr_req_options` 注入 `plug: {Req.Test, SynieCore.Ocr.AliyunClient}`

- [ ] **Step 1: 加测试配置**

`backend/config/test.exs` 末尾加:

```elixir
# OCR HTTP 走 Req.Test 桩,测试不出网
config :synie_core, ocr_req_options: [plug: {Req.Test, SynieCore.Ocr.AliyunClient}]
```

- [ ] **Step 2: 写失败测试**

`backend/apps/synie_core/test/synie_core/ocr/aliyun_client_test.exs`:

```elixir
defmodule SynieCore.Ocr.AliyunClientTest do
  use ExUnit.Case, async: true

  alias SynieCore.Ocr.AliyunClient

  @creds %{access_key_id: "ak", access_key_secret: "sk"}

  test "200 + Data JSON 串 → 解码后的 map" do
    Req.Test.stub(AliyunClient, fn conn ->
      # 签名头应随请求带出
      assert [_ | _] = Plug.Conn.get_req_header(conn, "authorization")
      assert ["RecognizeInvoice"] = Plug.Conn.get_req_header(conn, "x-acs-action")

      Req.Test.json(conn, %{
        "RequestId" => "req-1",
        "Data" => Jason.encode!(%{"data" => %{"invoiceNumber" => "12345678"}})
      })
    end)

    assert {:ok, %{"data" => %{"invoiceNumber" => "12345678"}}} =
             AliyunClient.recognize("RecognizeInvoice", <<1, 2, 3>>, @creds)
  end

  test "阿里云错误码 → 带 Code/Message 的中文错误" do
    Req.Test.stub(AliyunClient, fn conn ->
      conn
      |> Plug.Conn.put_status(400)
      |> Req.Test.json(%{"Code" => "invalidImage", "Message" => "image is invalid"})
    end)

    assert {:error, msg} = AliyunClient.recognize("RecognizeInvoice", <<1>>, @creds)
    assert msg =~ "invalidImage"
    assert msg =~ "image is invalid"
  end

  test "非 JSON/缺 Data 的 200 → 明确错误" do
    Req.Test.stub(AliyunClient, fn conn ->
      Req.Test.json(conn, %{"RequestId" => "req-2"})
    end)

    assert {:error, msg} = AliyunClient.recognize("RecognizeInvoice", <<1>>, @creds)
    assert msg =~ "Data"
  end

  test "网络错误 → 中文网络错误信息" do
    Req.Test.stub(AliyunClient, fn conn ->
      Req.Test.transport_error(conn, :econnrefused)
    end)

    assert {:error, msg} = AliyunClient.recognize("RecognizeInvoice", <<1>>, @creds)
    assert msg =~ "网络"
  end
end
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/ocr/aliyun_client_test.exs`
Expected: FAIL(module not available)

- [ ] **Step 4: 实现客户端**

`backend/apps/synie_core/lib/synie_core/ocr/aliyun_client.ex`:

```elixir
defmodule SynieCore.Ocr.AliyunClient do
  @moduledoc """
  阿里云 OCR(ocr-api,版本 2021-07-07)HTTP 客户端:V3 签名 + 图片二进制 body。
  `:synie_core, :ocr_req_options` 可注入 Req 选项(测试注入 Req.Test plug 不出网)。
  """

  alias SynieCore.Ocr.AliyunSigner

  @host "ocr-api.cn-hangzhou.aliyuncs.com"
  @version "2021-07-07"

  @spec recognize(String.t(), binary(), map()) :: {:ok, map()} | {:error, String.t()}
  def recognize(action, image_binary, creds) do
    # host 参与签名但不显式发送(Finch 按 URL 自动带 Host,同值;显式再带会重复)
    headers =
      @host
      |> AliyunSigner.headers(action, @version, image_binary, creds)
      |> Enum.reject(fn {k, _} -> k == "host" end)

    req =
      Req.new(
        [
          url: "https://#{@host}/",
          method: :post,
          headers: headers,
          body: image_binary,
          retry: false
        ] ++ Application.get_env(:synie_core, :ocr_req_options, [])
      )

    case Req.request(req) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        decode_data(body)

      {:ok, %Req.Response{body: %{"Code" => code} = body}} ->
        {:error, "阿里云 OCR 调用失败(#{code}):#{body["Message"] || "未知错误"}"}

      {:ok, %Req.Response{status: status}} ->
        {:error, "阿里云 OCR 调用失败(HTTP #{status})"}

      {:error, err} when is_exception(err) ->
        {:error, "阿里云 OCR 网络错误:#{Exception.message(err)}"}

      {:error, other} ->
        {:error, "阿里云 OCR 网络错误:#{inspect(other)}"}
    end
  end

  defp decode_data(%{"Data" => data}) when is_binary(data) do
    case Jason.decode(data) do
      {:ok, decoded} when is_map(decoded) -> {:ok, decoded}
      _ -> {:error, "阿里云 OCR 返回的 Data 无法解析"}
    end
  end

  defp decode_data(%{"Data" => data}) when is_map(data), do: {:ok, data}
  defp decode_data(_body), do: {:error, "阿里云 OCR 返回缺少 Data 字段"}
end
```

注:若编译报 Jason 未声明依赖,在 `synie_core/mix.exs` deps 补 `{:jason, "~> 1.4"},`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && mix test apps/synie_core/test/synie_core/ocr/aliyun_client_test.exs`
Expected: 4 tests, 0 failures

- [ ] **Step 6: Commit**

```bash
git add -A backend
git commit -m "feat(ocr): 阿里云 OCR HTTP 客户端(Req + 测试桩)"
```

---

### Task 4: 字段映射器 InvoiceMapper / AcceptanceMapper

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/ocr/invoice_mapper.ex`
- Create: `backend/apps/synie_core/lib/synie_core/ocr/acceptance_mapper.ex`
- Test: `backend/apps/synie_core/test/synie_core/ocr/mapper_test.exs`

**Interfaces:**
- Consumes: 无(纯函数)
- Produces:
  - `InvoiceMapper.map(data_map)` → string-key map,键与发票抽屉 GraphQL 字段同名(camelCase):`invoiceCode/invoiceNo/invoiceDate/invoiceKind/sellerName/sellerTaxNo/sellerAddressPhone/sellerBankAccount/buyerName/buyerTaxNo/buyerAddressPhone/buyerBankAccount/netTotal/taxTotal/grossTotal/issuer/reviewer/payee/remarks/items`;金额是纯数字字符串、日期 `yyyy-mm-dd`、`invoiceKind` 是 GraphQL 枚举 token(如 `"DIGITAL_SPECIAL"`)、`items` 是 snake 键行数组(`name/model/unit/quantity/price/net_amount/tax_rate/tax_amount`);识别不出的键整个省略
  - `AcceptanceMapper.map(data_map)` → string-key map,键与承兑票面草稿 billDraft 同名(snake_case):`bill_no/bill_kind/issue_date/due_date/face_amount/acceptance_date/transferable/drawer_name/drawer_account/drawer_bank_name/payee_name/payee_account/payee_bank_name/acceptor_name/acceptor_account/acceptor_bank_name/acceptor_bank_no`;`bill_kind` 恒为 `"BANK_ACCEPTANCE"`(该接口只识别银承)、`transferable` 布尔、`face_amount` 数字字符串

- [ ] **Step 1: 写失败测试**

`backend/apps/synie_core/test/synie_core/ocr/mapper_test.exs`:

```elixir
defmodule SynieCore.Ocr.MapperTest do
  use ExUnit.Case, async: true

  alias SynieCore.Ocr.AcceptanceMapper
  alias SynieCore.Ocr.InvoiceMapper

  @invoice_data %{
    "data" => %{
      "invoiceCode" => "3300214130",
      "invoiceNumber" => "12345678",
      "invoiceDate" => "2026年07月01日",
      "invoiceType" => "数电票(增值税专用发票)",
      "sellerName" => "杭州测试科技有限公司",
      "sellerTaxNumber" => "91330100MA27XXXXXX",
      "sellerContactInfo" => "杭州市西湖区 0571-88888888",
      "sellerBankAccountInfo" => "工行西湖支行 1202020409000000000",
      "purchaserName" => "宁波示例贸易有限公司",
      "purchaserTaxNumber" => "91330200MA28XXXXXX",
      "purchaserContactInfo" => "宁波市鄞州区 0574-66666666",
      "purchaserBankAccountInfo" => "建行鄞州支行 33101983600051000000",
      "invoiceAmountPreTax" => "¥1,000.00",
      "invoiceTax" => "¥130.00",
      "totalAmount" => "¥1,130.00",
      "drawer" => "张三",
      "reviewer" => "李四",
      "recipient" => "王五",
      "remarks" => "合同号 HT-001",
      "invoiceDetails" => [
        %{
          "itemName" => "*信息技术服务*软件开发",
          "specification" => "V1.0",
          "unit" => "项",
          "quantity" => "1",
          "unitPrice" => "1000",
          "amount" => "1,000.00",
          "taxRate" => "13%",
          "tax" => "130.00"
        }
      ]
    }
  }

  test "发票:全字段映射为抽屉 camelCase 键" do
    m = InvoiceMapper.map(@invoice_data)

    assert m["invoiceCode"] == "3300214130"
    assert m["invoiceNo"] == "12345678"
    assert m["invoiceDate"] == "2026-07-01"
    assert m["invoiceKind"] == "DIGITAL_SPECIAL"
    assert m["sellerName"] == "杭州测试科技有限公司"
    assert m["buyerName"] == "宁波示例贸易有限公司"
    assert m["buyerTaxNo"] == "91330200MA28XXXXXX"
    assert m["netTotal"] == "1000.00"
    assert m["taxTotal"] == "130.00"
    assert m["grossTotal"] == "1130.00"
    assert m["issuer"] == "张三"
    assert m["payee"] == "王五"

    assert [item] = m["items"]
    assert item["name"] == "*信息技术服务*软件开发"
    assert item["model"] == "V1.0"
    assert item["quantity"] == "1"
    assert item["price"] == "1000"
    assert item["net_amount"] == "1000.00"
    assert item["tax_rate"] == "13%"
    assert item["tax_amount"] == "130.00"
  end

  test "发票:识别不出的键整体省略;发票种类按关键词归类" do
    m = InvoiceMapper.map(%{"data" => %{"invoiceType" => "增值税电子普通发票"}})
    assert m["invoiceKind"] == "ELECTRONIC_NORMAL"
    refute Map.has_key?(m, "invoiceNo")
    refute Map.has_key?(m, "items")

    assert InvoiceMapper.map(%{"data" => %{"invoiceType" => "增值税专用发票"}})["invoiceKind"] == "SPECIAL"
    assert InvoiceMapper.map(%{"data" => %{"invoiceType" => "增值税普通发票"}})["invoiceKind"] == "NORMAL"
  end

  test "发票:兼容 Data 无 data 嵌套层的返回" do
    m = InvoiceMapper.map(%{"invoiceNumber" => "888"})
    assert m["invoiceNo"] == "888"
  end

  test "日期归一:横杠与紧凑格式" do
    assert InvoiceMapper.map(%{"data" => %{"invoiceDate" => "2026-07-01"}})["invoiceDate"] == "2026-07-01"
    assert InvoiceMapper.map(%{"data" => %{"invoiceDate" => "20260701"}})["invoiceDate"] == "2026-07-01"
    refute Map.has_key?(InvoiceMapper.map(%{"data" => %{"invoiceDate" => "识别失败"}}), "invoiceDate")
  end

  test "承兑:映射为票面草稿 snake_case 键" do
    m =
      AcceptanceMapper.map(%{
        "data" => %{
          "draftNumber" => "130331200093520210630123456789012",
          "issueDate" => "2026年06月30日",
          "validToDate" => "2026-12-30",
          "totalAmount" => "1,000,000.00",
          "acceptanceDate" => "2026-07-01",
          "assignability" => "可转让",
          "issuerName" => "出票公司",
          "issuerAccountNumber" => "111",
          "issuerAccountBank" => "工行A支行",
          "payeeName" => "收款公司",
          "payeeAccountNumber" => "222",
          "payeeAccountBank" => "建行B支行",
          "acceptorName" => "承兑银行",
          "acceptorAccountNumber" => "333",
          "acceptorAccountBank" => "工行营业部",
          "acceptorBankNumber" => "102331000000"
        }
      })

    assert m["bill_no"] == "130331200093520210630123456789012"
    assert m["bill_kind"] == "BANK_ACCEPTANCE"
    assert m["issue_date"] == "2026-06-30"
    assert m["due_date"] == "2026-12-30"
    assert m["face_amount"] == "1000000.00"
    assert m["acceptance_date"] == "2026-07-01"
    assert m["transferable"] == true
    assert m["drawer_name"] == "出票公司"
    assert m["drawer_account"] == "111"
    assert m["drawer_bank_name"] == "工行A支行"
    assert m["payee_name"] == "收款公司"
    assert m["acceptor_name"] == "承兑银行"
    assert m["acceptor_bank_no"] == "102331000000"
  end

  test "承兑:不可转让 → transferable false;缺失字段省略" do
    m = AcceptanceMapper.map(%{"data" => %{"assignability" => "不得转让"}})
    assert m["transferable"] == false
    refute Map.has_key?(m, "bill_no")
  end
end
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/ocr/mapper_test.exs`
Expected: FAIL(module not available)

- [ ] **Step 3: 实现两个映射器**

`backend/apps/synie_core/lib/synie_core/ocr/invoice_mapper.ex`:

```elixir
defmodule SynieCore.Ocr.InvoiceMapper do
  @moduledoc """
  RecognizeInvoice 返回(Data 解码后)→ 发票创建抽屉表单字段。
  键为 GraphQL camelCase 字段名;金额纯数字字符串、日期 yyyy-mm-dd;
  识别不出的键整体省略——前端 patchValues 才不会把已填内容清空。
  """

  @doc "映射主入口;兼容返回带/不带 data 嵌套层两种形态。"
  @spec map(map()) :: map()
  def map(%{"data" => data}) when is_map(data), do: map_fields(data)
  def map(data) when is_map(data), do: map_fields(data)

  defp map_fields(d) do
    %{
      "invoiceCode" => text(d["invoiceCode"]),
      "invoiceNo" => text(d["invoiceNumber"]),
      "invoiceDate" => date(d["invoiceDate"]),
      "invoiceKind" => kind(d["invoiceType"]),
      "sellerName" => text(d["sellerName"]),
      "sellerTaxNo" => text(d["sellerTaxNumber"]),
      "sellerAddressPhone" => text(d["sellerContactInfo"]),
      "sellerBankAccount" => text(d["sellerBankAccountInfo"]),
      "buyerName" => text(d["purchaserName"]),
      "buyerTaxNo" => text(d["purchaserTaxNumber"]),
      "buyerAddressPhone" => text(d["purchaserContactInfo"]),
      "buyerBankAccount" => text(d["purchaserBankAccountInfo"]),
      "netTotal" => amount(d["invoiceAmountPreTax"]),
      "taxTotal" => amount(d["invoiceTax"]),
      "grossTotal" => amount(d["totalAmount"]),
      "issuer" => text(d["drawer"]),
      "reviewer" => text(d["reviewer"]),
      "payee" => text(d["recipient"]),
      "remarks" => text(d["remarks"]),
      "items" => items(d["invoiceDetails"])
    }
    |> reject_nils()
  end

  defp items(list) when is_list(list) and list != [] do
    Enum.map(list, fn row ->
      %{
        "name" => text(row["itemName"]),
        "model" => text(row["specification"]),
        "unit" => text(row["unit"]),
        "quantity" => amount(row["quantity"]),
        "price" => amount(row["unitPrice"]),
        "net_amount" => amount(row["amount"]),
        "tax_rate" => text(row["taxRate"]),
        "tax_amount" => amount(row["tax"])
      }
      |> reject_nils()
    end)
  end

  defp items(_), do: nil

  # 发票种类按关键词归类:数电 > 电子 > 纸质;专用/普通二分
  defp kind(t) when is_binary(t) do
    special? = String.contains?(t, "专用")

    cond do
      String.contains?(t, "数电") -> if special?, do: "DIGITAL_SPECIAL", else: "DIGITAL_NORMAL"
      String.contains?(t, "电子") -> if special?, do: "ELECTRONIC_SPECIAL", else: "ELECTRONIC_NORMAL"
      true -> if special?, do: "SPECIAL", else: "NORMAL"
    end
  end

  defp kind(_), do: nil

  @doc false
  def text(v) when is_binary(v) do
    case String.trim(v) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  def text(_), do: nil

  @doc false
  # 金额清洗:去 ¥、千分位逗号、空白,保留数字与小数点/负号
  def amount(v) when is_number(v), do: to_string(v)

  def amount(v) when is_binary(v) do
    case String.replace(v, ~r/[^0-9.\-]/u, "") do
      "" -> nil
      cleaned -> cleaned
    end
  end

  def amount(_), do: nil

  @doc false
  # 日期归一:2026年07月01日 / 2026-07-01 / 2026/07/01 / 20260701 → 2026-07-01
  def date(v) when is_binary(v) do
    digits =
      case Regex.scan(~r/\d+/, v) |> List.flatten() do
        [<<_::binary-size(4)>> = y, m, d | _] -> {y, m, d}
        [<<y::binary-size(4), m::binary-size(2), d::binary-size(2)>>] -> {y, m, d}
        _ -> nil
      end

    with {y, m, d} <- digits,
         {year, ""} <- Integer.parse(y),
         {month, ""} <- Integer.parse(m),
         {day, ""} <- Integer.parse(d),
         {:ok, parsed} <- Date.new(year, month, day) do
      Date.to_iso8601(parsed)
    else
      _ -> nil
    end
  end

  def date(_), do: nil

  @doc false
  def reject_nils(map), do: Map.reject(map, fn {_k, v} -> is_nil(v) end)
end
```

`backend/apps/synie_core/lib/synie_core/ocr/acceptance_mapper.ex`:

```elixir
defmodule SynieCore.Ocr.AcceptanceMapper do
  @moduledoc """
  RecognizeBankAcceptance 返回(Data 解码后)→ 承兑接收票面草稿字段。
  键为票面草稿 billDraft 的 snake_case 键(见 acceptance/-transaction-drawer.tsx);
  该接口只识别银行承兑汇票,bill_kind 恒 BANK_ACCEPTANCE。识别不出的键整体省略。
  """

  import SynieCore.Ocr.InvoiceMapper, only: [amount: 1, date: 1, reject_nils: 1, text: 1]

  @doc "映射主入口;兼容返回带/不带 data 嵌套层两种形态。"
  @spec map(map()) :: map()
  def map(%{"data" => data}) when is_map(data), do: map_fields(data)
  def map(data) when is_map(data), do: map_fields(data)

  defp map_fields(d) do
    %{
      "bill_no" => text(d["draftNumber"]),
      "issue_date" => date(d["issueDate"]),
      "due_date" => date(d["validToDate"]),
      "face_amount" => amount(d["totalAmount"]),
      "acceptance_date" => date(d["acceptanceDate"]),
      "transferable" => transferable(d["assignability"]),
      "drawer_name" => text(d["issuerName"]),
      "drawer_account" => text(d["issuerAccountNumber"]),
      "drawer_bank_name" => text(d["issuerAccountBank"]),
      "payee_name" => text(d["payeeName"]),
      "payee_account" => text(d["payeeAccountNumber"]),
      "payee_bank_name" => text(d["payeeAccountBank"]),
      "acceptor_name" => text(d["acceptorName"]),
      "acceptor_account" => text(d["acceptorAccountNumber"]),
      "acceptor_bank_name" => text(d["acceptorAccountBank"]),
      "acceptor_bank_no" => text(d["acceptorBankNumber"])
    }
    |> reject_nils()
    |> put_kind()
  end

  # 票面任一字段识别到才断言种类,空结果不带 bill_kind
  defp put_kind(m) when map_size(m) == 0, do: m
  defp put_kind(m), do: Map.put(m, "bill_kind", "BANK_ACCEPTANCE")

  defp transferable(v) when is_binary(v), do: not String.contains?(v, "不")
  defp transferable(_), do: nil
end
```

注意:`InvoiceMapper` 的 `text/amount/date/reject_nils` 要标 `@doc false` 公开(如上),供 `AcceptanceMapper` import。

注意测试里"不可转让 → 缺失字段省略"一例:`assignability` 有值时 `transferable` 在 map 里,`put_kind` 会补 `bill_kind`,断言只要求 `bill_no` 缺失——实现与测试一致,不要多改。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && mix test apps/synie_core/test/synie_core/ocr/mapper_test.exs`
Expected: 6 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add -A backend
git commit -m "feat(ocr): 发票/承兑识别结果字段映射器"
```

---

### Task 5: Ocr 门面 + VatInvoice/BillTransaction generic action + 域注册

**Files:**
- Create: `backend/apps/synie_core/lib/synie_core/ocr.ex`
- Modify: `backend/apps/synie_core/lib/synie_core/acc/vat_invoice.ex`(policies + actions)
- Modify: `backend/apps/synie_core/lib/synie_core/acc/bill_transaction.ex`(policies + actions)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(mutations 两行)
- Test: `backend/apps/synie_core/test/synie_core/ocr_test.exs`

**Interfaces:**
- Consumes: `Setting.get/0`(Task 2)、`AliyunClient.recognize/3`(Task 3)、`InvoiceMapper.map/1`/`AcceptanceMapper.map/1`(Task 4)、`SynieCore.Storage.read/2`、`SynieCore.Files.File`(既有)
- Produces: `SynieCore.Ocr.recognize_invoice(actor, file_id)` / `recognize_bank_acceptance(actor, file_id)` → `{:ok, map} | {:error, String.t()}`;GraphQL mutations `ocrAccVatInvoice(input: {fileId})` / `ocrAccBillTransaction(input: {fileId})`,返回 JSON(map);权限复用各自资源的 `create` 码

- [ ] **Step 1: 写失败测试**

`backend/apps/synie_core/test/synie_core/ocr_test.exs`(文件/存储夹具照 `files_test.exs` 先例):

```elixir
defmodule SynieCore.OcrTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.Setting
  alias SynieCore.Acc.VatInvoice
  alias SynieCore.Authz
  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Ocr.AliyunClient

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_ocr_test_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "发票.png")
    File.write!(src, "fake png bytes")

    StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{name: "test_local", label: "测试本地", kind: :local, root: root})
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)

    on_exit(fn -> File.rm_rf!(base) end)

    %{src: src}
  end

  defp actor_with!(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  defp configure_ocr! do
    Setting.get()
    |> Ash.Changeset.for_update(:update, %{ocr_access_key_id: "ak", ocr_access_key_secret: "sk"})
    |> Ash.update!(authorize?: false)
  end

  defp upload!(actor, src, content_type) do
    {:ok, %{file: file}} =
      SynieCore.Files.upload(actor, %{path: src, filename: Path.basename(src), content_type: content_type})

    file
  end

  defp stub_invoice_success do
    Req.Test.stub(AliyunClient, fn conn ->
      Req.Test.json(conn, %{
        "RequestId" => "r",
        "Data" => Jason.encode!(%{"data" => %{"invoiceNumber" => "12345678", "totalAmount" => "¥1,130.00"}})
      })
    end)
  end

  test "未配置凭证 → 明确错误", %{src: src} do
    actor = actor_with!(["sys.file:create", "sys.file:read"])
    file = upload!(actor, src, "image/png")

    assert {:error, msg} = SynieCore.Ocr.recognize_invoice(actor, file.id)
    assert msg =~ "凭证"
  end

  test "发票识别 happy path:取文件字节 → 调阿里云 → 映射字段", %{src: src} do
    configure_ocr!()
    stub_invoice_success()
    actor = actor_with!(["sys.file:create", "sys.file:read"])
    file = upload!(actor, src, "image/png")

    assert {:ok, fields} = SynieCore.Ocr.recognize_invoice(actor, file.id)
    assert fields["invoiceNo"] == "12345678"
    assert fields["grossTotal"] == "1130.00"
  end

  test "只能识别本人上传的文件", %{src: src} do
    configure_ocr!()
    uploader = actor_with!(["sys.file:create", "sys.file:read"])
    other = actor_with!(["sys.file:create", "sys.file:read"])
    file = upload!(uploader, src, "image/png")

    assert {:error, msg} = SynieCore.Ocr.recognize_invoice(other, file.id)
    assert msg =~ "本人上传"
  end

  test "承兑不收 PDF、发票收 PDF", %{src: src} do
    configure_ocr!()
    stub_invoice_success()
    actor = actor_with!(["sys.file:create", "sys.file:read"])
    file = upload!(actor, src, "application/pdf")

    assert {:ok, _} = SynieCore.Ocr.recognize_invoice(actor, file.id)
    assert {:error, msg} = SynieCore.Ocr.recognize_bank_acceptance(actor, file.id)
    assert msg =~ "格式"
  end

  test "generic action :ocr 权限复用 create", %{src: src} do
    configure_ocr!()
    stub_invoice_success()

    can = actor_with!(["sys.file:create", "sys.file:read", "acc.vat_invoice:create"])
    file = upload!(can, src, "image/png")

    assert {:ok, %{"invoiceNo" => "12345678"}} =
             VatInvoice
             |> Ash.ActionInput.for_action(:ocr, %{file_id: file.id})
             |> Ash.run_action(actor: can)

    cannot = actor_with!(["sys.file:create", "sys.file:read"])
    file2 = upload!(cannot, src, "image/png")

    assert {:error, %Ash.Error.Forbidden{}} =
             VatInvoice
             |> Ash.ActionInput.for_action(:ocr, %{file_id: file2.id})
             |> Ash.run_action(actor: cannot)
  end
end
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/ocr_test.exs`
Expected: FAIL(SynieCore.Ocr not available)

- [ ] **Step 3: 实现门面**

`backend/apps/synie_core/lib/synie_core/ocr.ex`:

```elixir
defmodule SynieCore.Ocr do
  @moduledoc """
  票据 OCR 门面:校验并读取文件字节 → 调阿里云 → 映射为前端表单字段。
  凭证在 acc_setting(系统管理→财务设置)。仅允许识别本人上传的文件——
  OCR 动线里文件是刚上传的裸文件(未挂宿主),放开会让任意 file_id 可被探测。
  """

  alias SynieCore.Acc.Setting
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Ocr.AcceptanceMapper
  alias SynieCore.Ocr.AliyunClient
  alias SynieCore.Ocr.InvoiceMapper
  alias SynieCore.Storage

  # 与阿里云限制一致:二进制 body ≤10MB
  @max_size 10 * 1024 * 1024
  @image_types ~w(image/png image/jpg image/jpeg image/bmp image/gif image/tiff image/webp)

  @spec recognize_invoice(SynieCore.Authz.Actor.t(), String.t()) ::
          {:ok, map()} | {:error, String.t()}
  def recognize_invoice(actor, file_id) do
    # 发票接口额外支持 PDF(数电票常见)
    with {:ok, binary} <- fetch_binary(actor, file_id, @image_types ++ ["application/pdf"]),
         {:ok, creds} <- credentials(),
         {:ok, data} <- AliyunClient.recognize("RecognizeInvoice", binary, creds) do
      {:ok, InvoiceMapper.map(data)}
    end
  end

  @spec recognize_bank_acceptance(SynieCore.Authz.Actor.t(), String.t()) ::
          {:ok, map()} | {:error, String.t()}
  def recognize_bank_acceptance(actor, file_id) do
    with {:ok, binary} <- fetch_binary(actor, file_id, @image_types),
         {:ok, creds} <- credentials(),
         {:ok, data} <- AliyunClient.recognize("RecognizeBankAcceptance", binary, creds) do
      {:ok, AcceptanceMapper.map(data)}
    end
  end

  defp credentials do
    case Setting.get() do
      %Setting{ocr_access_key_id: ak, ocr_access_key_secret: sk}
      when is_binary(ak) and ak != "" and is_binary(sk) and sk != "" ->
        {:ok, %{access_key_id: ak, access_key_secret: sk}}

      _ ->
        {:error, "未配置阿里云 OCR 凭证,请到「系统管理→财务设置」配置"}
    end
  end

  defp fetch_binary(actor, file_id, allowed_types) do
    with {:ok, file} <- fetch_file(actor, file_id),
         :ok <- check_uploader(actor, file),
         :ok <- check_type(file, allowed_types),
         :ok <- check_size(file) do
      case Storage.read(file.storage, file.key) do
        {:ok, binary} -> {:ok, binary}
        {:error, _} -> {:error, "文件对象读取失败,请重新上传"}
      end
    end
  end

  defp fetch_file(actor, file_id) do
    case Ash.get(StoredFile, file_id, actor: actor) do
      {:ok, file} -> {:ok, file}
      {:error, _} -> {:error, "文件不存在或无权访问"}
    end
  end

  defp check_uploader(actor, file) do
    if actor.super_admin or actor.user_id == file.uploaded_by_id do
      :ok
    else
      {:error, "仅能识别本人上传的文件"}
    end
  end

  defp check_type(file, allowed_types) do
    if file.content_type in allowed_types do
      :ok
    else
      {:error, "不支持的文件格式:#{file.content_type || "未知"}(支持 #{Enum.join(allowed_types, "、")})"}
    end
  end

  defp check_size(%{size: size}) when is_integer(size) and size > @max_size,
    do: {:error, "文件超过 10MB,请压缩后重试"}

  defp check_size(_), do: :ok
end
```

- [ ] **Step 4: VatInvoice 加 :ocr action 并调整 policies**

`backend/apps/synie_core/lib/synie_core/acc/vat_invoice.ex`:

policies 块中把:

```elixir
    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
```

替换为(`policy always()` 会波及新增的 :ocr 动作,改为显式动作清单;:ocr 复用 create 码):

```elixir
    policy action([:read, :create, :update, :destroy, :audit, :void, :reverse]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # OCR 是录入辅助,复用 create 码不新设权限点(同银行流水 import 先例)
    policy action(:ocr) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end
```

actions 块末尾(`update :reverse do ... end` 之后)加:

```elixir
    action :ocr, :map do
      description "上传发票图片/PDF 后 OCR 识别,返回可回填创建表单的字段(不落库)"
      argument :file_id, :uuid, allow_nil?: false

      run fn input, context ->
        # DSL run 闭包内 alias 不生效(同 bank_reconciliation :remaining 先例),全限定
        SynieCore.Ocr.recognize_invoice(context.actor, input.arguments.file_id)
      end
    end
```

- [ ] **Step 5: BillTransaction 同款**

`backend/apps/synie_core/lib/synie_core/acc/bill_transaction.ex`:

policies 块中把:

```elixir
    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
```

替换为(先 `grep -n "update :\|create :\|destroy :\|read :" apps/synie_core/lib/synie_core/acc/bill_transaction.ex` 核对动作清单,如有遗漏动作一并列入第一条 policy):

```elixir
    policy action([:read, :create, :update, :destroy, :audit, :void]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # OCR 是录入辅助,复用 create 码不新设权限点(同银行流水 import 先例)
    policy action(:ocr) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end
```

actions 块末尾加:

```elixir
    action :ocr, :map do
      description "上传承兑汇票图片后 OCR 识别,返回可回填接收票面草稿的字段(不落库)"
      argument :file_id, :uuid, allow_nil?: false

      run fn input, context ->
        # DSL run 闭包内 alias 不生效(同 bank_reconciliation :remaining 先例),全限定
        SynieCore.Ocr.recognize_bank_acceptance(context.actor, input.arguments.file_id)
      end
    end
```

- [ ] **Step 6: 域注册两个 mutation**

`backend/apps/synie_core/lib/synie_core.ex` mutations 块,`update SynieCore.Acc.Setting, ...` 之后加:

```elixir
      # OCR 识别是有副作用的外部调用(计费),注册为 mutation;权限复用各自 create 码
      action SynieCore.Acc.VatInvoice, :ocr_acc_vat_invoice, :ocr
      action SynieCore.Acc.BillTransaction, :ocr_acc_bill_transaction, :ocr
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd backend && mix test apps/synie_core/test/synie_core/ocr_test.exs`
Expected: 5 tests, 0 failures

Run: `mix test`(全量——policy 重构动过 vat_invoice/bill_transaction,现有测试是安全网)
Expected: 0 failures。若 vat_invoice/bill_transaction 既有测试失败,说明动作清单漏列,把报错动作补进第一条 policy 的清单。

- [ ] **Step 8: Commit**

```bash
git add -A backend
git commit -m "feat(ocr): OCR 门面 + 发票/承兑 generic action(权限复用 create)"
```

---

### Task 6: 给已有文件挂附件:Files.attach + REST 端点 + files.ts

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/files.ex`(新增 `attach/2`)
- Modify: `backend/apps/synie_web/lib/synie_web/controllers/file_controller.ex`(新增 `attach` action)
- Modify: `backend/apps/synie_web/lib/synie_web/router.ex`(一行)
- Modify: `web/app/lib/files.ts`(新增 `attachFile`)
- Test: `backend/apps/synie_core/test/synie_core/files_test.exs`(追加用例)

**Interfaces:**
- Consumes: `SynieCore.Files.maybe_attach/3`(既有私有函数,复用)
- Produces:
  - `SynieCore.Files.attach(actor, %{file_id:, owner_type:, owner_id:, category:})` → `{:ok, %Attachment{}} | {:error, :file_not_found | :missing_owner | :forbidden_owner | :unknown_owner_type | exception}`
  - REST `POST /api/files/:id/attachments`(form 参数 `owner_type`/`owner_id`/`category`)→ `{"attachment": {...}}`
  - 前端 `attachFile(fileId, { ownerType, ownerId, category? })` → `Promise<UploadedAttachment>`

- [ ] **Step 1: 写失败测试**

在 `backend/apps/synie_core/test/synie_core/files_test.exs` 追加(用该文件既有的 `actor_with!`/`customer!` 夹具;`describe "attach/2"` 放文件末尾的 describe 同级):

```elixir
  describe "attach/2(给已有文件补挂附件)" do
    test "裸文件可补挂到可见宿主,company_id 从宿主去规范化", %{src: src} do
      actor = actor_with!(["sys.file:create", "sys.file:read", "sales.customer:read"])
      customer = customer!()

      {:ok, %{file: file, attachment: nil}} =
        Files.upload(actor, %{path: src, filename: "合同.pdf", content_type: "application/pdf"})

      assert {:ok, %Attachment{} = attachment} =
               Files.attach(actor, %{
                 file_id: file.id,
                 owner_type: "sal_customer",
                 owner_id: customer.id,
                 category: "original"
               })

      assert attachment.file_id == file.id
      assert attachment.owner_type == "sal_customer"
      assert attachment.category == "original"
    end

    test "宿主不可见 → forbidden_owner;未知宿主 → unknown_owner_type", %{src: src} do
      actor = actor_with!(["sys.file:create", "sys.file:read"])
      customer = customer!()

      {:ok, %{file: file}} =
        Files.upload(actor, %{path: src, filename: "a.pdf", content_type: "application/pdf"})

      # 无 sales.customer:read → 看不见宿主
      assert {:error, :forbidden_owner} =
               Files.attach(actor, %{file_id: file.id, owner_type: "sal_customer", owner_id: customer.id})

      assert {:error, :unknown_owner_type} =
               Files.attach(actor, %{file_id: file.id, owner_type: "not_exist", owner_id: customer.id})
    end

    test "缺 owner 参数 → missing_owner;文件不可见 → file_not_found", %{src: src} do
      actor = actor_with!(["sys.file:create", "sys.file:read"])

      {:ok, %{file: file}} =
        Files.upload(actor, %{path: src, filename: "b.pdf", content_type: "application/pdf"})

      assert {:error, :missing_owner} = Files.attach(actor, %{file_id: file.id})

      no_read = actor_with!([])
      assert {:error, :file_not_found} = Files.attach(no_read, %{file_id: file.id})
    end
  end
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && mix test apps/synie_core/test/synie_core/files_test.exs`
Expected: 新增 3 例 FAIL(function Files.attach/2 is undefined),旧例全过

- [ ] **Step 3: 实现 Files.attach/2**

`backend/apps/synie_core/lib/synie_core/files.ex`,在 `upload/2` 函数之后加:

```elixir
  @doc """
  给已有 `sys_file` 补挂宿主附件(OCR 动线:识别时上传裸文件,单据保存成功后回头挂接)。
  `params`:`:file_id` 必填,`:owner_type`/`:owner_id` 必填,`:category` 可选。
  权限语义与上传时顺带挂接一致:actor 要能读文件、能读宿主、有附件 create 权。
  """
  @spec attach(SynieCore.Authz.Actor.t(), map()) ::
          {:ok, Attachment.t()} | {:error, term()}
  def attach(actor, %{file_id: file_id} = params) do
    with {:ok, file} <- fetch_file(actor, file_id),
         {:ok, %Attachment{} = attachment} <- maybe_attach(actor, file, params) do
      {:ok, attachment}
    else
      # maybe_attach 对缺 owner 参数返回 {:ok, nil},此处视为调用错误
      {:ok, nil} -> {:error, :missing_owner}
      {:error, reason} -> {:error, reason}
    end
  rescue
    e in [Ash.Error.Forbidden, Ash.Error.Invalid] -> {:error, e}
  end

  defp fetch_file(actor, file_id) do
    case Ash.get(StoredFile, file_id, actor: actor) do
      {:ok, file} -> {:ok, file}
      {:error, _} -> {:error, :file_not_found}
    end
  end
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && mix test apps/synie_core/test/synie_core/files_test.exs`
Expected: 0 failures

- [ ] **Step 5: REST 端点**

`backend/apps/synie_web/lib/synie_web/router.ex` 的 `/api` scope 里 `post("/files", ...)` 之后加:

```elixir
    post("/files/:id/attachments", FileController, :attach)
```

`backend/apps/synie_web/lib/synie_web/controllers/file_controller.ex`,`create/2` 两个子句之后加(moduledoc 的端点列表也同步补一行 `* POST /api/files/:id/attachments — 给已有文件补挂宿主附件`):

```elixir
  def attach(conn, %{"id" => id} = params) do
    with_actor(conn, fn actor ->
      result =
        SynieCore.Files.attach(actor, %{
          file_id: id,
          owner_type: params["owner_type"],
          owner_id: params["owner_id"],
          category: params["category"]
        })

      case result do
        {:ok, attachment} ->
          json(conn, %{attachment: attachment_json(attachment)})

        {:error, :file_not_found} ->
          error(conn, 404, "文件不存在或无权访问")

        {:error, :missing_owner} ->
          error(conn, 400, "缺少 owner_type/owner_id 参数")

        {:error, :forbidden_owner} ->
          error(conn, 403, "无权访问该宿主记录")

        {:error, :unknown_owner_type} ->
          error(conn, 422, "未知的宿主类型")

        {:error, err} when is_exception(err) ->
          error(conn, 422, Exception.message(err))

        {:error, _} ->
          error(conn, 422, "挂接失败")
      end
    end)
  end
```

Run: `cd backend && mix compile --warnings-as-errors && mix test`
Expected: 编译通过,0 failures

- [ ] **Step 6: 前端 attachFile**

`web/app/lib/files.ts` 末尾加:

```typescript
/** 给已上传的裸文件补挂宿主附件(OCR 动线:识别先上传、单据保存成功后挂接) */
export async function attachFile(
  fileId: string,
  opts: { ownerType: string; ownerId: string; category?: string }
): Promise<UploadedAttachment> {
  const form = new FormData()
  form.append('owner_type', opts.ownerType)
  form.append('owner_id', opts.ownerId)
  if (opts.category) form.append('category', opts.category)

  const res = await fetch(`/api/files/${fileId}/attachments`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  const json = (await res.json()) as { attachment: UploadedAttachment }
  return json.attachment
}
```

- [ ] **Step 7: Commit**

```bash
git add -A backend web/app/lib/files.ts
git commit -m "feat(files): 已有文件补挂附件能力(Files.attach + REST + attachFile)"
```

---

### Task 7: 前端财务设置页 + 菜单 + 中文标签

**Files:**
- Create: `web/app/routes/_app/system/finance.tsx`
- Modify: `web/app/lib/menu.ts`(系统管理→配置组加一项)
- Modify: `web/app/components/synie-permission-sheet/permission-labels.ts`(RESOURCE_LABELS 加一行)
- Modify: `web/app/routes/_app/system/logs.tsx`(资源标签 map 加一行,先 grep `sys_storage: '存储接入'` 定位)

**Interfaces:**
- Consumes: GraphQL `accSetting` / `updateAccSetting`(Task 2)、`gqlFetch`、HeroUI 组件
- Produces: 路由 `/system/finance`(菜单「系统管理→配置→财务设置」);权限标签 `acc.setting: '财务设置'`

- [ ] **Step 1: 实现设置页**

`web/app/routes/_app/system/finance.tsx`(表单页,不是 DataGrid;secret 用 password 输入框;保存后同时失效 `accOcrConfigured` 缓存——OCR 按钮防呆立即生效):

```tsx
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Input, Label, Spinner, TextField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'

export const Route = createFileRoute('/_app/system/finance')({
  component: FinanceSettingsPage,
})

const SETTING_QUERY = `
  query {
    accSetting { id ocrAccessKeyId ocrAccessKeySecret }
  }
`
const UPDATE_SETTING = `
  mutation ($id: ID!, $input: UpdateAccSettingInput!) {
    updateAccSetting(id: $id, input: $input) { result { id } errors { message } }
  }
`

interface Setting {
  id: string
  ocrAccessKeyId: string | null
  ocrAccessKeySecret: string | null
}

function FinanceSettingsPage() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['accSetting'],
    queryFn: () => gqlFetch<{ accSetting: Setting | null }>(SETTING_QUERY).then((d) => d.accSetting),
  })

  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)

  // 查询回填本地草稿(单行配置,页面即表单)
  useEffect(() => {
    if (query.data) {
      setKeyId(query.data.ocrAccessKeyId ?? '')
      setSecret(query.data.ocrAccessKeySecret ?? '')
    }
  }, [query.data])

  const save = async () => {
    if (!query.data) return
    setSaving(true)
    try {
      const data = await gqlFetch<{ updateAccSetting: { errors: { message: string }[] | null } }>(
        UPDATE_SETTING,
        { id: query.data.id, input: { ocrAccessKeyId: keyId || null, ocrAccessKeySecret: secret || null } }
      )
      if (data.updateAccSetting.errors && data.updateAccSetting.errors.length > 0) {
        throw new Error(data.updateAccSetting.errors.map((e) => e.message).join('; '))
      }
      toast.success('财务设置已保存')
      queryClient.invalidateQueries({ queryKey: ['accSetting'] })
      queryClient.invalidateQueries({ queryKey: ['accOcrConfigured'] })
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">财务设置</h1>
      <p className="mt-2 text-sm text-ink-500">
        财务模块全局配置。阿里云 OCR 凭证用于发票/承兑汇票的票面识别,留空即停用识别入口。
      </p>

      <Card className="mt-6 max-w-2xl">
        <Card.Header>
          <Card.Title>票据 OCR(阿里云)</Card.Title>
          <Card.Description>
            阿里云 RAM 用户的 AccessKey,需授权 AliyunOCRFullAccess;仅本页与识别调用使用。
          </Card.Description>
        </Card.Header>
        <Card.Body>
          {query.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-danger">加载失败:{(query.error as Error).message}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <TextField value={keyId} onChange={setKeyId}>
                <Label>AccessKey ID</Label>
                <Input placeholder="如 LTAI5t…" />
              </TextField>
              <TextField value={secret} onChange={setSecret}>
                <Label>AccessKey Secret</Label>
                <Input type="password" placeholder="仅管理员可见,保存后生效" />
              </TextField>
              <div>
                <Button isPending={saving} onPress={save}>
                  保存
                </Button>
              </div>
            </div>
          )}
        </Card.Body>
      </Card>
    </>
  )
}
```

注:若 `Card.Title`/`Card.Description`/`Card.Body` 与当前 HeroUI 版本 anatomy 不符,以 MCP `heroui-pro` 的 Card 文档为准调整结构,视觉遵循 heroui-pro-design-taste。

- [ ] **Step 2: 菜单 + 标签**

`web/app/lib/menu.ts` 系统管理模块「配置」组:

```typescript
      {
        label: '配置',
        items: [
          { label: '编号规则', path: '/system/numbering' },
          { label: '财务设置', path: '/system/finance' },
        ],
      },
```

`web/app/components/synie-permission-sheet/permission-labels.ts` 的 RESOURCE_LABELS(`'acc.bill_holding'` 行后)加:

```typescript
  'acc.setting': '财务设置',
```

`web/app/routes/_app/system/logs.tsx` 资源标签 map(`sys_storage: '存储接入',` 附近)加:

```typescript
  acc_setting: '财务设置',
```

- [ ] **Step 3: 验证(typecheck 需要路由生成)**

```bash
cd web && bun run build && bun run typecheck
```
Expected: build 成功(生成 routeTree 后新路由类型可用)、typecheck 0 error

- [ ] **Step 4: Commit**

```bash
git add web
git commit -m "feat(web): 系统管理→财务设置页(阿里云 OCR 凭证)+ 菜单与权限标签"
```

---

### Task 8: 共享组件 SynieOcrButton

**Files:**
- Create: `web/app/components/synie-ocr-button/SynieOcrButton.tsx`

**Interfaces:**
- Consumes: `uploadFile`(`~/lib/files`)、`gqlFetch`、GraphQL query `accOcrConfigured`(Task 2)
- Produces: `<SynieOcrButton mutation resultKey accept onRecognized />`;`mutation` 是单变量 `$input` 的 mutation 字符串,`resultKey` 是响应字段名(如 `'ocrAccVatInvoice'`),`onRecognized(fields, fileId)` 在识别成功后回调(fields 为识别字段 map、fileId 为已上传裸文件 id,供保存后补挂附件)

- [ ] **Step 1: 实现组件**

`web/app/components/synie-ocr-button/SynieOcrButton.tsx`:

```tsx
import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { uploadFile } from '~/lib/files'

/**
 * 票据 OCR 按钮:选图 → 上传裸文件(暂不挂宿主)→ 调 OCR mutation → 识别字段交调用方回填。
 * 文件 id 一并交回,调用方在单据保存成功后用 attachFile 补挂为附件。
 * 未配置凭证(accOcrConfigured=false)时禁用并就地提示(禁用态没有 hover 事件,不用 Tooltip)。
 */
export interface SynieOcrButtonProps {
  /** OCR mutation 字符串,约定单变量 $input(内含 fileId) */
  mutation: string
  /** 响应字段名,如 'ocrAccVatInvoice' */
  resultKey: string
  /** 文件选择器 accept,如 'image/*,.pdf'(发票)或 'image/*'(承兑) */
  accept: string
  onRecognized: (fields: Record<string, unknown>, fileId: string) => void
}

const OCR_CONFIGURED = `query { accOcrConfigured }`

export function SynieOcrButton({ mutation, resultKey, accept, onRecognized }: SynieOcrButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const configured = useQuery({
    queryKey: ['accOcrConfigured'],
    queryFn: () =>
      gqlFetch<{ accOcrConfigured: boolean }>(OCR_CONFIGURED).then((d) => d.accOcrConfigured),
  })

  const handleFile = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    const toastId = toast('正在识别…', { isLoading: true, timeout: 0 })
    try {
      const { file: uploaded } = await uploadFile(file)
      const data = await gqlFetch<Record<string, unknown>>(mutation, { input: { fileId: uploaded.id } })
      // :map 返回按 JSON 标量下发;防御性兼容字符串形态(同 items json_string 先例)
      const raw = data[resultKey]
      const fields = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown> | null
      if (!fields || Object.keys(fields).length === 0) {
        toast.warning('未识别出票面内容,请人工录入')
        return
      }
      onRecognized(fields, uploaded.id)
      toast.success('识别完成,请核对回填内容')
    } catch (e) {
      toast.danger('识别失败', { description: (e as Error).message })
    } finally {
      toast.close(toastId)
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const disabled = configured.data === false
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 文件选择必须走原生 input,隐藏后由 Button 代理触发(同 SynieAttachmentPanel) */}
      <input ref={inputRef} type="file" accept={accept} hidden onChange={(e) => handleFile(e.target.files)} />
      <Button
        size="sm"
        variant="secondary"
        isPending={busy}
        isDisabled={disabled}
        onPress={() => inputRef.current?.click()}
      >
        <ScanIcon />
        上传识别
      </Button>
      {disabled && (
        <span className="text-xs text-muted">未配置 OCR 凭证,请到「系统管理→财务设置」配置</span>
      )}
    </div>
  )
}

// 项目无图标库,与 SynieAttachmentPanel 同款手写内联 SVG
function ScanIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11M2 8h12" />
    </svg>
  )
}
```

- [ ] **Step 2: 验证**

```bash
cd web && bun run typecheck
```
Expected: 0 error

- [ ] **Step 3: Commit**

```bash
git add web/app/components/synie-ocr-button
git commit -m "feat(web): SynieOcrButton 票据识别共享组件"
```

---

### Task 9: 发票创建动线接入 OCR

**Files:**
- Modify: `web/app/routes/_app/finance/invoices.tsx`

**Interfaces:**
- Consumes: `SynieOcrButton`(Task 8)、`attachFile`(Task 6)、mutation `ocrAccVatInvoice`(Task 5);页面既有 `patchValues`(extraContent 第 4 参)、`setItems`、`localRowId`
- Produces: 发票创建抽屉内「上传识别」入口;保存成功后原图挂为 `category="original"` 附件

- [ ] **Step 1: 接入**

`web/app/routes/_app/finance/invoices.tsx` 修改点:

1. import 区加:

```tsx
import { attachFile } from '~/lib/files'
import { SynieOcrButton } from '~/components/synie-ocr-button/SynieOcrButton'
```

2. mutation 常量区(`REVERSE_INVOICE` 之后)加:

```tsx
// OCR generic action:返回识别字段 JSON,不落库
const OCR_INVOICE = `
  mutation ($input: OcrAccVatInvoiceInput!) {
    ocrAccVatInvoice(input: $input)
  }
`
```

3. `InvoicesPage` 组件内(`reqIdRef` 声明之后)加:

```tsx
  // OCR 用图的裸文件 id:创建成功后补挂为附件,抽屉关闭即作废
  const ocrFileRef = useRef<string | null>(null)
```

4. `SynieRecordDrawer` 的 `onOpenChange` 里(`reqIdRef.current++` 之后)加一行:

```tsx
          ocrFileRef.current = null
```

5. `extraContent` 返回的 `<div className="flex flex-col gap-4">` 内、大写金额行之前加:

```tsx
              {mode === 'create' && (
                <SynieOcrButton
                  mutation={OCR_INVOICE}
                  resultKey="ocrAccVatInvoice"
                  accept="image/*,.pdf"
                  onRecognized={(fields, fileId) => {
                    // items 走本地清单状态,其余字段直接回填表单草稿
                    const { items: ocrItems, ...rest } = fields
                    patchValues(rest)
                    if (Array.isArray(ocrItems) && ocrItems.length > 0) {
                      setItems(ocrItems.map((it) => ({ id: localRowId(), ...(it as object) }) as Row))
                    }
                    ocrFileRef.current = fileId
                  }}
                />
              )}
```

6. `onSubmit` create 分支,`toast.success('发票已创建')` 之前(拿到 `createdId` 之后)加:

```tsx
            // OCR 原图补挂为附件;挂接失败不阻断建票,提示手工补传即可
            if (ocrFileRef.current) {
              const fid = ocrFileRef.current
              ocrFileRef.current = null
              try {
                await attachFile(fid, { ownerType: 'acc_vat_invoice', ownerId: createdId, category: 'original' })
              } catch (e) {
                toast.warning('发票已创建,但票面原图挂接失败,请在附件面板手工补传', {
                  description: (e as Error).message,
                })
              }
            }
```

- [ ] **Step 2: 验证**

```bash
cd web && bun run typecheck && bun run build
```
Expected: 0 error

- [ ] **Step 3: Commit**

```bash
git add web/app/routes/_app/finance/invoices.tsx
git commit -m "feat(web): 发票创建动线接入 OCR 识别回填与原图留档"
```

---

### Task 10: 承兑接收动线接入 OCR

**Files:**
- Modify: `web/app/routes/_app/finance/acceptance/-transaction-drawer.tsx`

**Interfaces:**
- Consumes: `SynieOcrButton`(Task 8)、`attachFile`(Task 6)、mutation `ocrAccBillTransaction`(Task 5);组件既有 `billDraft`/`setBillDraft`/`billLookup`/`runLookup`/`patchValues`
- Produces: 接收票面区「上传识别」入口(回填 snake_case 票面草稿并自动查档);创建成功后原图挂为附件(默认 category,与该抽屉附件面板一致)

- [ ] **Step 1: 接入**

`web/app/routes/_app/finance/acceptance/-transaction-drawer.tsx` 修改点:

1. import 区加:

```tsx
import { attachFile } from '~/lib/files'
import { SynieOcrButton } from '~/components/synie-ocr-button/SynieOcrButton'
```

2. mutation 常量区加:

```tsx
// OCR generic action:返回票面草稿字段(snake_case)JSON,不落库
const OCR_BILL = `
  mutation ($input: OcrAccBillTransactionInput!) {
    ocrAccBillTransaction(input: $input)
  }
`
```

3. `ReceiveBillSection` 的 props 增加 `onOcrFile`:

```tsx
function ReceiveBillSection({
  billDraft,
  setBillDraft,
  billLookup,
  setBillLookup,
  patchValues,
  onOcrFile,
}: {
  billDraft: Record<string, unknown>
  setBillDraft: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void
  billLookup: Row | null
  setBillLookup: (row: Row | null) => void
  patchValues: (patch: Record<string, unknown>) => void
  onOcrFile: (fileId: string) => void
}) {
```

4. `runLookup` 改为可显式传票号(OCR 回填后 state 未 flush,闭包里读不到新值):

```tsx
  const runLookup = async (billNoArg?: string) => {
    const billNo = (billNoArg ?? String(billDraft.bill_no ?? '')).trim()
```

其余不变;既有两处调用改为 `onBlur={() => runLookup()}`、`onPress={() => runLookup()}`(避免把事件对象当票号传入)。

5. 票面区标题行(`<span className="text-sm font-medium">票面信息(接收)</span>` 与「整票带出」按钮之间)加 OCR 按钮:

```tsx
        <div className="flex items-center gap-3">
          <SynieOcrButton
            mutation={OCR_BILL}
            resultKey="ocrAccBillTransaction"
            accept="image/*"
            onRecognized={(fields, fileId) => {
              // 识别视为换票:清查档命中,整体并入草稿后按新票号自动查档
              setBillLookup(null)
              patchValues({ billId: null })
              setBillDraft((prev) => ({ ...prev, ...fields }))
              onOcrFile(fileId)
              const billNo = typeof fields.bill_no === 'string' ? fields.bill_no.trim() : ''
              if (billNo) void runLookup(billNo)
            }}
          />
          <Button size="sm" variant="secondary" onPress={fullBillOut}>
            整票带出
          </Button>
        </div>
```

(原来单独的「整票带出」按钮移进这个容器,标题行仍是 `justify-between`。)

6. `AcceptanceTransactionDrawer` 组件内(`billDraft` state 声明之后)加:

```tsx
  // OCR 用图的裸文件 id:创建成功后补挂为附件,抽屉重开即作废
  const ocrFileRef = useRef<string | null>(null)
```

打开抽屉的 `useEffect`(`setBillDraft({})` 处)同步加:

```tsx
    ocrFileRef.current = null
```

7. `extraContent` 里 `<ReceiveBillSection ... />` 传入新 prop:

```tsx
                <ReceiveBillSection
                  billDraft={billDraft}
                  setBillDraft={setBillDraft}
                  billLookup={billLookup}
                  setBillLookup={setBillLookup}
                  patchValues={patchValues}
                  onOcrFile={(id) => {
                    ocrFileRef.current = id
                  }}
                />
```

8. `onSubmit` create 分支,`toast.success(...已创建)` 之前(create mutation 校验错误之后)加:

```tsx
          // OCR 原图补挂为附件;挂接失败不阻断建单,提示手工补传即可
          if (ocrFileRef.current) {
            const fid = ocrFileRef.current
            ocrFileRef.current = null
            try {
              await attachFile(fid, {
                ownerType: 'acc_bill_transaction',
                ownerId: data.createAccBillTransaction.result!.id,
              })
            } catch (e) {
              toast.warning('交易已创建,但票面原图挂接失败,请在附件面板手工补传', {
                description: (e as Error).message,
              })
            }
          }
```

注意 `useRef` 是否已在该文件 import(已有 `useRef`,见文件头部 import)。

- [ ] **Step 2: 验证**

```bash
cd web && bun run typecheck && bun run build
```
Expected: 0 error

- [ ] **Step 3: Commit**

```bash
git add web/app/routes/_app/finance/acceptance/-transaction-drawer.tsx
git commit -m "feat(web): 承兑接收动线接入 OCR 识别回填与原图留档"
```

---

### Task 11: 全量验证与收尾

**Files:**
- 无新文件;必要时修补

- [ ] **Step 1: 后端全量**

```bash
cd backend && mix format && git diff --stat  # format 应无本次改动之外的漂移
mix test
```
Expected: 0 failures

- [ ] **Step 2: 前端全量**

```bash
cd web && bun run typecheck && bun run build
```
Expected: 0 error

- [ ] **Step 3: 端到端冒烟(可选但推荐)**

起 dev(worktree 端口避开 4000/3000:后端 `PORT=4100 mix phx.server`、前端 `BACKEND_PORT=4100 bun run dev -- --host --port 3100`),用 playwright MCP 以 admin/admin123 登录:

1. 系统管理→财务设置:页面可开、能保存假凭证、保存后再打开值仍在。
2. 财务→增值税发票→新增:未配置凭证时(先清空凭证)按钮禁用并有提示;配置假凭证后按钮可点(识别会报阿里云错误——预期,链路通即可)。
3. 财务→承兑汇票→交易 tab→接收:票面区出现「上传识别」。

- [ ] **Step 4: 收尾 commit(如有修补)**

```bash
git add -A && git commit -m "chore: 票据 OCR 收尾修补"
```
