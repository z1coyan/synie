# Synie Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a working full-stack skeleton: Elixir+Ash umbrella backend exposing a GraphQL `hello` query, TanStack Start + HeroUI frontend that queries and displays it.

**Architecture:** Two independent projects side-by-side under `~/code/synie`: `backend/` (Elixir umbrella with `synie_core` domain layer + `synie_web` Phoenix/GraphQL boundary) and `web/` (TanStack Start SPA). Frontend Vite dev server proxies `/graphql` to backend on `:4000`. No monorepo, no root `package.json`.

**Tech Stack:** Elixir 1.20 / OTP 28, Ash 3.x + ash_postgres + ash_graphql + ash_authentication(_phoenix), Phoenix; TanStack Start (@tanstack/react-start + react-router), HeroUI v2.8+ (@heroui/react), Tailwind CSS v4, @graphql-codegen/cli.

## Global Constraints

- Working directory: `~/code/synie` (already git-initialized, local identity `synie <synie@local>`).
- Elixir 1.20.2 / OTP 28, mix on PATH. Bun 1.3.14 on PATH.
- No root `package.json`, no root `mix.exs` — two independent projects.
- Backend umbrella child apps: `synie_core` (domain + repo + resources), `synie_web` (Phoenix endpoint + GraphQL schema).
- Ash extensions installed via `mix igniter.install <pkg>` from the `backend/` directory (igniter is pulled in by ash installers).
- Ash Authentication + Ash Postgres dependencies installed and Repo configured, but no User resource / no login flow in skeleton scope.
- `hello` query is a generic Ash action returning `:string`, no DB table.
- Frontend single package `web/`, HeroUI via global `@heroui/react`, Tailwind v4 CSS-first (no `tailwind.config.js`).
- GraphQL codegen: schema fetched from backend `/graphql`, TS types generated into `web/app/graphql/`.
- Commit frequently; each task ends with a commit.
- Spec: `docs/superpowers/specs/2026-07-07-synie-scaffold-design.md`.

---

## File Structure

```
synie/
├── backend/
│   ├── mix.exs                              # umbrella mix.exs
│   ├── .formatter.exs
│   ├── config/
│   │   ├── config.exs
│   │   ├── dev.exs
│   │   └── runtime.exs
│   └── apps/
│       ├── synie_core/
│       │   ├── mix.exs
│       │   ├── lib/
│       │   │   ├── synie_core.ex             # Ash Domain
│       │   │   ├── synie_core/application.ex # OTP app
│       │   │   ├── synie_core/repo.ex        # AshPostgres.Repo
│       │   │   └── synie_core/resources/hello.ex
│       │   └── test/
│       │       └── synie_core/resources/hello_test.exs
│       └── synie_web/
│           ├── mix.exs
│           ├── lib/
│           │   ├── synie_web.ex
│           │   ├── synie_web/application.ex
│           │   ├── synie_web/endpoint.ex
│           │   ├── synie_web/router.ex
│           │   └── synie_web/schema.ex        # Absinthe + AshGraphql schema
│           └── test/
│               └── synie_web/schema_test.exs
├── web/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── postcss.config.js
│   ├── codegen.ts
│   ├── app.css
│   ├── app/
│   │   ├── router.tsx
│   │   ├── client.tsx
│   │   ├── lib/
│   │   │   └── graphql.ts
│   │   └── routes/
│   │       ├── __root.tsx
│   │       └── index.tsx
│   └── app/graphql/                          # codegen output (generated)
└── docs/superpowers/
    ├── specs/2026-07-07-synie-scaffold-design.md
    └── plans/2026-07-07-synie-scaffold.md
```

---

### Task 1: Create Elixir umbrella project with two child apps

**Files:**
- Create: `backend/mix.exs`, `backend/.formatter.exs`, `backend/config/config.exs`, `backend/config/dev.exs`, `backend/config/runtime.exs`
- Create: `backend/apps/synie_core/mix.exs`, `backend/apps/synie_core/lib/synie_core/application.ex`
- Create: `backend/apps/synie_web/mix.exs`, `backend/apps/synie_web/lib/synie_web/application.ex`, `backend/apps/synie_web/lib/synie_web.ex`
- Create: `backend/apps/synie_core/lib/synie_core.ex`

**Interfaces:**
- Produces: `SynieCore` OTP app, `SynieWeb` OTP app, umbrella `:synie` project that lists both as `apps:`.

- [ ] **Step 1: Generate the umbrella project skeleton**

Run from `~/code/synie`:
```bash
mix new backend --umbrella --sup
cd backend
```
Expected: `backend/mix.exs` (umbrella), `backend/apps/` directory, `backend/config/config.exs` present.

