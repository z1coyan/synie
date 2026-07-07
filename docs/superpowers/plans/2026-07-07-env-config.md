# Synie Env Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize backend runtime env configuration and make dev/test Postgres default to the Docker-exposed `localhost:5440` database.

**Architecture:** Add a pure, tested `SynieCore.Config` module that converts env maps into `SynieCore.Repo` keyword config. Keep compile-time app wiring in `config.exs`, move Repo connection details to `runtime.exs`, and document the supported env variables with a backend `.env.example`.

**Tech Stack:** Elixir 1.20 / OTP 28, Mix umbrella, AshPostgres/Ecto Repo config, ExUnit.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-07-env-config-design.md`.
- No new dependencies; use `System.get_env/0`, `System.get_env/1`, `Integer.parse/1`, and Mix/Phoenix config only.
- Do not auto-load `.env` files.
- `DATABASE_URL` has priority over split `PG*` variables.
- dev/test default `PGPORT` is `5440`.
- prod requires `DATABASE_URL` and `SECRET_KEY_BASE`; prod must not fall back to development database defaults.
- Keep dev/test Phoenix endpoint ports in `backend/config/dev.exs` and `backend/config/test.exs` unchanged.
- Follow TDD: write failing tests before production code, then implement the smallest code that passes.
- Commit at the end of each task.

---

## File Structure

```
synie/
├── backend/
│   ├── .env.example                                  # local env template; not auto-loaded
│   ├── config/
│   │   ├── config.exs                                # compile-time app wiring; no Repo connection details
│   │   ├── runtime.exs                               # runtime Repo config + prod Endpoint secrets
│   │   └── test.exs                                  # test Endpoint/log config only after Repo centralization
│   └── apps/
│       └── synie_core/
│           ├── lib/
│           │   └── synie_core/
│           │       └── config.ex                     # pure env-to-Repo-config resolver
│           └── test/
│               └── synie_core/
│                   └── config_test.exs               # resolver contract tests
├── README.md                                         # backend env usage docs
└── docs/superpowers/plans/2026-07-07-env-config.md   # this plan
```

---

### Task 1: Add tested Repo env resolver

**Files:**
- Create: `backend/apps/synie_core/test/synie_core/config_test.exs`
- Create: `backend/apps/synie_core/lib/synie_core/config.ex`

**Interfaces:**
- Produces: `SynieCore.Config.repo_config(env, vars \\ System.get_env()) :: keyword()`.
- `env` is one of `:dev | :test | :prod`.
- `vars` is a map of string env names to string values, matching `System.get_env/0`.
- Later task consumes `SynieCore.Config.repo_config(config_env())` from `backend/config/runtime.exs`.

- [ ] **Step 1: Write the failing tests**

Create `backend/apps/synie_core/test/synie_core/config_test.exs`:

```elixir
defmodule SynieCore.ConfigTest do
  use ExUnit.Case, async: true

  alias SynieCore.Config

  @database_url "postgres://app:secret@db.example.com:5432/synie"

  describe "repo_config/2 for dev" do
    test "resolves an empty environment to the local Docker database" do
      config = Config.repo_config(:dev, %{})

      assert config[:username] == "postgres"
      assert config[:password] == "postgres"
      assert config[:hostname] == "localhost"
      assert config[:port] == 5440
      assert config[:database] == "synie_dev"
      assert config[:pool_size] == 10
      refute Keyword.has_key?(config, :url)
    end

    test "uses split PG variables when DATABASE_URL is absent" do
      config =
        Config.repo_config(:dev, %{
          "PGUSER" => "synie",
          "PGPASSWORD" => "secret",
          "PGHOST" => "127.0.0.1",
          "PGPORT" => "5441",
          "PGDATABASE" => "custom_dev",
          "POOL_SIZE" => "4"
        })

      assert config == [
               username: "synie",
               password: "secret",
               database: "custom_dev",
               hostname: "127.0.0.1",
               port: 5441,
               pool_size: 4
             ]
    end
  end

  describe "repo_config/2 for test" do
    test "resolves an empty environment to the test database with SQL sandbox" do
      config = Config.repo_config(:test, %{})

      assert config[:database] == "synie_test"
      assert config[:hostname] == "localhost"
      assert config[:port] == 5440
      assert config[:pool] == Ecto.Adapters.SQL.Sandbox
      refute Keyword.has_key?(config, :url)
    end
  end

  describe "repo_config/2 with DATABASE_URL" do
    test "uses DATABASE_URL instead of split PG variables" do
      config =
        Config.repo_config(:dev, %{
          "DATABASE_URL" => @database_url,
          "PGHOST" => "ignored-host",
          "PGPORT" => "not-used",
          "PGDATABASE" => "ignored_database"
        })

      assert config[:url] == @database_url
      assert config[:pool_size] == 10
      refute_split_database_options(config)
    end

    test "keeps SQL sandbox when test uses DATABASE_URL" do
      config = Config.repo_config(:test, %{"DATABASE_URL" => @database_url})

      assert config[:url] == @database_url
      assert config[:pool] == Ecto.Adapters.SQL.Sandbox
      refute_split_database_options(config)
    end
  end

  describe "repo_config/2 integer parsing" do
    test "rejects invalid PGPORT with the variable name and value in the error" do
      error =
        assert_raise RuntimeError, fn ->
          Config.repo_config(:dev, %{"PGPORT" => "not-a-port"})
        end

      assert Exception.message(error) =~ "PGPORT"
      assert Exception.message(error) =~ "not-a-port"
      assert Exception.message(error) =~ ~r/integer/i
    end

    test "rejects invalid POOL_SIZE with the variable name and value in the error" do
      error =
        assert_raise RuntimeError, fn ->
          Config.repo_config(:prod, %{
            "DATABASE_URL" => @database_url,
            "POOL_SIZE" => "too-many"
          })
        end

      assert Exception.message(error) =~ "POOL_SIZE"
      assert Exception.message(error) =~ "too-many"
      assert Exception.message(error) =~ ~r/integer/i
    end
  end

  describe "repo_config/2 for prod" do
    test "requires DATABASE_URL" do
      error =
        assert_raise RuntimeError, fn ->
          Config.repo_config(:prod, %{})
        end

      assert Exception.message(error) =~ "DATABASE_URL"
      assert Exception.message(error) =~ ~r/missing/i
    end

    test "uses DATABASE_URL and parses POOL_SIZE" do
      config =
        Config.repo_config(:prod, %{
          "DATABASE_URL" => @database_url,
          "POOL_SIZE" => "25"
        })

      assert config[:url] == @database_url
      assert config[:pool_size] == 25
      refute_split_database_options(config)
    end
  end

  defp refute_split_database_options(config) do
    refute Keyword.has_key?(config, :username)
    refute Keyword.has_key?(config, :password)
    refute Keyword.has_key?(config, :database)
    refute Keyword.has_key?(config, :hostname)
    refute Keyword.has_key?(config, :port)
  end
