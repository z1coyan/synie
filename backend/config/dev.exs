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