- [ ] **Step 2: Generate the synie_core child app**

Run from `~/code/synie/backend`:
```bash
mix new apps/synie_core --sup
```
Expected: `apps/synie_core/mix.exs`, `lib/synie_core/application.ex` with `def start` supervising `[]`.

- [ ] **Step 3: Generate the synie_web child app**

Run from `~/code/synie/backend`:
```bash
mix new apps/synie_web --sup
```
Expected: `apps/synie_web/mix.exs`, `lib/synie_web/application.ex`.

- [ ] **Step 4: Make synie_web depend on synie_core**

Edit `backend/apps/synie_web/mix.exs` deps to add the umbrella sibling:
```elixir
  defp deps do
    [
      {:synie_core, in_umbrella: true}
    ]
  end
```

- [ ] **Step 5: Verify the umbrella compiles**

Run from `~/code/synie/backend`:
```bash
mix deps.get
mix compile
```
Expected: compiles without error; `SynieCore.Application` and `SynieWeb.Application` present.

- [ ] **Step 6: Commit**

```bash
cd ~/code/synie
git add backend
git commit -m "feat(backend): scaffold elixir umbrella with synie_core and synie_web"
```

---

### Task 2: Install Ash + ash_postgres in synie_core, configure Domain and Repo

**Files:**
- Modify: `backend/apps/synie_core/mix.exs` (deps added by igniter)
- Modify: `backend/apps/synie_core/lib/synie_core.ex` (Ash Domain)
- Create: `backend/apps/synie_core/lib/synie_core/repo.ex` (AshPostgres.Repo)
- Modify: `backend/apps/synie_core/lib/synie_core/application.ex` (supervise Repo)
- Modify: `backend/config/config.exs` (ash_domains, repo config)
- Modify: `backend/.formatter.exs`

**Interfaces:**
- Produces: `SynieCore.Domain` (Ash Domain), `SynieCore.Repo` (AshPostgres.Repo with `installed_extensions/0` returning `["ash-functions", "citext"]`), `SynieCore.Application` supervising `SynieCore.Repo`.

- [ ] **Step 1: Install ash + ash_postgres via igniter**

Run from `~/code/synie/backend`:
```bash
mix archive.install hex igniter_new
mix igniter.install ash ash_postgres --yes
```
Expected: deps added to umbrella/child mix.exs, `.formatter.exs` updated, config updated. igniter may prompt for the app — answer `synie_core` if asked. If it modifies `synie_web` instead, that's fine for deps; we will move domain config into `synie_core` next.

Note: `mix igniter.install` runs at the umbrella root and applies to child apps. If it does not know which child to target, run it from `backend/apps/synie_core` instead:
```bash
cd backend/apps/synie_core
mix igniter.install ash ash_postgres --yes
cd ../..
```

- [ ] **Step 2: Define SynieCore as an Ash Domain**

