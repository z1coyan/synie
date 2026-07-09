import Config

config :synie_core, SynieCore.Repo, SynieCore.Config.repo_config(config_env())

# 文件存储:默认本地磁盘;接 S3/OSS 时新增一个配置名并实现对应 adapter
config :synie_core, :default_storage, :local

config :synie_core, :storages,
  local: %{
    adapter: SynieCore.Storage.Local,
    root: System.get_env("UPLOADS_ROOT") || Path.expand("uploads")
  }

if config_env() == :prod do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE is missing"

  config :synie_web, SynieWeb.Endpoint,
    server: true,
    secret_key_base: secret_key_base,
    url: [host: System.get_env("PHX_HOST") || "localhost", port: 80]
end
