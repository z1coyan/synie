defmodule Mix.Tasks.Synie.Db.Reset do
  @shortdoc "Dev/test: 断开连接 → 删库 → 建库 → 迁移"

  @moduledoc """
  开发/测试环境一键重置数据库。

      cd backend
      mix synie.db.reset

  步骤:

  1. 加载 `backend/.env`(及 `.env.dev`/`.env.test` 覆盖层;由 config 自动完成)
  2. 终止占用目标库的其它会话(避免 `database is being accessed by other users`)
  3. `ecto.drop` → `ecto.create` → `ecto.migrate`

  迁移后空库即可启动应用,打开浏览器走初始化向导;无需再跑 `seeds.exs`。

  **仅允许** `MIX_ENV=dev` 或 `test`。生产环境直接拒绝。
  """

  use Mix.Task

  @impl Mix.Task
  def run(_args) do
    unless Mix.env() in [:dev, :test] do
      Mix.raise("synie.db.reset 仅允许在 MIX_ENV=dev|test 下运行,当前: #{Mix.env()}")
    end

    # app.config 会跑 config.exs → 自动 load .env
    Mix.Task.run("app.config")

    config = SynieCore.Repo.config()
    database = Keyword.fetch!(config, :database)

    Mix.shell().info([:yellow, "* 重置数据库 ", :reset, database, " (#{Mix.env()})"])

    {:ok, _} = Application.ensure_all_started(:ssl)
    {:ok, _} = Application.ensure_all_started(:postgrex)

    terminate_other_sessions!(config, database)

    # --force: 跳过交互确认(任务名本身已表明破坏性)
    Mix.Task.run("ecto.drop", ["-r", "SynieCore.Repo", "--force", "--quiet"])
    Mix.Task.run("ecto.create", ["-r", "SynieCore.Repo", "--quiet"])
    Mix.Task.run("ecto.migrate", ["-r", "SynieCore.Repo"])

    Mix.shell().info([
      :green,
      "* 完成。",
      :reset,
      " 启动服务后打开应用进入初始化向导即可。"
    ])
  end

  # 连到 maintenance 库(postgres),踢掉占用目标库的会话
  defp terminate_other_sessions!(config, database) do
    opts =
      config
      |> Keyword.take([:username, :password, :hostname, :port, :ssl, :socket_options])
      |> Keyword.put(:database, "postgres")
      |> Keyword.put(:pool_size, 1)
      |> Keyword.put(:backoff_type, :stop)

    {:ok, conn} = Postgrex.start_link(opts)

    %{num_rows: n} =
      Postgrex.query!(
        conn,
        """
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()
        """,
        [database]
      )

    GenServer.stop(conn)

    if n > 0 do
      Mix.shell().info("  已断开 #{n} 个占用会话")
    end
  rescue
    e ->
      Mix.shell().info([
        :yellow,
        "  跳过断开会话(#{Exception.message(e)});若 drop 失败请先停掉 phx.server"
      ])
  end
end