Write `backend/apps/synie_core/lib/synie_core.ex`:
```elixir
defmodule SynieCore do
  use Ash.Domain

  resources do
    resource SynieCore.Resources.Hello
  end
end
```
(The `Hello` resource is created in Task 4; for now this won't compile until Task 4 step 2. If you prefer to keep it compiling between tasks, define a placeholder resource file now — but Task 4 will replace it.)

- [ ] **Step 3: Create the Repo**

Write `backend/apps/synie_core/lib/synie_core/repo.ex`:
```elixir
defmodule SynieCore.Repo do
  use AshPostgres.Repo, otp_app: :synie_core

  def installed_extensions do
    ["ash-functions", "citext"]
  end
end
```

- [ ] **Step 4: Wire Repo into the application supervisor**

Write `backend/apps/synie_core/lib/synie_core/application.ex`:
```elixir
defmodule SynieCore.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      SynieCore.Repo
    ]

    opts = [strategy: :one_for_one, name: SynieCore.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
```

- [ ] **Step 5: Configure ash_domains and repo in config/config.exs**

Edit `backend/config/config.exs`, ensure it contains:
```elixir
import Config

config :synie_core, ash_domains: [SynieCore]

config :synie_core, SynieCore.Repo,
  username: "postgres",
  password: "postgres",
  database: "synie_dev",
  hostname: "localhost",
  stacktrace: true,
  show_sensitive_data_on_connection_error: true,
  pool_size: 10
```

- [ ] **Step 6: Update .formatter.exs**

Ensure `backend/.formatter.exs` contains:
```elixir
[
  import_deps: [:ash, :ash_postgres, :ash_graphql, :ash_authentication, :ash_authentication_phoenix, :ecto, :ecto_sql],
  subdirectories: ["apps/*/priv/*/migrations"],
  inputs: ["*.{ex,exs}", "{config,lib,test}/**/*.{ex,exs}", "apps/*/{config,lib,test}/**/*.{ex,exs}"]
]
```

- [ ] **Step 7: Create a stub Hello resource so the domain compiles**

Write `backend/apps/synie_core/lib/synie_core/resources/hello.ex`:
```elixir
defmodule SynieCore.Resources.Hello do
  use Ash.Resource, domain: SynieCore

  actions do
    defaults [:read]
  end

  attributes do
    uuid_primary_key :id
  end
end
```
(This is a minimal stub; Task 4 replaces it with a generic action + GraphQL.)

- [ ] **Step 8: Verify compile**

Run from `~/code/synie/backend`:
```bash
mix deps.get
mix compile
```
Expected: compiles cleanly.

- [ ] **Step 9: Commit**

```bash
cd ~/code/synie
git add backend
git commit -m "feat(backend): install ash + ash_postgres, configure domain and repo"
```

---

### Task 3: Install ash_graphql + Phoenix in synie_web, wire endpoint and router

**Files:**
- Modify: `backend/apps/synie_web/mix.exs` (deps)
- Create: `backend/apps/synie_web/lib/synie_web/endpoint.ex`
- Create: `backend/apps/synie_web/lib/synie_web/router.ex`
- Modify: `backend/apps/synie_web/lib/synie_web/application.ex`
- Modify: `backend/config/config.exs` / `config/runtime.exs`

**Interfaces:**
- Consumes: `SynieCore` (umbrella dep), `SynieCore.Repo`
- Produces: `SynieWeb.Endpoint` (Phoenix endpoint on port 4000), `SynieWeb.Router` (Phoenix router forwarding `/graphql`).

- [ ] **Step 1: Add Phoenix + ash_graphql deps to synie_web**

Edit `backend/apps/synie_web/mix.exs` deps:
  defp deps do
    [
      {:synie_core, in_umbrella: true},
      {:phoenix, "~> 1.7"},
      {:phoenix_html, "~> 4.0"},
      {:plug_cowboy, "~> 2.7"},
      {:jason, "~> 1.4"},
      {:ash_graphql, "~> 1.9"},
      {:ash_authentication, "~> 4.0"},
      {:ash_authentication_phoenix, "~> 2.0"}
    ]
  end

- [ ] **Step 2: deps.get and install ash_graphql + ash_authentication_phoenix igniter**

Run from `~/code/synie/backend`:
```bash
mix deps.get
mix igniter.install ash_graphql --yes
mix igniter.install ash_authentication_phoenix --yes
```
The `ash_authentication_phoenix` installer will also pull in `ash_authentication` if not already present (it is, via Step 1). Per spec §2/§7 we only install deps and basic config — we do NOT run `mix ash_authentication.add_strategy` or define a User/Token resource. If the igniter installer prompts to set up strategies or a User resource, decline / skip; skeleton scope stops at "deps installed".

If igniter asks where to set up the schema, point it at `synie_web`. If it fails to locate, run from `backend/apps/synie_web`:
```bash
cd backend/apps/synie_web
mix igniter.install ash_graphql ash_authentication_phoenix --yes
cd ../..
```

- [ ] **Step 3: Create the Absinthe/AshGraphql schema**

Write `backend/apps/synie_web/lib/synie_web/schema.ex`:
```elixir
defmodule SynieWeb.Schema do
  use Absinthe.Schema
  use AshGraphql, domains: [SynieCore]

  query do
  end

  mutation do
  end
end
```
(The `hello` query is auto-generated by AshGraphql from the domain's declared action in Task 4; nothing to write here yet.)

- [ ] **Step 4: Create the Phoenix Router**

Write `backend/apps/synie_web/lib/synie_web/router.ex`:
```elixir
defmodule SynieWeb.Router do
  use Phoenix.Router

  pipeline :graphql do
    plug Plug.Parsers,
      parsers: [:urlencoded, :multipart, :json],
      pass: ["*/*"],
      json_decoder: Jason
    plug AshGraphql.Plug
  end

  scope "/graphql" do
    pipe_through [:graphql]

    forward "/playground",
            Absinthe.Plug.GraphiQL,
            schema: Module.concat(["SynieWeb.Schema"]),
            interface: :playground

    forward "/",
            Absinthe.Plug,
            schema: Module.concat(["SynieWeb.Schema"])
  end
end
```

- [ ] **Step 5: Create the Phoenix Endpoint**

Write `backend/apps/synie_web/lib/synie_web/endpoint.ex`:
```elixir
defmodule SynieWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :synie_web

  socket "/live", Phoenix.LiveView.Socket

  plug Plug.Static,
    at: "/",
    from: :synie_web,
    gzip: false,
    only: ~w(assets fonts images favicon.ico robots.txt)

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Session,
    store: :cookie,
    key: "_synie_web_key",
    signing_salt: "synie_salt"

  plug :router
  def router(conn, _opts), do: SynieWeb.Router.call(conn, [])
end
```

- [ ] **Step 6: Wire endpoint into synie_web application supervisor**

Write `backend/apps/synie_web/lib/synie_web/application.ex`:
```elixir
defmodule SynieWeb.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Phoenix.PubSub, name: SynieWeb.PubSub},
      SynieWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: SynieWeb.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, removed) do
    changed
    |> Enum.concat(removed)
    |> Enum.each(fn {app, _} ->
      Application.put_env(app, :changed, true)
    end)
    :ok
  end
end
```

- [ ] **Step 7: Configure endpoint in config/config.exs**

Append to `backend/config/config.exs`:
```elixir
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
```
Add `{:bandit, "~> 1.5"}` to `synie_web` deps and `mix deps.get` (Bandit is the modern Phoenix adapter). Add the missing error modules below.

- [ ] **Step 8: Add minimal error render modules**

Write `backend/apps/synie_web/lib/synie_web/error_html.ex`:
```elixir
defmodule SynieWeb.ErrorHTML do
  use SynieWeb, :html

  def render("404.html", _assigns) do
    "Not found"
  end

  def render("500.html", _assigns) do
    "Internal server error"
  end

  def template_not_found(_template, _assigns) do
    "Template not found"
  end
end
```

Write `backend/apps/synie_web/lib/synie_web/error_json.ex`:
```elixir
defmodule SynieWeb.ErrorJSON do
  def render("404.json", _assigns) do
    %{errors: %{detail: "Not found"}}
  end

  def render("500.json", _assigns) do
    %{errors: %{detail: "Internal server error"}}
  end
end
```

Update `backend/apps/synie_web/lib/synie_web.ex` to provide the `:html` and `:controller` macros:
```elixir
defmodule SynieWeb do
  @moduledoc false

  def html do
    quote do
      use Phoenix.Component
      import Phoenix.HTML
    end
  end

  def controller do
    quote do
      use Phoenix.Controller, formats: [:html, :json]
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
```

- [ ] **Step 9: Add runtime.exs for env-driven config**

Write `backend/config/runtime.exs`:
```elixir
import Config

if config_env() == :prod do
  database_url =
    System.get_env("DATABASE_URL") ||
      raise "DATABASE_URL is missing"

  config :synie_core, SynieCore.Repo,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10")

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE is missing"

  config :synie_web, SynieWeb.Endpoint,
    server: true,
    secret_key_base: secret_key_base,
    url: [host: System.get_env("PHX_HOST") || "localhost", port: 80]
end
```

- [ ] **Step 10: Verify compile**

Run from `~/code/synie/backend`:
```bash
mix deps.get
mix compile
```
Expected: compiles. (Endpoint will fail to start at runtime until `synie_web` config is present — already added in Step 7.)

- [ ] **Step 11: Commit**

```bash
cd ~/code/synie
git add backend
git commit -m "feat(backend): install ash_graphql + phoenix, wire endpoint and router"
```

---

### Task 4: Add Hello resource with generic action and GraphQL query wiring

**Files:**
- Modify: `backend/apps/synie_core/lib/synie_core/resources/hello.ex`
- Modify: `backend/apps/synie_core/lib/synie_core.ex` (add AshGraphql.Domain extension + queries)
- Create: `backend/apps/synie_core/test/synie_core/resources/hello_test.exs`
- Modify: `backend/apps/synie_core/test/test_helper.exs` (ensure present)

**Interfaces:**
- Consumes: Ash, AshGraphql.Resource, AshGraphql.Domain
- Produces: `SynieCore.Resources.Hello` with generic action `:say_hello` (arg `name: String!`, returns `:string`), exposed as GraphQL query `sayHello(name: String!): String!` (ash_graphql camelizes by default — verify actual field name in Step 6; if it stays `say_hello`, update the frontend query in Task 7 accordingly).

- [ ] **Step 1: Write the failing test for the generic action**

Create `backend/apps/synie_core/test/test_helper.exs`:
```elixir
ExUnit.start()
Application.ensure_all_started(:ash)
```

Create `backend/apps/synie_core/test/synie_core/resources/hello_test.exs`:
```elixir
defmodule SynieCore.Resources.HelloTest do
  use ExUnit.Case, async: true

  alias SynieCore.Resources.Hello

  test "say_hello returns a greeting for the given name" do
    result =
      Hello
      |> Ash.ActionInput.for_action(:say_hello, %{name: "world"})
      |> Ash.run_action!()

    assert result == "Hello, world"
  end

  test "say_hello rejects missing name argument" do
    assert_raise Ash.Error.Invalid, ~r/name/, fn ->
      Hello
      |> Ash.ActionInput.for_action(:say_hello, %{})
      |> Ash.run_action!()
    end
  end
end
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `~/code/synie/backend`:
```bash
mix test apps/synie_core/test/synie_core/resources/hello_test.exs
```
Expected: FAIL — `Ash.ActionInput.for_action/3` raises because action `:say_hello` is not defined on `Hello` (current stub only has `defaults [:read]`).

- [ ] **Step 3: Implement the Hello resource with the generic action**

Write `backend/apps/synie_core/lib/synie_core/resources/hello.ex`:
```elixir
defmodule SynieCore.Resources.Hello do
  use Ash.Resource,
    domain: SynieCore,
    extensions: [AshGraphql.Resource]

  graphql do
    type :hello

    queries do
      action :say_hello, :say_hello
    end
  end

  actions do
    defaults [:read]

    action :say_hello, :string do
      argument :name, :string, allow_nil?: false

      run fn input, _ ->
        {:ok, "Hello, #{input.arguments.name}"}
      end
    end
  end

  attributes do
    uuid_primary_key :id
  end
end
```
Note: the resource still needs a primary key to satisfy Ash's resource invariants even though `say_hello` never persists. `:read` action exists for AshGraphql type generation; it won't be exposed as a query unless we declare it in `queries`.

- [ ] **Step 4: Add AshGraphql.Domain extension to the domain**

Write `backend/apps/synie_core/lib/synie_core.ex`:
```elixir
defmodule SynieCore do
  use Ash.Domain,
    extensions: [AshGraphql.Domain]

  graphql do
  end

  resources do
    resource SynieCore.Resources.Hello
  end
end
```

- [ ] **Step 5: Run the test to verify it passes**

Run from `~/code/synie/backend`:
```bash
mix test apps/synie_core/test/synie_core/resources/hello_test.exs
```
Expected: PASS, both tests green.

- [ ] **Step 6: Smoke-test the GraphQL endpoint and confirm the query field name**

Start the backend:
```bash
cd ~/code/synie/backend
mix phx.server
```
(If `mix phx.server` is unavailable because we did not run the Phoenix generator, use `mix run --no-halt` after ensuring `SynieWeb.Endpoint` is in the supervision tree of `synie_web` — it is, via Task 3 Step 6.)

In another terminal, POST to the endpoint to introspect the schema and find the exact `hello` query field name:
```bash
curl -s -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __schema { queryType { fields { name args { name } } } } }"}'
```
Expected: JSON listing the `sayHello` (or `say_hello`) field with an argument `name`. Record the exact field name and argument casing — Task 7's frontend query MUST match it exactly. If ash_graphql produced `sayHello`, use camelCase in the frontend; if `say_hello`, use snake_case.

Then run the query itself to confirm it returns the greeting:
```bash
curl -s -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ sayHello(name: \"world\") }"}'
```
(Adjust field name/casing to what introspection showed.) Expected: `{"data":{"sayHello":"Hello, world"}}`.

- [ ] **Step 7: Commit**

```bash
cd ~/code/synie
git add backend
git commit -m "feat(backend): add Hello generic action exposed as GraphQL sayHello query"
```

---

### Task 5: Scaffold the TanStack Start frontend in web/

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`
- Create: `web/app/router.tsx`, `web/app/routes/__root.tsx`, `web/app/routes/index.tsx`

**Interfaces:**
- Produces: a bootable TanStack Start dev server at `http://localhost:3000` rendering an index route.

- [ ] **Step 1: Initialize the web project**

Run from `~/code/synie`:
```bash
mkdir -p web/app/routes web/app/lib
cd web
bun init -y
```
This creates a baseline `package.json`. We will overwrite it in Step 2.

- [ ] **Step 2: Write package.json with all dependencies**

Write `web/package.json`:
```json
{
  "name": "synie-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "codegen": "graphql-codegen"
  },
  "dependencies": {
    "@tanstack/react-start": "^1.0.0",
    "@tanstack/react-router": "^1.0.0",
    "@tanstack/react-query": "^5.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "graphql": "^16.9.0",
    "@heroui/react": "^2.8.0",
    "framer-motion": "^11.9.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.5.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/node": "^22.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/postcss": "^4.0.0",
    "postcss": "^8.4.0",
    "@graphql-codegen/cli": "^5.0.0",
    "@graphql-codegen/client-preset": "^4.5.0"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run from `~/code/synie/web`:
```bash
bun install
```
Expected: lockfile created, no fatal peer conflicts. (If `@tanstack/react-start` cannot resolve, fall back to the documented CLI scaffold: `bunx @tanstack/cli create --start web-tmp` then copy its `package.json`/`vite.config.ts` into `web/` and re-run `bun install`.)

- [ ] **Step 4: Write tsconfig.json**

Write `web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "moduleResolution": "Bundler",
    "module": "ESNext",
    "target": "ES2022",
    "skipLibCheck": true,
    "strictNullChecks": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "~/*": ["./app/*"]
    }
  },
  "include": ["app", "vite.config.ts"]
}
```

- [ ] **Step 5: Write vite.config.ts with graphql proxy**

Write `web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/graphql': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
    }
  },
  resolve: {
    tsconfigPaths: true
  },
  plugins: [
    tanstackStart(),
    viteReact()
  ]
})
```

- [ ] **Step 6: Write the router and root route**

Write `web/app/router.tsx`:
```tsx
import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
  })
}
```

Write `web/app/routes/__root.tsx`:
```tsx
import type { ReactNode } from 'react'
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Synie' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
```

- [ ] **Step 7: Write a placeholder index route**

Write `web/app/routes/index.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: HomeComponent,
})

