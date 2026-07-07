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