end
```

- [ ] **Step 2: Run the test to verify RED**

Run from `backend/`:

```bash
mix test apps/synie_core/test/synie_core/config_test.exs --trace
```

Expected: FAIL. The first failure should be an `UndefinedFunctionError` for `SynieCore.Config.repo_config/2` because the module has not been implemented yet.

- [ ] **Step 3: Implement the minimal resolver**

Create `backend/apps/synie_core/lib/synie_core/config.ex`:

```elixir
defmodule SynieCore.Config do
  @moduledoc false

  @default_pool_size "10"

  @type environment :: :dev | :test | :prod
  @type vars :: %{optional(String.t()) => String.t()}

  @spec repo_config(environment(), vars()) :: keyword()
  def repo_config(env, vars \\ System.get_env())

  def repo_config(:prod, vars) do
    [
      url: required_env!(vars, "DATABASE_URL"),
      pool_size: integer_env!(vars, "POOL_SIZE", @default_pool_size)
    ]
  end

  def repo_config(env, vars) when env in [:dev, :test] do
    config =
      case env_value(vars, "DATABASE_URL") do
        nil -> split_repo_config(env, vars)
        database_url -> [url: database_url, pool_size: integer_env!(vars, "POOL_SIZE", @default_pool_size)]
      end

    maybe_put_test_pool(env, config)
  end

  defp split_repo_config(env, vars) do
    defaults = defaults_for(env)

    [
      username: env_value(vars, "PGUSER", defaults.username),
      password: env_value(vars, "PGPASSWORD", defaults.password),
      database: env_value(vars, "PGDATABASE", defaults.database),
      hostname: env_value(vars, "PGHOST", defaults.hostname),
      port: integer_env!(vars, "PGPORT", Integer.to_string(defaults.port)),
      pool_size: integer_env!(vars, "POOL_SIZE", @default_pool_size)
    ]
  end

  defp defaults_for(:dev) do
    %{
      username: "postgres",
      password: "postgres",
      database: "synie_dev",
      hostname: "localhost",
      port: 5440
    }
  end

  defp defaults_for(:test) do
    %{
      username: "postgres",
      password: "postgres",
      database: "synie_test",
      hostname: "localhost",
      port: 5440
    }
  end

  defp maybe_put_test_pool(:test, config), do: Keyword.put(config, :pool, Ecto.Adapters.SQL.Sandbox)
  defp maybe_put_test_pool(_env, config), do: config

  defp required_env!(vars, name) do
    case env_value(vars, name) do
      nil -> raise "#{name} is missing"
      value -> value
    end
  end

  defp integer_env!(vars, name, default) do
    value = env_value(vars, name, default)

    case Integer.parse(value) do
      {integer, ""} -> integer
      _ -> raise "#{name} must be an integer, got: #{inspect(value)}"
    end
  end

  defp env_value(vars, name, default \\ nil) do
    case Map.get(vars, name) do
      value when is_binary(value) and value != "" -> value
      _ -> default
    end
  end