function HomeComponent() {
  return <div>Synie — loading GraphQL&hellip;</div>
}
```

- [ ] **Step 8: Smoke-test the dev server**

Run from `~/code/synie/web`:
```bash
bun dev
```
Expected: Vite starts on `:3000`, generates `app/routeTree.gen.ts`, and `http://localhost:3000/` renders "Synie — loading GraphQL…". Stop it with Ctrl-C after confirming.

- [ ] **Step 9: Commit**

```bash
cd ~/code/synie
git add web
git commit -m "feat(web): scaffold TanStack Start frontend with Vite proxy to /graphql"
```

---

### Task 6: Integrate HeroUI + Tailwind v4 + GraphQL client

**Files:**
- Create: `web/postcss.config.js`, `web/app.css`
- Modify: `web/app/routes/__root.tsx` (HeroUIProvider + QueryClientProvider + app.css import)
- Create: `web/app/lib/graphql.ts`

**Interfaces:**
- Produces: `gqlFetch(query, variables)` — typed-ish fetch wrapper hitting `/graphql`; HeroUIProvider + QueryClientProvider mounted at the root.

- [ ] **Step 1: Write postcss.config.js for Tailwind v4**

Write `web/postcss.config.js`:
```js
export default {
  plugins: {
    '@tailwindcss/postcss': {}
  }
}
```

