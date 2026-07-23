import Config

config :synie_core, SynieCore.Repo, SynieCore.Config.repo_config(config_env())

if config_env() == :prod do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE is missing"

  config :synie_web, SynieWeb.Endpoint,
    server: true,
    # 容器内监听所有网卡;PORT 供反向代理/compose 映射对齐
    http: [ip: {0, 0, 0, 0}, port: String.to_integer(System.get_env("PORT") || "4000")],
    secret_key_base: secret_key_base,
    url: [host: System.get_env("PHX_HOST") || "localhost", port: 80]

  # 打印 PDF:可用 SOFFICE_PATH 覆盖(Docker 镜像默认 PATH 上有 soffice)
  if path = System.get_env("SOFFICE_PATH") do
    config :synie_core, soffice_path: path
  end
end