end
```

- [ ] **Step 4: Run the resolver tests to verify GREEN**

Run from `backend/`:

```bash
mix test apps/synie_core/test/synie_core/config_test.exs --trace
```

Expected: PASS, `9 tests, 0 failures`.

- [ ] **Step 5: Commit**

Run from repository root:

```bash
git add backend/apps/synie_core/lib/synie_core/config.ex backend/apps/synie_core/test/synie_core/config_test.exs
git commit -m "feat(backend): add repo env config resolver"
```

---

### Task 2: Wire runtime Repo config

**Files:**
- Modify: `backend/config/config.exs`
- Modify: `backend/config/runtime.exs`
- Modify: `backend/config/test.exs`

**Interfaces:**
- Consumes: `SynieCore.Config.repo_config(config_env()) :: keyword()` from Task 1.
- Produces: runtime `:synie_core, SynieCore.Repo` config with dev/test default port `5440` and prod-required `DATABASE_URL`.

- [ ] **Step 1: Verify current runtime behavior is wrong**

Run from `backend/` before editing config files:

```bash
MIX_ENV=dev mix run --no-start -e 'IO.inspect(Application.fetch_env!(:synie_core, SynieCore.Repo)[:port])'
```

Expected: output is `nil`, proving the current Repo config does not set the desired `5440` port.

- [ ] **Step 2: Remove static Repo connection details from `config.exs`**

Replace `backend/config/config.exs` with:

```elixir
import Config

config :synie_core, ash_domains: [SynieCore]

config :synie_web,
  namespace: SynieWeb,
  ecto_repos: [SynieCore.Repo]