- [ ] **Step 2: Write app.css with Tailwind v4 + HeroUI theme**

Write `web/app.css`:
```css
@import "tailwindcss";
@import "./hero.ts";
```

Create `web/hero.ts`:
```ts
import { heroui } from "@heroui/react"

export const plugins = [heroui()]
```
Note: HeroUI v2.8+ ships a Tailwind v4 plugin helper. If the exact import path differs (`@heroui/react` exports may vary), inspect `node_modules/@heroui/react` for the exported `heroui` function; if unavailable, fall back to the CSS-first directive by replacing `app.css` with:
```css
@import "tailwindcss";
@plugin "@heroui/react";
```
and deleting `hero.ts`.

- [ ] **Step 3: Write the GraphQL fetch client**

Write `web/app/lib/graphql.ts`:
```ts
export async function gqlFetch<TData = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<TData> {
  const res = await fetch('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`)
  }

  const json = await res.json() as { data?: TData; errors?: Array<{ message: string }> }

  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors.map((e) => e.message).join('; '))
  }

  if (!json.data) {
    throw new Error('GraphQL response had no data')
  }

  return json.data
}
```

- [ ] **Step 4: Mount HeroUIProvider + QueryClientProvider at the root**

Rewrite `web/app/routes/__root.tsx`:
```tsx
import type { ReactNode } from 'react'
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import { HeroUIProvider } from '@heroui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../app.css'

