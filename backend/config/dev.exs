import Config

# Development-specific configuration.
# Database connection and runtime secrets are read from environment
# variables in config/runtime.exs.

config :synie_web, SynieWeb.Endpoint,
  # PORT 环境变量可覆盖,供 worktree 并行起服务时避开主 checkout 的 4000
  http: [ip: {0, 0, 0, 0}, port: String.to_integer(System.get_env("PORT") || "4000")],
  secret_key_base: "synie_dev_secret_key_base_for_development_only_not_for_prod",
  server: true,
  code_reloader: true,
  debug_errors: true

# dev 打开 GraphiQL playground(/graphql/playground)
config :synie_web, graphiql_enabled: true

# 本地 synie-pg 容器仍是 postgres:16(docker-compose.yml 已声明 postgres:17,容器待升级),
# 而 SynieCore.Repo.min_pg_version 按生产目标声明 17;AshPostgres 按声明版本(不探测实际服务端)
# 选择 MERGE 语句做 upsert,PG16 不支持 MERGE...RETURNING 会报语法错误,故本地关闭该优化路径,
# 回退到 ON CONFLICT 实现(行为一致)。容器升级到 17 后可删除本行。
config :ash_postgres, upsert_with_merge?: false