config :synie_web, SynieWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [html: SynieWeb.ErrorHTML, json: SynieWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: SynieWeb.PubSub,
  live_view: [signing_salt: "synie_salt"]

config :phoenix, :json_library, Jason
import_config "#{config_env()}.exs"
```

- [ ] **Step 3: Centralize Repo config in `runtime.exs`**

Replace `backend/config/runtime.exs` with:

```elixir
import Config

config :synie_core, SynieCore.Repo, SynieCore.Config.repo_config(config_env())

if config_env() == :prod do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE is missing"

  config :synie_web, SynieWeb.Endpoint,
    server: true,
    secret_key_base: secret_key_base,
    url: [host: System.get_env("PHX_HOST") || "localhost", port: 80]
end
```

- [ ] **Step 4: Remove duplicate test Repo config**

Replace `backend/config/test.exs` with:

```elixir
import Config

# Test-specific configuration.
# The endpoint is not started in the test environment; SynieWeb.Endpoint
# config here only satisfies Phoenix's compile-time requirements.

config :synie_web, SynieWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "synie_test_secret_key_base_for_test_only_not_for_prod",
  server: false

config :logger, level: :warning
```

- [ ] **Step 5: Verify dev runtime config now uses port 5440**

Run from `backend/`:

```bash
MIX_ENV=dev mix run --no-start -e 'IO.inspect(Application.fetch_env!(:synie_core, SynieCore.Repo)[:port])'
```

Expected: output is `5440`.

- [ ] **Step 6: Verify test runtime config keeps sandbox and test database**

Run from `backend/`:

```bash
MIX_ENV=test mix run --no-start -e 'config = Application.fetch_env!(:synie_core, SynieCore.Repo); IO.inspect({config[:database], config[:port], config[:pool]})'
```

Expected: output is `{"synie_test", 5440, Ecto.Adapters.SQL.Sandbox}`.

- [ ] **Step 7: Verify DATABASE_URL precedence in runtime config**

Run from `backend/`:

```bash
DATABASE_URL='postgres://app:secret@db.example.com:5432/synie' PGPORT=9999 MIX_ENV=dev mix run --no-start -e 'config = Application.fetch_env!(:synie_core, SynieCore.Repo); IO.inspect({config[:url], Keyword.has_key?(config, :port)})'
```

Expected: output is `{"postgres://app:secret@db.example.com:5432/synie", false}`.

- [ ] **Step 8: Run targeted tests**

Run from `backend/`:

```bash
mix test apps/synie_core/test/synie_core/config_test.exs --trace
```

Expected: PASS, `9 tests, 0 failures`.

- [ ] **Step 9: Commit**

Run from repository root:

```bash
git add backend/config/config.exs backend/config/runtime.exs backend/config/test.exs
git commit -m "feat(backend): wire repo runtime env config"
```

---

### Task 3: Document env usage after verified config

**Files:**
- Create: `backend/.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: runtime env contract implemented by Tasks 1-2.
- Produces: documented local defaults and override mechanism.

- [ ] **Step 1: Add the backend env example**

Create `backend/.env.example`:

```env
PGHOST=localhost
PGPORT=5440
PGUSER=postgres
PGPASSWORD=postgres
PGDATABASE=synie_dev
POOL_SIZE=10
```

- [ ] **Step 2: Update README environment requirements**

In `README.md`, replace the current backend Postgres paragraph under `## 环境要求` with:

```markdown
后端 `SynieCore.Repo` 的数据库连接由运行时 env 统一管理。开发环境默认连接 Docker 暴露的本机 Postgres：

- username: `postgres`
- password: `postgres`
- database: `synie_dev`
- host: `localhost`
- port: `5440`

可用两种方式覆盖：

1. 设置 `DATABASE_URL`，优先级最高，例如 `postgres://postgres:postgres@localhost:5440/synie_dev`。
2. 设置拆分变量：`PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`、`POOL_SIZE`。

`backend/.env.example` 记录了本地默认值，但应用不会自动加载 `.env` 文件；请用 shell、direnv、Docker Compose `env_file` 或 IDE run configuration 注入变量。
```

Keep the existing paragraph about `sayHello` being pure and not requiring the database, but update it so it refers to env config instead of hard-coded Postgres settings.

- [ ] **Step 3: Update README production env list**

In `README.md`, under `backend/config/runtime.exs` production env bullets, keep the existing production variables and add the local/dev variables as a separate note:

```markdown
本地开发和测试也会读取：

- `DATABASE_URL`（可选，优先级最高）
- `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`
- `POOL_SIZE`（可选，默认 `10`）
```

- [ ] **Step 4: Run the full backend core test set**

Run from `backend/`:

```bash
mix test apps/synie_core/test/ --trace
```

Expected: PASS. Existing Hello/domain tests plus the 9 new config tests pass. No test should require a live Postgres connection.

- [ ] **Step 5: Verify docs mention the corrected port and no stale default**

Use the Grep tool, not shell grep:

- Pattern: `5440|5432|PGPORT|DATABASE_URL`
- Path: `README.md; backend/.env.example; backend/config`

Expected: `5440` appears in README and `.env.example`; `5432` appears only in example `DATABASE_URL` strings if still present, not as the documented local default port.

- [ ] **Step 6: Commit**

Run from repository root:

```bash
git add backend/.env.example README.md
git commit -m "docs: document backend env config"
```

---

## Final Verification

Run after all tasks from `backend/`:

```bash
mix test apps/synie_core/test/ --trace
```

Expected: PASS. This verifies the resolver contract and existing core behavior without requiring a live Postgres database.

Run from `backend/`:

```bash
MIX_ENV=dev mix run --no-start -e 'IO.inspect(Application.fetch_env!(:synie_core, SynieCore.Repo)[:port])'
```

Expected: `5440`.

Run from `backend/`:

```bash
MIX_ENV=prod mix run --no-start -e 'Application.fetch_env!(:synie_core, SynieCore.Repo)'
```

Expected: fails with `DATABASE_URL is missing` unless `DATABASE_URL` is provided. This confirms prod does not use dev defaults.