const queryClient = new QueryClient()

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Synie' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <HeroUIProvider>
          <Outlet />
        </HeroUIProvider>
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
```

- [ ] **Step 5: Smoke-test the providers render**

Run from `~/code/synie/web`:
```bash
bun dev
```
Expected: `:3000` loads without console errors about missing `HeroUIProvider` or `QueryClientProvider`. Stop with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
cd ~/code/synie
git add web
git commit -m "feat(web): integrate HeroUI, Tailwind v4, and GraphQL fetch client"
```

---

### Task 7: Wire the index route to query the backend hello endpoint end-to-end

**Files:**
- Modify: `web/app/routes/index.tsx`
- Verify: backend `mix phx.server` running on `:4000`

**Interfaces:**
- Consumes: `gqlFetch` from `~/lib/graphql`, the exact GraphQL field name recorded in Task 4 Step 6 (camelCase `sayHello` by default — adjust if introspection showed otherwise).

- [ ] **Step 1: Confirm the backend is running**

In a terminal:
```bash
cd ~/code/synie/backend
mix phx.server
```
Expected: endpoint listening on `:4000`. Keep it running.

- [ ] **Step 2: Rewrite the index route to call the hello query**

Write `web/app/routes/index.tsx` (uses the field name confirmed in Task 4 Step 6; below assumes `sayHello`):
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Card, CardBody, CardHeader, Spinner } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'

