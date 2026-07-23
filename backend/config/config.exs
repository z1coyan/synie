import Config

# 非生产:自动加载 backend/.env 与 backend/.env.<env>(后者覆盖前者)。
# 进程已有环境变量优先(shell / CI / IDE 注入不被覆盖)。
# prod 不读文件,密钥只来自真实环境变量。
if config_env() in [:dev, :test] do
  Code.require_file("dotenv.exs", __DIR__)

  SynieDotenv.load!([
    Path.expand("../.env", __DIR__),
    Path.expand("../.env.#{config_env()}", __DIR__)
  ])
end

config :synie_core,
  ash_domains: [SynieCore],
  ecto_repos: [SynieCore.Repo]

# 银行流水导入:文件里的本地时间按该偏移转 UTC(默认 UTC+8,国内无夏令时)
config :synie_core, bank_import_utc_offset_minutes: 480
config :synie_core, attendance_import_utc_offset_minutes: 480

# 打印 PDF 转换:LibreOffice soffice 路径与超时(可用 SOFFICE_PATH 环境变量覆盖路径)
config :synie_core, soffice_path: System.get_env("SOFFICE_PATH") || "soffice"
config :synie_core, soffice_timeout_ms: 120_000

# 行情拉取:进程内 GenServer 调度(测试关闭);HTTP 客户端可用 req_options 注入桩
config :synie_core, market_fetch_scheduler: true

config :synie_web,
  namespace: SynieWeb

# GraphiQL playground 默认关闭(生产不暴露交互式查询控制台);仅 dev 打开
config :synie_web, graphiql_enabled: false

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

# ExAws 默认使用 hackney；改用项目已有的 Req，避免引入存在安全漏洞的 hackney 1.x。
config :ex_aws, http_client: ExAws.Request.Req

import_config "#{config_env()}.exs"
