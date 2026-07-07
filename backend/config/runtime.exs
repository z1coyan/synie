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