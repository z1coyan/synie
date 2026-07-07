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