const HELLO_QUERY = `
  query SayHello($name: String!) {
    sayHello(name: $name)
  }
`

export const Route = createFileRoute('/')({
  component: HomeComponent,
})

function HomeComponent() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['hello', 'world'],
    queryFn: () =>
      gqlFetch<{ sayHello: string }>(HELLO_QUERY, { name: 'world' }),
  })

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <Card className="max-w-md w-full">
        <CardHeader className="text-xl font-semibold">Synie</CardHeader>
        <CardBody>
          {isLoading ? (
            <Spinner label="Loading…" />
          ) : error ? (
            <div className="text-danger">
              Error: {error instanceof Error ? error.message : String(error)}
            </div>
          ) : (
            <div>{data?.sayHello}</div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Run the frontend and verify end-to-end**

From `~/code/synie/web`:
```bash
bun dev
```
Open `http://localhost:3000/`. Expected: a HeroUI card renders, briefly shows a spinner, then displays the text `Hello, world` (the value returned by the backend `sayHello(name: "world")` query). The browser Network tab should show a `POST /graphql` request proxied to `:4000` returning 200 with `{"data":{"sayHello":"Hello, world"}}`.

If the card shows an error, check:
- Backend is running on `:4000`.
- The GraphQL field name in `HELLO_QUERY` matches what Task 4 Step 6 introspection returned.
- Vite proxy logs in the `bun dev` terminal.

- [ ] **Step 4: Commit**

```bash
cd ~/code/synie
git add web
git commit -m "feat(web): wire index route to backend sayHello GraphQL query"
```

---

### Task 8: Set up GraphQL codegen for typed operations

**Files:**
- Create: `web/codegen.ts`
- Create: `web/app/graphql/operations.ts` (codegen source — handwritten document with the `SayHello` query)
- Generated: `web/app/graphql/graphql.ts`, `web/app/graphql/gql.ts`, `web/app/graphql/index.ts` (by codegen)

**Interfaces:**
- Produces: a `codegen` script that pulls the schema from `http://localhost:4000/graphql` and emits typed TypeScript for the `SayHello` operation.

- [ ] **Step 1: Write codegen.ts**

Write `web/codegen.ts`:
```ts
import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: 'http://localhost:4000/graphql',
  documents: ['app/graphql/**/*.ts'],
  generates: {
    'app/graphql/': {
      preset: 'client',
      presetConfig: {
        gqlScalarType: 'string'
      }
    }
  },
  ignoreConfig: true
}

export default config
```

- [ ] **Step 2: Write the operations document**

Write `web/app/graphql/operations.ts`:
```ts
import { graphql } from './gql'

export const SayHelloDocument = graphql(`
  query SayHello($name: String!) {
    sayHello(name: $name)
  }
`)
```
(This references the codegen-generated `graphql` tag — it will not compile until Step 3 runs.)

- [ ] **Step 3: Run codegen (backend must be running)**

Ensure backend is up on `:4000` (Task 7 Step 1), then from `~/code/synie/web`:
```bash
bun run codegen
```
Expected: writes `app/graphql/gql.ts`, `app/graphql/graphql.ts`, `app/graphql/index.ts`. No errors. If the schema fetch fails, confirm backend is reachable at `http://localhost:4000/graphql`.

- [ ] **Step 4: Verify the generated types compile**

From `~/code/synie/web`:
```bash
bunx tsc --noEmit
```
Expected: no type errors. If `SayHelloDocument` has a type error, ensure the field name `sayHello` matches the backend schema exactly.

- [ ] **Step 5: Commit**

```bash
cd ~/code/synie
git add web/codegen.ts web/app/graphql web/package.json
git commit -m "feat(web): set up graphql-codegen for typed SayHello operation"
```

---

### Task 9: End-to-end verification

**Files:** none modified — verification only.

- [ ] **Step 1: Backend clean compile + tests**

Run from `~/code/synie/backend`:
```bash
mix deps.get
mix compile
mix test
```
Expected: compiles; `SynieCore.Resources.HelloTest` (2 tests) passes.

- [ ] **Step 2: Backend serves GraphQL**

From `~/code/synie/backend`:
```bash
mix phx.server
```
In another terminal:
```bash
curl -s -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ sayHello(name: \"world\") }"}'
```
Expected: `{"data":{"sayHello":"Hello, world"}}`.

- [ ] **Step 3: GraphiQL playground reachable**

Open `http://localhost:4000/graphql/playground` in a browser. Expected: Absinthe GraphiQL playground loads with the schema introspected and `sayHello` available in the docs.

- [ ] **Step 4: Frontend clean typecheck + dev server**

From `~/code/synie/web`:
```bash
bunx tsc --noEmit
bun dev
```
Expected: tsc passes; Vite starts on `:3000`.

- [ ] **Step 5: Frontend end-to-end**

Open `http://localhost:3000/`. Expected: HeroUI card renders, briefly shows a spinner, then displays `Hello, world`. Network tab shows `POST /graphql` → 200 with the data payload.

- [ ] **Step 6: Codegen reproducible**

From `~/code/synie/web` (backend still running):
```bash
bun run codegen
bunx tsc --noEmit
```
Expected: codegen completes; tsc passes; no diff in generated files (re-running produces identical output).

- [ ] **Step 7: Final commit (verification notes if any)**

If everything passed with no changes, no commit needed. If any config tweaks were made during verification, commit them:
```bash
cd ~/code/synie
git add -A
git commit -m "chore: verification fixes"
```

---

## Verification Checklist (maps to spec acceptance criteria)

- [x] Task 1 → `backend/` umbrella `mix deps.get` + `mix compile` passes (spec §8.1)
- [x] Task 4 Step 6 + Task 9 Step 2 → `POST /graphql` returns `"Hello, world"` (spec §8.2)
- [x] Task 9 Step 3 → `/graphql/playground` loads GraphiQL (spec §8.2)
- [x] Task 5 Step 8 + Task 9 Step 4 → `web/` `bun install` + `bun dev` boots (spec §8.3)
- [x] Task 7 Step 3 + Task 9 Step 5 → frontend homepage renders the `sayHello` result (spec §8.4)
- [x] Task 8 Step 3 + Task 9 Step 6 → `bun run codegen` generates types (spec §8.5)
- [x] Task 2 + Task 3 → Ash Authentication + Ash Postgres deps installed, Repo configured (spec §8.6)

## Notes for the implementer

- **igniter non-determinism:** `mix igniter.install` is interactive and may prompt for which app to target. Run from `backend/` for umbrella-wide, or from `backend/apps/synie_core` / `backend/apps/synie_web` to pin a target. If it refuses, fall back to manual deps in `mix.exs` + the config in the task steps — the igniter installer's value is convenience, not correctness; the manual steps in this plan are the source of truth.
- **Ash Authentication install not fully wired:** Per spec §2/§7, we install `ash_authentication` + `ash_authentication_phoenix` deps but do NOT run the strategy setup or define a User/Token resource. If the user later wants auth, run `mix igniter.install ash_authentication_phoenix --auth-strategy password` and follow the ash_authentication get-started guide. The plan intentionally stops at "deps installed, Repo configured" to keep skeleton scope tight.
- **HeroUI Tailwind v4 plugin path:** HeroUI v2.8 added Tailwind v4 support. The exact plugin export (`heroui()` from `@heroui/react`) may differ by patch version; Task 6 Step 2 includes a fallback `@plugin "@heroui/react"` directive if the function export is absent. Verify by inspecting `node_modules/@heroui/react/package.json` exports.
- **GraphQL field casing:** ash_graphql camelizes field names by default (`say_hello` action → `sayHello` query field). Task 4 Step 6 verifies the exact name via introspection; Task 7 uses that exact name. Do not assume — verify.
- **`mix phx.server` availability:** We scaffolded `synie_web` with `mix new --sup`, not `mix phx.new`. `mix phx.server` still works because `SynieWeb.Endpoint` is in the supervision tree and `phoenix` is a dep, but if it complains, use `mix run --no-halt`.